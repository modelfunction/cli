import test from "node:test";
import assert from "node:assert/strict";
import { toolFingerprint, caseFingerprint, suiteFingerprint } from "../lib/fingerprint.js";
import { compareScorecards, formatCompare } from "../lib/compare.js";

function row({ id = "c1", selectionCorrect = true, passed = true, matched = 1, total = 1, reviewed = true } = {}) {
  return {
    id,
    expectedTool: "a",
    actualTool: selectionCorrect ? "a" : null,
    selectionCorrect,
    args: { total, matched, failures: passed ? [] : ["x"] },
    passed,
    reviewed,
    latencyMs: 1,
    usage: { input: 1, output: 1 },
    error: null
  };
}

function profileReport(hash, mountedAccuracy, allAccuracy) {
  return {
    hash,
    groups: [{ name: "search", tools: 1, cases: 2 }],
    warnings: [],
    models: [
      {
        model: "m",
        totals: {},
        profiles: [
          {
            profile: "search",
            mountedTools: 1,
            cases: 2,
            reviewed: 2,
            mounted: { selectionAccuracy: mountedAccuracy, argAccuracy: 1, passRate: 1, correct: 2 },
            allInOne: { selectionAccuracy: allAccuracy, argAccuracy: 1, passRate: 1, correct: 1 },
            delta: { selection: 0, args: 0, pass: 0 },
            lifted: [],
            jammed: []
          }
        ]
      }
    ]
  };
}

function scorecard({ toolHash, caseHash, rows }) {
  return {
    suite: {
      name: "t",
      path: "suite.json",
      tools: ["a"],
      cases: rows.length,
      fingerprint: {
        hash: `${toolHash}:${caseHash}`,
        tools: [{ name: "a", hash: toolHash }],
        cases: rows.map((entry) => ({ id: entry.id, hash: caseHash })),
        reviewed: rows.length
      }
    },
    models: [{ model: "m", rows }]
  };
}

test("tool fingerprint ignores key order and whitespace, changes with content", () => {
  const a = toolFingerprint({
    name: "score",
    description: "评估 简历 与岗位",
    parameters: { type: "object", properties: { x: { type: "string" } } }
  });
  const b = toolFingerprint({
    name: "score",
    description: "评估   简历 与岗位 ",
    parameters: { properties: { x: { type: "string" } }, type: "object" }
  });
  assert.equal(a, b);

  const c = toolFingerprint({
    name: "score",
    description: "评估简历与岗位匹配度",
    parameters: { type: "object", properties: { x: { type: "string" } } }
  });
  assert.notEqual(a, c);
});

test("suite fingerprint changes when a case changes but not when only order changes", () => {
  const tools = [{ name: "a", description: "用于处理", parameters: { type: "object", properties: {} } }];
  const cases = [
    { id: "c1", input: "你好", expectedTool: null, expectedArgs: {}, reviewed: true },
    { id: "c2", input: "帮我处理", expectedTool: "a", expectedArgs: {}, reviewed: true }
  ];
  const first = suiteFingerprint({ tools, cases });
  const reordered = suiteFingerprint({ tools, cases: [cases[1], cases[0]] });
  assert.notEqual(first.hash, reordered.hash, "case order is part of the identity");

  const changed = suiteFingerprint({
    tools,
    cases: [{ ...cases[0] }, { ...cases[1], input: "帮我处理一下" }]
  });
  assert.notEqual(first.hash, changed.hash);
  assert.equal(caseFingerprint(cases[1]), caseFingerprint({ ...cases[1] }));
});

test("compare detects regressions on identical definitions", () => {
  const before = scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ passed: true })] });
  const after = scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ passed: false, matched: 0 })] });

  const report = compareScorecards(before, after);
  assert.equal(report.toolChanges.length, 0);
  assert.equal(report.caseChanges.length, 0);
  const model = report.models[0];
  assert.equal(model.comparable, true);
  assert.equal(model.reviewed, 1);
  assert.equal(model.regressions.length, 1);
  assert.equal(model.regressions[0].id, "c1");
  assert.deepEqual(model.regressions[0].args, ["x"]);
  assert.equal(model.metrics.pass.before, 1);
  assert.equal(model.metrics.pass.after, 0);
});

test("compare marks runs not comparable when tool definition changes", () => {
  const before = scorecard({ toolHash: "t1", caseHash: "c1", rows: [row()] });
  const after = scorecard({ toolHash: "t2", caseHash: "c1", rows: [row()] });

  const report = compareScorecards(before, after);
  assert.equal(report.toolChanges.length, 1);
  assert.equal(report.toolChanges[0].change, "changed");
  assert.equal(report.models[0].comparable, false);
  assert.equal(report.models[0].regressions.length, 0);
});

test("compare attributes stolen calls to a newly added tool", () => {
  const before = scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ id: "c1" })] });
  const after = scorecard({
    toolHash: "t2",
    caseHash: "c1",
    rows: [{ ...row({ id: "c1", selectionCorrect: false, passed: false, matched: 0 }), actualTool: "b" }]
  });
  after.suite.fingerprint.tools = [
    { name: "a", hash: "t2" },
    { name: "b", hash: "tb-new" }
  ];

  const report = compareScorecards(before, after);
  const model = report.models[0];
  assert.equal(model.interference.length, 1);
  assert.equal(model.interference[0].expected, "a");
  assert.equal(model.interference[0].stolenBy, "b");
  assert.equal(model.interference[0].count, 1);
  assert.equal(model.interference[0].stolenByIsNewTool, true);
  assert.ok(
    model.confusion.some((entry) => entry.expected === "a" && entry.actual === "b" && entry.count === 1)
  );
});

test("compare only uses cases whose content hash matches", () => {
  const before = scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ id: "c1" })] });
  const after = scorecard({ toolHash: "t1", caseHash: "c2", rows: [row({ id: "c1" })] });

  const report = compareScorecards(before, after);
  assert.equal(report.caseChanges.length, 1);
  assert.equal(report.models[0].comparable, false);
  assert.equal(report.models[0].commonCases, 0);
  assert.equal(report.models[0].reviewed, 0);
});

test("compare reports per-profile movement when the grouping is unchanged", () => {
  const before = {
    ...scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ id: "c1" })] }),
    profiles: profileReport("abc", 1, 0.5)
  };
  const after = {
    ...scorecard({ toolHash: "t1", caseHash: "c1", rows: [row({ id: "c1" })] }),
    profiles: profileReport("abc", 0.5, 0.5)
  };
  const report = compareScorecards(before, after);
  assert.equal(report.profiles.comparable, true);
  const entry = report.profiles.models[0].profiles[0];
  assert.equal(entry.mounted.before, 1);
  assert.equal(entry.mounted.after, 0.5);
  assert.match(formatCompare(report), /search\s+100% → 50%（-50pp）/);

  const regrouped = compareScorecards(before, { ...after, profiles: profileReport("def", 0.5, 0.5) });
  assert.equal(regrouped.profiles.comparable, false);
  assert.match(formatCompare(regrouped), /分组定义已变更/);
});

test("compare ignores profiles when neither report has one", () => {
  const report = compareScorecards(
    scorecard({ toolHash: "t1", caseHash: "c1", rows: [row()] }),
    scorecard({ toolHash: "t1", caseHash: "c1", rows: [row()] })
  );
  assert.equal(report.profiles, null);
});
