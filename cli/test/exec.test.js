import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExec } from "../lib/exec.js";
import { permissionFlag } from "../lib/node-permission.js";

function capture() {
  const lines = [];
  return { io: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) }, lines };
}

async function makeTool(root, body) {
  const entry = join(root, "tool.mjs");
  await writeFile(entry, body, "utf8");
  return entry;
}

test("exec runs a node tool and reports metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-exec-"));
  try {
    const entry = await makeTool(
      root,
      "export async function run(input) { return { echo: input.msg, size: 'x'.repeat(2000).length }; }\n"
    );
    const { io, lines } = capture();
    const code = await runExec(
      { entry, inputJson: JSON.stringify({ msg: "hi" }), json: true, timeoutMs: 30_000 },
      io
    );
    assert.equal(code, 0);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, true);
    assert.equal(payload.engine, "node-permission");
    assert.equal(payload.result.echo, "hi");
    assert.ok(payload.metrics.durationMs >= 0);
    assert.ok(payload.metrics.peakRssMB > 0);
    assert.ok(payload.metrics.importMs >= 0);
    assert.equal(payload.permissionDenied, false);
    assert.equal(payload.timedOut, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exec reports tool errors with stack and exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-exec-"));
  try {
    const entry = await makeTool(root, "export async function run() { throw new Error('boom'); }\n");
    const { io, lines } = capture();
    const code = await runExec({ entry, inputJson: "{}", json: true, timeoutMs: 30_000 }, io);
    assert.equal(code, 1);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, false);
    assert.equal(payload.error.name, "Error");
    assert.equal(payload.error.message, "boom");
    assert.match(payload.error.stack, /boom/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exec marks permission denials from the node permission model", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-exec-"));
  const secretRoot = await mkdtemp(join(tmpdir(), "mf-secret-"));
  try {
    const secretPath = join(secretRoot, "secret.txt").replace(/\\/g, "\\\\");
    await writeFile(join(secretRoot, "secret.txt"), "top-secret", "utf8");
    const entry = await makeTool(
      root,
      `import { readFileSync } from "node:fs";\nexport async function run() { return readFileSync("${secretPath}", "utf8"); }\n`
    );
    const { io, lines } = capture();
    const code = await runExec({ entry, inputJson: "{}", json: true, timeoutMs: 30_000 }, io);
    assert.equal(code, 3);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.ok, false);
    assert.equal(payload.permissionDenied, true);
    assert.equal(payload.error.code, "ERR_ACCESS_DENIED");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(secretRoot, { recursive: true, force: true });
  }
});

test("permission flag follows the node version", () => {
  assert.equal(permissionFlag("20.11.1"), "--experimental-permission");
  assert.equal(permissionFlag("22.9.0"), "--experimental-permission");
  assert.equal(permissionFlag("23.4.0"), "--experimental-permission");
  assert.equal(permissionFlag("23.5.0"), "--permission");
  assert.equal(permissionFlag("24.6.0"), "--permission");
});

test("exec kills tools that exceed the timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-exec-"));
  try {
    const entry = await makeTool(
      root,
      "export async function run() { await new Promise((r) => setTimeout(r, 3000)); return 'late'; }\n"
    );
    const { io, lines } = capture();
    const code = await runExec({ entry, inputJson: "{}", json: true, timeoutMs: 300 }, io);
    assert.equal(code, 4);
    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.timedOut, true);
    assert.equal(payload.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
