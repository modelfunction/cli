import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec } from "../lib/exec.js";

const probe = spawnSync("python", ["--version"], { encoding: "utf8" });
const HAS_PYTHON = probe.status === 0;
const skip = HAS_PYTHON ? false : "python not available";

function capture() {
  const lines = [];
  return { io: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) }, lines };
}

async function makeTool(root, body) {
  const entry = join(root, "tool.py");
  await writeFile(entry, body, "utf8");
  return entry;
}

function pythonOptions(entry, extra = {}) {
  return {
    entry,
    runtime: "python",
    python: "python",
    inputJson: "{}",
    json: true,
    // Generous: under the full suite Node runs test files in parallel and a
    // cold Python start on Windows (with AV scanning) can take >15s.
    timeoutMs: 60_000,
    ...extra
  };
}

test("python exec runs a tool and reports metrics", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-py-"));
  try {
    const entry = await makeTool(
      root,
      'def run(payload):\n    return {"echo": payload["msg"], "size": len("x" * 2000)}\n'
    );
    const { io, lines } = capture();
    const code = await runExec(pythonOptions(entry, { inputJson: JSON.stringify({ msg: "hi" }) }), io);
    assert.equal(code, 0);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, true);
    assert.equal(payload.engine, "python-audit");
    assert.equal(payload.result.echo, "hi");
    assert.ok(payload.metrics.durationMs >= 0);
    assert.ok(payload.metrics.importMs >= 0);
    assert.ok(payload.metrics.cpuMs >= 0);
    assert.equal(payload.permissionDenied, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("python exec reports exceptions with traceback", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-py-"));
  try {
    const entry = await makeTool(root, 'def run(payload):\n    raise ValueError("boom")\n');
    const { io, lines } = capture();
    const code = await runExec(pythonOptions(entry), io);
    assert.equal(code, 1);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.name, "ValueError");
    assert.match(payload.error.traceback, /boom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("python exec blocks reads outside the allow list", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-py-"));
  const secretRoot = await mkdtemp(join(tmpdir(), "mf-py-secret-"));
  try {
    const secretPath = join(secretRoot, "secret.txt").replace(/\\/g, "/");
    await writeFile(join(secretRoot, "secret.txt"), "top-secret", "utf8");
    const entry = await makeTool(
      root,
      `def run(payload):\n    with open("${secretPath}", "r", encoding="utf-8") as handle:\n        return handle.read()\n`
    );
    const { io, lines } = capture();
    const code = await runExec(pythonOptions(entry), io);
    assert.equal(code, 3);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, false);
    assert.equal(payload.permissionDenied, true);
    assert.match(payload.error.message, /mf-blocked/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(secretRoot, { recursive: true, force: true });
  }
});

test("python exec kills tools that exceed the timeout", { skip }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-py-"));
  try {
    const entry = await makeTool(
      root,
      "import time\n\ndef run(payload):\n    time.sleep(3)\n    return 'late'\n"
    );
    const { io, lines } = capture();
    const code = await runExec(pythonOptions(entry, { timeoutMs: 500 }), io);
    assert.equal(code, 4);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.timedOut, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
