import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addCases,
  computeCoverage,
  formatCoverage,
  prepareItem,
  pairSimilarity,
  pairSimilarityPrepared,
  familyScore,
  familyScorePrepared
} from "../lib/cases.js";
import { scoreModel } from "../lib/score.js";

test("prepared pair scoring matches the convenience API", () => {
  const a = {
    name: "sessions_list",
    description: "List sessions for an agent.",
    parameters: { type: "object", properties: { agentId: { type: "string" } } }
  };
  const b = {
    name: "session_status",
    description: "Show the status of one session.",
    parameters: { type: "object", properties: { sessionKey: { type: "string" } } }
  };
  for (const [x, y] of [[a, b], [b, a], [a, a]]) {
    assert.deepEqual(pairSimilarityPrepared(prepareItem(x), prepareItem(y)), pairSimilarity(x, y));
    assert.equal(familyScorePrepared(prepareItem(x), prepareItem(y)), familyScore(x, y));
  }
});

async function makeSuite(root, cases = []) {
  const suitePath = join(root, "suite.json");
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
        cases
      },
      null,
      2
    ),
    "utf8"
  );
  return suitePath;
}

test("addCases carries bucket tags and rejects bad accepts-lists", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-cases-bucket-"));
  try {
    const suitePath = await makeSuite(root);
    const result = await addCases(
      suitePath,
      {
        id: "m1",
        input: "read a.md then edit it",
        expectedTool: "a",
        bucket: "multiStep",
        acceptableFirstCalls: ["a"],
        bucketReason: "read is a legal first step"
      },
      { reviewed: true }
    );
    assert.equal(result.added[0].bucket, "multiStep");
    assert.deepEqual(result.added[0].acceptableFirstCalls, ["a"]);
    assert.equal(result.added[0].bucketReason, "read is a legal first step");

    const bad = await addCases(suitePath, {
      id: "m2",
      input: "x",
      expectedTool: "a",
      bucket: "multiStep",
      acceptableFirstCalls: ["missing"]
    });
    assert.equal(bad.added.length, 0);
    assert.match(bad.rejected[0].reason, /unknown acceptableFirstCalls/);

    const empty = await addCases(suitePath, {
      id: "m3",
      input: "x",
      expectedTool: "a",
      bucket: "multiStep",
      acceptableFirstCalls: []
    });
    assert.equal(empty.added.length, 0);
    assert.match(empty.rejected[0].reason, /non-empty array/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addCases validates, warns and writes agent cases", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-cases-"));
  try {
    const suitePath = await makeSuite(root);
    const result = await addCases(suitePath, [
      { id: "c1", input: "帮我处理 hi 这段", expectedTool: "a", expectedArgs: { x: { $contains: "hi" } } },
      { id: "c2", input: "你好", expectedTool: null },
      { id: "c3", input: "x", expectedTool: "nope" },
      { id: "c1", input: "duplicate", expectedTool: null },
      { id: "c4", input: "用 A 处理一下", expectedTool: "a", expectedArgs: { y: "1" } }
    ]);

    assert.equal(result.added.length, 3);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.warnings.length, 1);
    assert.deepEqual(result.rejected.map((item) => item.id).sort(), ["c1", "c3"]);

    const written = JSON.parse(await readFile(suitePath, "utf8"));
    assert.equal(written.cases.length, 3);
    const first = written.cases.find((testCase) => testCase.id === "c1");
    assert.equal(first.source, "agent");
    assert.equal(first.reviewed, false);
    assert.deepEqual(first.tags, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("addCases dry-run does not write", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-cases-"));
  try {
    const suitePath = await makeSuite(root);
    const before = await readFile(suitePath, "utf8");
    const result = await addCases(suitePath, [{ id: "d1", input: "dry", expectedTool: null }], {
      dryRun: true
    });
    assert.equal(result.added.length, 1);
    assert.equal(await readFile(suitePath, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeCoverage reports per-tool gaps and unreviewed counts", () => {
  const suite = {
    tools: [{ name: "a" }, { name: "b" }],
    cases: [
      { id: "1", expectedTool: "a", expectedArgs: { x: 1 }, reviewed: true },
      { id: "2", expectedTool: "a", expectedArgs: {}, reviewed: false },
      { id: "3", expectedTool: "b", expectedArgs: {}, reviewed: true },
      { id: "4", expectedTool: null, expectedArgs: {}, reviewed: true }
    ]
  };
  const report = computeCoverage(suite);
  assert.equal(report.total, 4);
  assert.equal(report.negative, 1);
  assert.equal(report.negativeRatio, 0.25);
  assert.equal(report.unreviewed, 1);

  const a = report.tools.find((tool) => tool.name === "a");
  const b = report.tools.find((tool) => tool.name === "b");
  assert.deepEqual(
    { total: a.total, withArgs: a.withArgs, reviewed: a.reviewed, unreviewed: a.unreviewed },
    { total: 2, withArgs: 1, reviewed: 1, unreviewed: 1 }
  );
  assert.equal(b.total, 1);
  assert.equal(b.missing, 2);
  assert.ok(report.warnings.some((warning) => warning.includes("b: 1/3")));
});

test("computeCoverage reports per-profile case counts and uncovered tools", () => {
  const suite = {
    tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
    cases: [
      { id: "1", expectedTool: "a", expectedArgs: {} },
      { id: "2", expectedTool: "b", expectedArgs: {} },
      { id: "3", expectedTool: null, expectedArgs: {} },
      { id: "4", expectedTool: "a", expectedArgs: {}, excludeFromProfiles: true },
      { id: "5", expectedTool: null, expectedArgs: {}, excludeFromProfiles: true }
    ],
    profiles: { one: ["a", "c"], two: ["b"] }
  };
  const report = computeCoverage(suite);
  assert.deepEqual(report.profiles, [
    { name: "one", tools: 2, cases: 1, negatives: 1, negativeRatio: 0.5, missing: ["c"] },
    { name: "two", tools: 1, cases: 1, negatives: 1, negativeRatio: 0.5, missing: [] }
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes("组 one") && warning.includes("c")));

  const empty = computeCoverage({ ...suite, profiles: { idle: ["c"] } });
  assert.ok(empty.warnings.some((warning) => warning.includes("组 idle: 0 条正例")));
  assert.match(formatCoverage(report), /profiles（分组后/);
  assert.equal(computeCoverage({ tools: suite.tools, cases: suite.cases }).profiles, null);
});

test("computeCoverage surfaces skills that are out of scope", () => {
  const report = computeCoverage({
    tools: [{ name: "a" }],
    cases: [{ id: "1", expectedTool: null, expectedArgs: {} }],
    skills: ["review", "deploy"]
  });
  assert.equal(report.skills, 2);
  assert.ok(report.warnings.some((warning) => warning.includes("2 个 skill")));
  assert.match(formatCoverage(report), /skills: 2（仅静态检查，不参与模型评测）/);
});

test("scoreModel excludes unreviewed cases from official metrics", () => {
  const cases = [
    { id: "a", expectedTool: "x", expectedArgs: {}, reviewed: true },
    { id: "b", expectedTool: "y", expectedArgs: {}, reviewed: false }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "x", arguments: {} }], usage: { input: 1, output: 1 }, latencyMs: 1 },
    { ok: true, toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 }
  ];
  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.total, 2);
  assert.equal(summary.reviewedTotal, 1);
  assert.equal(summary.selectionAccuracy, 1);
  assert.equal(summary.passRate, 1);
  assert.equal(summary.unreviewedTotal, 1);
  assert.equal(summary.unreviewedSelectionAccuracy, 0);
});

