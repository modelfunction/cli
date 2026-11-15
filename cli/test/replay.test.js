import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { replayScorecard, formatReplay } from "../lib/replay.js";
import { runReplay } from "../mf.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MF = resolve(HERE, "../mf.js");

function suite(cases) {
  return { name: "replay-fixture", cases };
}

function row({ id, expectedTool = "a", actualTool = "a", selectionCorrect = true, bucket, ...rest }) {
  return {
    id,
    expectedTool,
    actualTool,
    selectionCorrect,
    reviewed: true,
    ...(bucket ? { bucket } : {}),
    ...rest
  };
}

test("replay restates selection under the current expected tool", () => {
  const card = {
    models: [
      {
        model: "m",
        rows: [
          row({ id: "c1", expectedTool: "a", actualTool: "a" }),
          row({ id: "c2", expectedTool: "a", actualTool: "b", selectionCorrect: false })
        ]
      }
    ]
  };
  const current = suite([
    { id: "c1", expectedTool: "b" },
    { id: "c2", expectedTool: "b" }
  ]);
  const report = replayScorecard(card, current);
  const model = report.models[0];
  assert.equal(model.reviewed, 2);
  assert.equal(model.selection.before, 0.5);
  assert.equal(model.selection.after, 0.5);
  assert.deepEqual(
    model.changed.map((entry) => [entry.id, entry.oldExpectedTool, entry.newExpectedTool, entry.newSelectionCorrect]),
    [
      ["c1", "a", "b", false],
      ["c2", "a", "b", true]
    ]
  );
  assert.match(formatReplay(report), /c1: a \[singleIntent\] → b \[singleIntent\]/);
  assert.match(formatReplay(report), /args\/pass 无法重算/);
});

test("replay honours multiStep legal first steps and skips missing/excluded rows", () => {
  const card = {
    models: [
      {
        model: "m",
        rows: [
          row({ id: "m1", expectedTool: "a", actualTool: "b", selectionCorrect: false }),
          row({ id: "missing", actualTool: "a" }),
          row({ id: "excluded", excludeFromBase: true }),
          row({ id: "unreviewed", reviewed: false })
        ]
      }
    ]
  };
  const current = suite([
    {
      id: "m1",
      expectedTool: "a",
      bucket: "multiStep",
      acceptableFirstCalls: ["a", "b"]
    },
    { id: "excluded", expectedTool: "a", excludeFromBase: true },
    { id: "unreviewed", expectedTool: "a", reviewed: false }
  ]);
  const report = replayScorecard(card, current);
  const model = report.models[0];
  assert.equal(model.reviewed, 1);
  assert.equal(model.missing, 1);
  assert.equal(model.changed[0].oldBucket, "singleIntent");
  assert.equal(model.changed[0].newBucket, "multiStep");
  assert.equal(model.changed[0].newSelectionCorrect, false);
  assert.equal(model.changed[0].newLegalFirstStep, true);
});

test("runReplay writes a JSON report and the CLI accepts positional scorecards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-replay-"));
  try {
    const suitePath = join(dir, "suite.json");
    const cardPath = join(dir, "card.json");
    const out = join(dir, "replayed.json");
    await writeFile(
      suitePath,
      JSON.stringify({
        name: "r",
        tools: [{ name: "a", description: "用于处理请求 A 的工具", parameters: { type: "object", properties: {} } }],
        cases: [{ id: "c1", input: "x", expectedTool: null }]
      }),
      "utf8"
    );
    await writeFile(
      cardPath,
      JSON.stringify({
        models: [{ model: "m", rows: [row({ id: "c1", expectedTool: "a", actualTool: "a" })] }]
      }),
      "utf8"
    );

    const lines = [];
    const code = await runReplay(
      { positionals: [cardPath], suite: suitePath, json: false, out },
      { log: (line) => lines.push(String(line)), error: () => {} }
    );
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /wrote/);
    const report = JSON.parse(await readFile(out, "utf8"));
    assert.equal(report.models[0].selection.after, 0);
    assert.equal(report.models[0].changed[0].newExpectedTool, null);

    const result = spawnSync(process.execPath, [MF, "replay", cardPath, "--suite", suitePath, "--json"], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"suite": "r"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
