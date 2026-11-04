import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { permissionFlag } from "./node-permission.js";

const HARNESS = fileURLToPath(new URL("./runtime/harness.mjs", import.meta.url));
const HARNESS_PY = fileURLToPath(new URL("./runtime/harness.py", import.meta.url));
const MAX_OUTPUT = 1_000_000;
const ENV_KEEP = ["PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];

export async function executeTool(options) {
  const runtime = options.runtime ?? "node";
  const engine = runtime === "python" ? "python-audit" : "node-permission";
  const entry = realpathAllow(options.entry);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (runtime === "node" && options.allowNet?.length && nodeMajor < 25) {
    throw new Error("--allow-net 需要 Node >= 25（Node 24 的权限模型不限制网络）");
  }

  let tempDir = null;
  let inputPath = options.inputPath ? realpathAllow(options.inputPath) : null;
  if (!inputPath) {
    tempDir = await mkdtemp(join(tmpdir(), "mf-exec-"));
    inputPath = join(tempDir, "input.json");
    await writeFile(inputPath, options.inputJson ?? "{}", "utf8");
    inputPath = realpathAllow(inputPath);
  }

  try {
    let args;
    let command;
    let resultPath = null;
    if (runtime === "python") {
      tempDir = tempDir ?? (await mkdtemp(join(tmpdir(), "mf-exec-")));
      resultPath = join(tempDir, "result.json");
      args = [
        HARNESS_PY,
        "--entry",
        entry,
        "--input",
        inputPath,
        "--export",
        options.exportName ?? "run",
        "--result",
        resultPath
      ];
      for (const path of options.allowRead ?? []) args.push("--allow-read", resolve(path));
      for (const path of options.allowWrite ?? []) args.push("--allow-write", resolve(path));
      for (const host of options.allowNet ?? []) args.push("--allow-net", host);
      if (options.warmup) args.push("--warmup", String(options.warmup));
      command = options.python ?? "python";
    } else {
      const readPaths = [
        dirname(HARNESS),
        dirname(entry),
        dirname(inputPath),
        process.cwd(),
        ...(options.allowRead ?? [])
      ].map((path) => realpathAllow(path));
      args = [permissionFlag()];
      for (const path of dedupe(readPaths)) args.push(`--allow-fs-read=${path}`);
      if (options.allowWrite?.length) {
        for (const path of dedupe(options.allowWrite.map((item) => realpathAllow(item)))) {
          args.push(`--allow-fs-write=${path}`);
        }
      }
      if (options.allowNet?.length) {
        for (const host of options.allowNet) args.push(`--allow-net=${host}`);
      }
      args.push(HARNESS, "--entry", entry, "--input", inputPath, "--export", options.exportName ?? "run");
      if (options.warmup) args.push("--warmup", String(options.warmup));
      command = process.execPath;
    }

    const env = buildEnv(options.passEnv);
    if (runtime === "python") {
      env.PYTHONDONTWRITEBYTECODE = "1";
      env.PYTHONIOENCODING = "utf-8";
    }

    const started = performance.now();
    const run = await spawnHarness(command, args, env, options.timeoutMs ?? 10_000);
    const wallMs = Math.round(performance.now() - started);

    let report = null;
    if (resultPath) {
      try {
        report = JSON.parse(await readFile(resultPath, "utf8"));
      } catch {
        report = null;
      }
    }
    if (!report) {
      try {
        report = JSON.parse(run.payload.trim());
      } catch {
        const sentinel = run.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("__MF_RESULT__"))
          .pop();
        if (sentinel) {
          try {
            report = JSON.parse(sentinel.slice("__MF_RESULT__".length));
          } catch {
            report = null;
          }
        }
      }
    }

    const permissionDenied =
      report?.permissionDenied === true ||
      report?.error?.code === "ERR_ACCESS_DENIED" ||
      report?.error?.code === "MF_PERMISSION_DENIED" ||
      /ERR_ACCESS_DENIED/.test(run.stderr);
    const timedOut = run.timedOut;
    const ok = Boolean(report?.ok) && run.exitCode === 0 && !timedOut;

    const result = {
      ok,
      timedOut,
      permissionDenied,
      engine,
      exitCode: run.exitCode,
      signal: run.signal,
      wallMs,
      stdout: run.stdout.slice(-4000),
      stderr: run.stderr.slice(-4000),
      result: report?.result ?? null,
      error:
        report?.error ??
        (report ? null : { name: "HarnessError", code: "NO_REPORT", message: "harness 没有返回结果" }),
      metrics: report?.metrics ?? null
    };

    return {
      result,
      code: timedOut ? 4 : permissionDenied ? 3 : ok ? 0 : 1
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}

export async function runExec(options, io = console) {
  const { result, code } = await executeTool(options);
  io.log(
    options.json
      ? JSON.stringify(result, null, 2)
      : formatExec(resolve(options.entry), result)
  );
  return code;
}

function spawnHarness(command, args, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let payload = "";
    let settled = false;
    let timedOut = false;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolvePromise({ exitCode, signal, timedOut, stdout, stderr, payload });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      finish(null, "SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.stdio[3].on("data", (chunk) => {
      if (payload.length < MAX_OUTPUT) payload += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      stderr += `\nspawn error: ${error.message}`;
      finish(null, null);
    });
    child.on("exit", (code, signal) => finish(code, signal));
  });
}

