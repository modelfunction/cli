import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolFingerprint, caseFingerprint, suiteFingerprint } from "../lib/fingerprint.js";
import { compareScorecards, formatCompare, regressionGate } from "../lib/compare.js";
import { runCompare } from "../mf.js";

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

test("regressionGate fails when a baseline model is missing from the report", () => {
  const gate = regressionGate({ models: [{ model: "M", reason: "模型不在新报告中" }] }, []);
  assert.equal(gate.status, "fail");
  assert.match(gate.message, /baseline model\(s\) not in this report: M/);
});

test("regressionGate fails when every reviewed call errored", () => {
  const comparison = { models: [{ model: "M", comparable: true, reviewed: 2, regressions: [] }] };
  const gate = regressionGate(comparison, [
    { model: "M", reviewedTotal: 2, errors: 2, errorsByKind: { network: 2 } }
  ]);
  assert.equal(gate.status, "fail");
  assert.match(gate.message, /all calls failed for: M \(2\/2 \{\"network\":2\}\)/);
});

test("regressionGate skips when definitions changed", () => {
  const comparison = { models: [{ model: "M", comparable: false, reviewed: 2, regressions: [] }] };
  const gate = regressionGate(comparison, [
    { model: "M", reviewedTotal: 2, errors: 0, errorsByKind: {} }
  ]);
  assert.equal(gate.status, "skip");
  assert.match(gate.message, /无法判定回归/);
});

test("regressionGate lists regressions for comparable models", () => {
  const comparison = {
    models: [{ model: "M", comparable: true, reviewed: 2, regressions: [{ id: "c1" }] }]
  };
  const gate = regressionGate(comparison, []);
  assert.equal(gate.status, "ok");
  assert.deepEqual(gate.regressions, ["M/c1"]);
});

function sameFingerprint() {
  return {
    hash: "same",
    tools: [{ name: "a", hash: "t1" }],
    cases: [{ id: "c1", hash: "c1" }]
  };
}

test("compare ignores excludeFromBase rows for regression metrics", () => {
  const fingerprint = sameFingerprint();
  const before = {
    suite: { fingerprint },
    models: [{ model: "m", rows: [{ ...row(), excludeFromBase: true }] }]
  };
  const after = {
    suite: { fingerprint },
    models: [
      {
        model: "m",
        rows: [{ ...row({ selectionCorrect: false, passed: false }), excludeFromBase: true }]
      }
    ]
  };
  const report = compareScorecards(before, after);
  const model = report.models[0];
  assert.equal(model.excluded, 1);
  assert.equal(model.reviewed, 0);
  assert.equal(model.regressions.length, 0);
  assert.match(formatCompare(report), /excludeFromBase/);
});

test("compare excludes multiStep legal first steps from persistent interference", () => {
  const fingerprint = {
    hash: "same",
    tools: [{ name: "a", hash: "t1" }],
    cases: [
      { id: "c1", hash: "1" },
      { id: "c2", hash: "2" },
      { id: "c3", hash: "3" }
    ]
  };
  const legalRow = (id, bucket, legal) => ({
    id,
    bucket,
    expectedTool: "a",
    actualTool: "b",
    selectionCorrect: false,
    legalFirstStep: legal,
    args: { total: 0, matched: 0, failures: [] },
    passed: false,
    reviewed: true,
    latencyMs: 1,
    usage: { input: 1, output: 1 },
    error: null
  });
  const rows = [legalRow("c1", "singleIntent", false), legalRow("c2", "multiStep", true), legalRow("c3", "singleIntent", false)];
  const before = { suite: { fingerprint }, models: [{ model: "m", rows }] };
  const after = { suite: { fingerprint }, models: [{ model: "m", rows }] };

  const report = compareScorecards(before, after);
  const model = report.models[0];
  assert.equal(model.persistentInterference.length, 1);
  assert.equal(model.persistentInterference[0].bucket, "singleIntent");
  assert.deepEqual(model.persistentInterference[0].cases, ["c1", "c3"]);
  assert.equal(model.confusion.length, 1);
  assert.equal(model.confusion[0].count, 2);
  assert.equal(model.buckets.multiStep.reviewed, 1);
  assert.equal(model.buckets.multiStep.legalFirstStep.after, 1);
  assert.equal(model.buckets.multiStep.firstCallMisses.after, 0);
  assert.equal(model.buckets.singleIntent.reviewed, 2);
  assert.match(formatCompare(report), /\[singleIntent\] a → b/);
});

test("compare --fail-on-regression exits 2 on a comparable regression", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-compare-"));
  try {
    const fingerprint = sameFingerprint();
    const before = {
      suite: { fingerprint },
      models: [{ model: "m", rows: [row()] }]
    };
    const after = {
      suite: { fingerprint },
      models: [{ model: "m", rows: [row({ selectionCorrect: false, passed: false })] }]
    };
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    await writeFile(beforePath, JSON.stringify(before), "utf8");
    await writeFile(afterPath, JSON.stringify(after), "utf8");
    const errors = [];
    const io = { log: () => {}, error: (line) => errors.push(String(line)) };
    const code = await runCompare(
      { paths: [beforePath, afterPath], json: true, failOnRegression: true },
      io
    );
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /regressions: m\/c1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

function packScorecard({ flipped = [], excluded = [], unreviewed = [] } = {}) {
  const ids = ["t01", "t02", "m03"];
  const rows = ids.map((id) => {
    const isFlipped = flipped.includes(id);
    return {
      id,
      expectedTool: "message",
      actualTool: isFlipped ? "read_goal_status" : "message",
      selectionCorrect: !isFlipped,
      args: isFlipped
        ? { total: 1, matched: 0, failures: ["text"] }
        : { total: 1, matched: 1, failures: [] },
      passed: !isFlipped,
      reviewed: !unreviewed.includes(id),
      source: "manual",
      ...(excluded.includes(id) ? { excludeFromBase: true } : {})
    };
  });
  return {
    suite: {
      fingerprint: {
        hash: "synthetic-efb-test",
        tools: [],
        cases: ids.map((id) => ({ id, hash: id === "t01" ? "h-stable" : "h-family" }))
      }
    },
    models: [{ model: "m-base", rows }]
  };
}

async function compareExit(before, after, failOnRegression = false) {
  const dir = await mkdtemp(join(tmpdir(), "mf-compare-accept-"));
  try {
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    await writeFile(beforePath, JSON.stringify(before), "utf8");
    await writeFile(afterPath, JSON.stringify(after), "utf8");
    return await runCompare(
      { paths: [beforePath, afterPath], json: true, failOnRegression },
      { log: () => {}, error: () => {} }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("acceptance A: excludeFromBase flips stay out of metrics and regressions", () => {
  const report = compareScorecards(
    packScorecard(),
    packScorecard({ flipped: ["t02", "m03"], excluded: ["t02", "m03"] })
  );
  const model = report.models[0];
  assert.equal(model.reviewed, 1);
  assert.equal(model.excluded, 2);
  assert.equal(model.metrics.selection.before, 1);
  assert.equal(model.metrics.selection.after, 1);
  assert.equal(model.regressions.length, 0);
  assert.match(formatCompare(report), /排除出回归判定: 2 条/);
  assert.match(formatCompare(report), /选择准确率: 100% → 100%/);
});

test("acceptance B: reviewed:false rows behave exactly like before the fix", () => {
  const report = compareScorecards(
    packScorecard(),
    packScorecard({ flipped: ["t02", "m03"], unreviewed: ["t02", "m03"] })
  );
  const model = report.models[0];
  assert.equal(model.reviewed, 1);
  assert.equal(model.excluded, 0);
  assert.equal(model.regressions.length, 0);
});

test("acceptance C: a real regression is listed and default compare exit stays 0", async () => {
  const before = packScorecard();
  const after = packScorecard({ flipped: ["t02", "m03"], excluded: ["m03"] });
  const model = compareScorecards(before, after).models[0];
  assert.equal(model.regressions.length, 1);
  assert.equal(model.regressions[0].id, "t02");
  assert.equal(await compareExit(before, after, false), 0);
  assert.equal(await compareExit(before, after, true), 2);
  const gate = regressionGate(compareScorecards(before, after), []);
  assert.equal(gate.status, "ok");
  assert.deepEqual(gate.regressions, ["m-base/t02"]);
});

test("acceptance C2/A2: --fail-on-regression penalizes real regressions only", async () => {
  const before = packScorecard();
  const excludedFlips = packScorecard({ flipped: ["t02", "m03"], excluded: ["t02", "m03"] });
  assert.equal(await compareExit(before, excludedFlips, true), 0);
  assert.equal(await compareExit(before, packScorecard({ flipped: ["t02"] }), true), 2);
});

function persistentScorecard({ flipped = [], unstable = [], stability = unstable.length > 0 } = {}) {
  const ids = ["z05", "z12", "f03", "f01"];
  const rows = ids.map((id) => ({
    id,
    expectedTool: "create_html_report",
    actualTool: flipped.includes(id) ? "file_read" : "create_html_report",
    selectionCorrect: !flipped.includes(id),
    args: { total: 0, matched: 0, failures: [] },
    passed: !flipped.includes(id),
    reviewed: true,
    source: "manual"
  }));
  return {
    suite: {
      fingerprint: {
        hash: "synthetic-persistent-test",
        tools: [
          { name: "create_html_report", hash: "h-report" },
          { name: "file_read", hash: "h-read" }
        ],
        cases: ids.map((id) => ({ id, hash: `h-${id}` }))
      },
      execution: { hash: "exec-1" }
    },
    models: [
      {
        model: "m-base",
        rows,
        ...(stability
          ? { stability: { runs: 3, unstable: unstable.map((id) => ({ id, outcomes: [] })) } }
          : {})
      }
    ]
  };
}

test("compare aggregates persistent interference across cases and reports", () => {
  const before = persistentScorecard({ flipped: ["z05", "z12", "f01"] });
  const after = persistentScorecard({ flipped: ["z05", "z12", "f03", "f01"] });
  const report = compareScorecards(before, after);
  const model = report.models[0];
  assert.equal(model.persistentInterference.length, 1);
  const pair = model.persistentInterference[0];
  assert.equal(pair.expected, "create_html_report");
  assert.equal(pair.stolenBy, "file_read");
  assert.equal(pair.occurrences, 7);
  assert.equal(pair.runs, 2);
  assert.deepEqual(pair.cases.sort(), ["f01", "f03", "z05", "z12"]);
  assert.equal(pair.stable, 4);
  assert.equal(pair.drifting, 0);
  assert.equal(model.stabilityCaptured, false);
  assert.match(formatCompare(report), /持续干扰/);
  assert.match(formatCompare(report), /未采集 stability 元数据/);
});

test("compare only claims stability when both reports captured it", () => {
  const before = persistentScorecard({ flipped: ["z05", "z12", "f01"], unstable: ["z12"] });
  const after = persistentScorecard({ flipped: ["z05", "z12", "f03", "f01"], unstable: ["f03"] });
  const full = compareScorecards(before, after);
  assert.equal(full.models[0].stabilityCaptured, true);
  assert.doesNotMatch(formatCompare(full), /未采集 stability 元数据/);

  const partial = compareScorecards(
    persistentScorecard({ flipped: ["z05", "z12", "f01"] }),
    after
  );
  assert.equal(partial.models[0].stabilityCaptured, false);
  assert.match(formatCompare(partial), /未采集 stability 元数据/);
});

test("compare separates stable misselection from high-entropy drift", () => {
  const before = persistentScorecard({ flipped: ["z05", "z12", "f01"] });
  const after = persistentScorecard({
    flipped: ["z05", "z12", "f03", "f01"],
    unstable: ["f03"]
  });
  const pair = compareScorecards(before, after).models[0].persistentInterference[0];
  assert.equal(pair.stable, 3);
  assert.equal(pair.drifting, 1);
});

test("compare does not flag sparse interference as persistent", () => {
  const onlyOne = compareScorecards(
    persistentScorecard({ flipped: ["z05"] }),
    persistentScorecard({ flipped: ["z05"] })
  );
  assert.equal(onlyOne.models[0].persistentInterference.length, 0);

  const twoRunsTwoCases = compareScorecards(
    persistentScorecard({ flipped: ["z05"] }),
    persistentScorecard({ flipped: ["z12"] })
  );
  assert.equal(twoRunsTwoCases.models[0].persistentInterference.length, 0);
});
