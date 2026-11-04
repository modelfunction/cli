import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const parsed = { entry: null, input: null, exportName: "run", warmup: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--entry") parsed.entry = next();
    else if (arg === "--input") parsed.input = next();
    else if (arg === "--export") parsed.exportName = next();
    else if (arg === "--warmup") parsed.warmup = Number(next()) || 0;
  }
  return parsed;
}

function emit(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  try {
    writeSync(3, line);
  } catch {
    process.stdout.write(line);
  }
}

function metrics({ durationMs, importMs, ruBefore, muBefore, peakRss, startRss }) {
  const ru = process.resourceUsage();
  const mu = process.memoryUsage();
  return {
    durationMs: Math.round(durationMs * 100) / 100,
    importMs: Math.round(importMs * 100) / 100,
    cpuUserMs: Math.round((ru.userCPUTime - ruBefore.userCPUTime) / 1000),
    cpuSystemMs: Math.round((ru.systemCPUTime - ruBefore.systemCPUTime) / 1000),
    fsReadDelta: ru.fsRead - ruBefore.fsRead,
    fsWriteDelta: ru.fsWrite - ruBefore.fsWrite,
    startRssMB: Math.round((startRss / 1048576) * 10) / 10,
    peakRssMB: Math.round((Math.max(peakRss, mu.rss) / 1048576) * 10) / 10,
    heapUsedDeltaMB: Math.round(((mu.heapUsed - muBefore.heapUsed) / 1048576) * 100) / 100
  };
}

if (!args.entry || !args.input) {
  emit({ ok: false, error: { name: "HarnessError", code: "BAD_ARGS", message: "--entry and --input are required" } });
  process.exit(2);
}

const startRss = process.memoryUsage().rss;
const importStarted = performance.now();
let fn;
try {
  const moduleUrl = pathToFileURL(args.entry).href;
  const mod = await import(moduleUrl);
  const candidate = mod[args.exportName] ?? mod.default ?? mod.run;
  if (typeof candidate !== "function") {
    emit({
      ok: false,
      error: {
        name: "HarnessError",
        code: "EXPORT_NOT_FOUND",
        message: `${args.entry} 需要导出 ${args.exportName}、default 或 run 函数`
      },
      metrics: { importMs: Math.round((performance.now() - importStarted) * 100) / 100 }
    });
    process.exit(2);
  }
  fn = candidate;
} catch (error) {
  emit({
    ok: false,
    error: { name: error?.name, code: error?.code, message: error?.message, phase: "import" },
    metrics: { importMs: Math.round((performance.now() - importStarted) * 100) / 100 }
  });
  process.exit(1);
}
const importMs = performance.now() - importStarted;

let input;
try {
  input = JSON.parse(readFileSync(args.input, "utf8"));
} catch (error) {
  emit({
    ok: false,
    error: { name: error?.name, code: error?.code, message: `input 读取失败: ${error?.message}`, phase: "input" },
    metrics: { importMs }
  });
  process.exit(2);
}

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
if (typeof sampler.unref === "function") sampler.unref();

try {
  for (let i = 0; i < args.warmup; i += 1) {
    await fn(input);
  }
} catch (error) {
  clearInterval(sampler);
  emit({
    ok: false,
    error: { name: error?.name, code: error?.code, message: error?.message, phase: "warmup" },
    metrics: { importMs, durationMs: 0, startRssMB: Math.round((startRss / 1048576) * 10) / 10 }
  });
  process.exit(1);
}

const ruBefore = process.resourceUsage();
const muBefore = process.memoryUsage();
const started = performance.now();

try {
  const result = await fn(input);
  const durationMs = performance.now() - started;
  clearInterval(sampler);
  emit({
    ok: true,
    result,
    metrics: metrics({ durationMs, importMs, ruBefore, muBefore, peakRss, startRss })
  });
  process.exit(0);
} catch (error) {
  const durationMs = performance.now() - started;
  clearInterval(sampler);
  emit({
    ok: false,
    error: {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      stack: String(error?.stack ?? "").split("\n").slice(0, 10).join("\n"),
      phase: "call"
    },
    metrics: metrics({ durationMs, importMs, ruBefore, muBefore, peakRss, startRss })
  });
  process.exit(1);
}