function buildEnv(passEnv = []) {
  const env = {};
  for (const key of ENV_KEEP) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of passEnv) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function dedupe(paths) {
  return [...new Set(paths)];
}

function formatExec(entry, result) {
  const lines = [`exec: ${entry}`];
  const status = result.timedOut
    ? "timed out"
    : result.permissionDenied
      ? "permission denied"
      : result.ok
        ? "ok"
        : "failed";
  lines.push(`  status:     ${status}`);
  if (result.engine) lines.push(`  engine:     ${result.engine}（能力限制，不是安全边界）`);
  lines.push(`  wall:       ${result.wallMs}ms`);
  if (result.metrics) {
    const m = result.metrics;
    lines.push(`  duration:   ${m.durationMs}ms（import ${m.importMs}ms）`);
    if (m.cpuUserMs !== undefined) {
      lines.push(`  cpu:        user ${m.cpuUserMs}ms / sys ${m.cpuSystemMs}ms`);
      lines.push(`  memory:     peak ${m.peakRssMB}MB（start ${m.startRssMB}MB），heap Δ ${m.heapUsedDeltaMB}MB`);
      lines.push(`  fs:         read ${m.fsReadDelta} / write ${m.fsWriteDelta}`);
    } else {
      lines.push(`  cpu:        ${m.cpuMs ?? "n/a"}ms`);
      lines.push(
        `  memory:     peak ${m.peakRssMB ?? "n/a"}MB（start ${m.startRssMB ?? "n/a"}MB），heap peak ${m.heapPeakMB ?? "n/a"}MB`
      );
    }
  }
  if (result.error) {
    const error = result.error;
    lines.push(
      `  error:      ${error.name ?? "Error"}${error.code ? ` (${error.code})` : ""}: ${error.message ?? ""}`
    );
    if (error.stack) {
      const frames = String(error.stack)
        .split("\n")
        .slice(1, 4)
        .map((line) => `              ${line.trim()}`);
      lines.push(...frames);
    }
  }
  if (result.ok) {
    const text = JSON.stringify(result.result);
    lines.push(`  result:     ${text.length > 800 ? `${text.slice(0, 800)}…` : text}`);
  }
  if (result.timedOut) lines.push("  note:       已按超时终止进程");
  if (result.permissionDenied) lines.push("  note:       权限模型拒绝了文件/网络访问，可用于推断沙箱需求");
  return lines.join("\n");
}

// Node's permission model matches real paths. On macOS /var is a symlink to
// /private/var, so an unresolved tmpdir path in --allow-fs-read is rejected.
function realpathAllow(path) {
  const abs = resolve(path);
  try {
    return realpathSync.native ? realpathSync.native(abs) : realpathSync(abs);
  } catch {
    return abs;
  }
}
