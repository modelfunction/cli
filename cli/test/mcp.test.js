import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MF_JS = fileURLToPath(new URL("../mf.js", import.meta.url));

function createClient(child) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "rpc error"));
        else resolve(message.result);
      }
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`rpc timeout: ${method}`));
          }
        }, 120_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    }
  };
}

test("mf mcp exposes tools and serves coverage/add_cases/run_eval", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-mcp-"));
  const suitePath = join(root, "mf.suite.json");
  await writeFile(
    suitePath,
    JSON.stringify(
      {
        name: "t",
        tools: [
          {
            name: "a",
            description: "工具 A",
            parameters: { type: "object", properties: { x: { type: "string" } } }
          }
        ],
        cases: [
          {
            id: "c1",
            input: "用 A 处理一下",
            expectedTool: "a",
            expectedArgs: { x: { $exists: true } },
            reviewed: true
          }
        ],
        profiles: { main: ["a"] }
      },
      null,
      2
    ),
    "utf8"
  );

  await writeFile(
    join(root, "function.json"),
    JSON.stringify({
      name: "a",
      description: "工具 A",
      input: { type: "object", properties: { x: { type: "string" } } }
    }),
    "utf8"
  );

  const child = spawn(process.execPath, [MF_JS, "mcp"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MF_CONFIG_DIR: root, MF_NO_USAGE: "1" }
  });

  try {
    const client = createClient(child);
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" }
    });
    assert.equal(init.serverInfo.name, "modelfunction");
    client.notify("notifications/initialized", {});

    const listed = await client.request("tools/list", {});
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "add_cases",
        "audit",
        "check",
        "cluster",
        "compare",
        "coverage",
        "lint",
        "list_suite",
        "run_eval",
        "scan_tools"
      ]
    );

    const suiteInfo = await client.request("tools/call", {
      name: "list_suite",
      arguments: { suite: suitePath }
    });
    const info = JSON.parse(suiteInfo.content[0].text);
    assert.equal(info.cases, 1);
    assert.equal(info.reviewed, 1);

    const coverage = await client.request("tools/call", {
      name: "coverage",
      arguments: { suite: suitePath }
    });
    assert.equal(JSON.parse(coverage.content[0].text).total, 1);

    const linted = await client.request("tools/call", {
      name: "lint",
      arguments: { suite: suitePath }
    });
    assert.equal(JSON.parse(linted.content[0].text).tools, 1);

    const checked = await client.request("tools/call", {
      name: "check",
      arguments: {
        manifest: {
          name: "b",
          description: "工具 B",
          parameters: { type: "object", properties: { y: { type: "string" } } }
        },
        installed: [
          {
            name: "a",
            description: "工具 A",
            parameters: { type: "object", properties: { x: { type: "string" } } }
          }
        ]
      }
    });
    const checkResult = JSON.parse(checked.content[0].text);
    assert.ok(["pass", "warn"].includes(checkResult.verdict));

    const batchChecked = await client.request("tools/call", {
      name: "check",
      arguments: {
        manifests: [
          {
            name: "c",
            description: "工具 C",
            parameters: { type: "object", properties: { z: { type: "string" } } }
          },
          {
            name: "d",
            description: "工具 D",
            parameters: { type: "object", properties: { w: { type: "string" } } }
          }
        ],
        installed: []
      }
    });
    const batchResult = JSON.parse(batchChecked.content[0].text);
    assert.equal(batchResult.items, 2);
    assert.equal(batchResult.results.length, 2);

    const clustered = await client.request("tools/call", {
      name: "cluster",
      arguments: { suite: suitePath }
    });
    assert.equal(JSON.parse(clustered.content[0].text).total, 1);

    const added = await client.request("tools/call", {
      name: "add_cases",
      arguments: {
        suite: suitePath,
        cases: [{ id: "c2", input: "你好", expectedTool: null }]
      }
    });
    const addResult = JSON.parse(added.content[0].text);
    assert.equal(addResult.added.length, 1);
    assert.equal(addResult.added[0].reviewed, false);

    // One call covers both the scorecard and the profile pass-through; a second
    // eval spawn doubles the spawn contention under the full suite.
    const evaluated = await client.request("tools/call", {
      name: "run_eval",
      arguments: { suite: suitePath, models: "mock", cases: "c1", profile: "all" }
    });
    const evalResult = JSON.parse(evaluated.content[0].text);
    assert.equal(evalResult.exitCode, 0);
    assert.equal(evalResult.scorecard.models[0].total, 1);
    assert.equal(evalResult.scorecard.models[0].model, "mock");
    assert.equal(evalResult.scorecard.profiles.groups[0].name, "main");
    assert.equal(evalResult.scorecard.profiles.models[0].totals.reviewed, 1);

    const draftPath = join(root, "mf.suite.json");
    const scanned = await client.request("tools/call", {
      name: "scan_tools",
      arguments: { root, writeSuite: draftPath }
    });
    const scanResult = JSON.parse(scanned.content[0].text);
    assert.equal(scanResult.suiteDraftPath, draftPath);
    const draft = JSON.parse(await readFile(draftPath, "utf8"));
    assert.deepEqual(draft.tools.map((tool) => tool.name), ["a"]);
    assert.deepEqual(draft.cases, []);
  } finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
  }
});
