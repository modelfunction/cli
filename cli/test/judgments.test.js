import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuite } from "../lib/suite.js";
import { compareScorecards, formatCompare } from "../lib/compare.js";
import { runEval } from "../mf.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "../fixtures/models.json");

function suiteWith(judgments) {
  return {
    name: "judgments",
    tools: [
      {
        name: "a",
        description: "用于处理请求 A 的工具",
        parameters: { type: "object", properties: { x: { type: "string" } } }
      }
    ],
    cases: [{ id: "c1", input: "处理一下", expectedTool: "a", ...(judgments ? { judgments } : {}) }]
  };
}

async function writeSuite(dir, payload) {
  const path = join(dir, "suite.json");
  await writeFile(path, JSON.stringify(payload), "utf8");
  return path;
}

test("suite accepts append-only judgment history on a case", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-judgments-"));
  try {
    const path = await writeSuite(
      dir,
      suiteWith([
        {
          from: "b",
          to: "a",
          changedAt: "2026-11-10T00:00:00.000Z",
          reason: "guard 用例显示 b 是合法首步",
          evidencePointer: "feedback-1103#t03"
        }
      ])
    );
    const suite = await loadSuite(path);
    assert.deepEqual(suite.cases[0].judgments, [
      {
        from: "b",
        to: "a",
        changedAt: "2026-11-10T00:00:00.000Z",
        reason: "guard 用例显示 b 是合法首步",
        evidencePointer: "feedback-1103#t03"
      }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("suite rejects malformed judgment entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-judgments-bad-"));
  try {
    const invalid = [
      [{ from: "b", to: "a", changedAt: "not-a-date", reason: "x" }],
      [{ from: "b", to: "a", changedAt: "2026-11-10T00:00:00.000Z", reason: "" }],
      [{ from: 3, to: "a", changedAt: "2026-11-10T00:00:00.000Z", reason: "x" }],
      "not-an-array"
    ];
    for (const judgments of invalid) {
      const path = await writeSuite(dir, suiteWith(judgments));
      await assert.rejects(() => loadSuite(path), /judgments/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eval scorecards carry the judgment history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-judgments-eval-"));
  try {
    const path = await writeSuite(
      dir,
      suiteWith([
        {
          from: null,
          to: "a",
          changedAt: "2026-11-10T00:00:00.000Z",
          reason: "首次标注"
        }
      ])
    );
    const out = join(dir, "card.json");
    const code = await runEval(
      {
        suite: path,
        models: ["mock"],
        modelsFile: MODELS,
        cases: null,
        showCases: false,
        json: false,
        out,
        failUnder: null
      },
      { log: () => {}, error: () => {} }
    );
    assert.equal(code, 0);
    const card = JSON.parse(await readFile(out, "utf8"));
    assert.deepEqual(card.suite.judgments, [
      {
        caseId: "c1",
        from: null,
        to: "a",
        changedAt: "2026-11-10T00:00:00.000Z",
        reason: "首次标注"
      }
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compare lists judgment changes when a case expectation moves", () => {
  const fingerprint = (hash) => ({
    hash,
    tools: [{ name: "a", hash: "t1" }],
    cases: [{ id: "c1", hash }]
  });
  const row = (expectedTool) => ({
    id: "c1",
    expectedTool,
    actualTool: expectedTool,
    selectionCorrect: true,
    passed: true,
    reviewed: true,
    args: { total: 0, matched: 0, failures: [] }
  });
  const before = {
    suite: {
      fingerprint: fingerprint("h1"),
      judgments: [
        { caseId: "c1", from: null, to: "a", changedAt: "2026-11-01T00:00:00.000Z", reason: "首次标注" }
      ]
    },
    models: [{ model: "m", rows: [row("a")] }]
  };
  const after = {
    suite: {
      fingerprint: fingerprint("h2"),
      judgments: [
        { caseId: "c1", from: null, to: "a", changedAt: "2026-11-01T00:00:00.000Z", reason: "首次标注" },
        {
          caseId: "c1",
          from: "a",
          to: "b",
          changedAt: "2026-11-10T00:00:00.000Z",
          reason: "multiStep 首轮合法",
          evidencePointer: "t03"
        }
      ]
    },
    models: [{ model: "m", rows: [row("b")] }]
  };
  const report = compareScorecards(before, after);
  assert.equal(report.judgmentChanges.length, 1);
  assert.deepEqual(report.judgmentChanges[0], {
    id: "c1",
    change: "changed",
    beforeExpected: "a",
    afterExpected: "b",
    judgments: [
      {
        caseId: "c1",
        from: null,
        to: "a",
        changedAt: "2026-11-01T00:00:00.000Z",
        reason: "首次标注"
      },
      {
        caseId: "c1",
        from: "a",
        to: "b",
        changedAt: "2026-11-10T00:00:00.000Z",
        reason: "multiStep 首轮合法",
        evidencePointer: "t03"
      }
    ]
  });
  const text = formatCompare(report);
  assert.match(text, /judgment changed: c1 a → b/);
  assert.match(text, /2026-11-10 multiStep 首轮合法 \[t03\]/);
});