test("coverage and lint accept a scan draft with no cases yet", async () => {
  const { runCoverage, runLint } = await import("../mf.js");
  const root = await mkdtemp(join(tmpdir(), "mf-draft-"));
  try {
    const suitePath = join(root, "draft.json");
    await writeFile(
      suitePath,
      JSON.stringify(
        {
          name: "draft",
          tools: [
            {
              name: "summarize",
              description: "用于把长文本压缩成三段以内的摘要，适用于会议纪要。",
              parameters: {
                type: "object",
                properties: { text: { type: "string", description: "待摘要文本" } },
                required: ["text"]
              }
            }
          ],
          cases: []
        },
        null,
        2
      ),
      "utf8"
    );

    const lines = [];
    const io = {
      log: (line) => lines.push(String(line)),
      error: (line) => lines.push(String(line))
    };
    assert.equal(await runCoverage({ suite: suitePath, json: true }, io), 0);
    const report = JSON.parse(lines.join("\n"));
    assert.equal(report.total, 0);
    assert.ok(report.warnings.some((warning) => warning.includes("summarize: 0 条用例")));

    lines.length = 0;
    assert.equal(await runLint({ suite: suitePath, json: true }, io), 0);
    const lint = JSON.parse(lines.join("\n"));
    assert.ok(!lint.findings.some((finding) => finding.code === "required-uncovered"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
