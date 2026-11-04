import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeStdioServer } from "../lib/mcp-probe.js";
import { loadAdapterTools } from "../lib/adapter-import.js";
import { runScan } from "../mf.js";

const ECHO_SERVER = [
  'import { createInterface } from "node:readline";',
  'const rl = createInterface({ input: process.stdin });',
  'rl.on("line", (line) => {',
  "  let msg;",
  "  try { msg = JSON.parse(line); } catch { return; }",
  "  if (msg.id === undefined) return;",
  '  if (msg.method === "initialize") {',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" } } }) + "\\n");',
  '  } else if (msg.method === "tools/list") {',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } }) + "\\n");',
  "  }",
  "});"
].join("\n");

const SILENT_SERVER = [
  'import { createInterface } from "node:readline";',
  'createInterface({ input: process.stdin }).on("line", () => {});'
].join("\n");

function capture() {
  const lines = [];
  return { io: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) }, lines };
}

test("probe reads tools/list over stdio", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-probe-"));
  try {
    const serverPath = join(root, "server.mjs");
    await writeFile(serverPath, ECHO_SERVER, "utf8");

    const result = await probeStdioServer(
      { command: process.execPath, args: [serverPath] },
      { timeoutMs: 5000 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, "echo");
    assert.deepEqual(Object.keys(result.tools[0].parameters.properties), ["text"]);
    assert.deepEqual(result.tools[0].parameters.required, ["text"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probe times out when the server never answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-probe-"));
  try {
    const serverPath = join(root, "silent.mjs");
    await writeFile(serverPath, SILENT_SERVER, "utf8");

    const result = await probeStdioServer(
      { command: process.execPath, args: [serverPath] },
      { timeoutMs: 300 }
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan --probe merges MCP tools and redacts env values", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-probe-"));
  try {
    const serverPath = join(root, "server.mjs");
    await writeFile(serverPath, ECHO_SERVER, "utf8");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          echo: { command: process.execPath, args: [serverPath], env: { SECRET_TOKEN: "should-not-leak" } }
        }
      }),
      "utf8"
    );

    const { io, lines } = capture();
    const code = await runScan(
      { root, probe: true, timeoutMs: 20000, json: true, noWrite: true, from: null },
      io
    );
    assert.equal(code, 0);

    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.report.probes[0].ok, true);
    assert.equal(payload.report.probes[0].toolCount, 1);
    assert.deepEqual(payload.draft.tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual(payload.report.mcpServers[0].envKeys, ["SECRET_TOKEN"]);
    assert.ok(!JSON.stringify(payload.report).includes("should-not-leak"), "env values must be redacted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan --from imports tools from a module", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-adapter-"));
  try {
    const adapterPath = join(root, "mf.tools.mjs");
    await writeFile(
      adapterPath,
      [
        "export default [",
        "  { type: 'function', function: {",
        "    name: 'greet',",
        "    description: '打招呼',",
        "    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }",
        "  } }",
        "];"
      ].join("\n"),
      "utf8"
    );

    const tools = await loadAdapterTools(adapterPath);
    assert.equal(tools[0].name, "greet");

    const { io, lines } = capture();
    const code = await runScan({ root, from: adapterPath, probe: false, json: true, noWrite: true }, io);
    assert.equal(code, 0);
    const payload = JSON.parse(lines.join("\n"));
    assert.ok(payload.draft.tools.some((tool) => tool.name === "greet"));
    assert.ok(payload.report.sources.some((source) => source.type === "adapter"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter import rejects modules without a tool array", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-adapter-"));
  try {
    const badPath = join(root, "bad.mjs");
    await writeFile(badPath, "export default { name: 'x' };", "utf8");
    await assert.rejects(() => loadAdapterTools(badPath), /需要 export default/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
