import test from "node:test";
import assert from "node:assert/strict";
import { matchArg, matchArgs, scoreModel, pct } from "../lib/score.js";

test("matchArg supports plain values", () => {
  assert.equal(matchArg(5, 5), true);
  assert.equal(matchArg("5", 5), false);
  assert.equal(matchArg("  上海 ", "上海"), true);
  assert.equal(matchArg([1, 2], [1, 2]), true);
  assert.equal(matchArg({ a: 1 }, { a: 1 }), true);
  assert.equal(matchArg({ a: 1, b: 2 }, { a: 1 }), false);
});

test("matchArg supports $contains for strings and arrays", () => {
  assert.equal(matchArg("张三，5 年 Python", { $contains: "张三" }), true);
  assert.equal(matchArg("李四", { $contains: "张三" }), false);
  assert.equal(matchArg(["python", "redis"], { $contains: "redis" }), true);
  assert.equal(matchArg(undefined, { $contains: "x" }), false);
});

test("matchArg supports $oneOf and $exists", () => {
  assert.equal(matchArg("活泼", { $oneOf: ["专业", "活泼"] }), true);
  assert.equal(matchArg("严肃", { $oneOf: ["专业", "活泼"] }), false);
  assert.equal(matchArg("x", { $exists: true }), true);
  assert.equal(matchArg(undefined, { $exists: true }), false);
  assert.equal(matchArg(undefined, { $exists: false }), true);
});

test("matchArgs reports failing fields", () => {
  const result = matchArgs(
    { city: "上海", role: "后端" },
    {
      city: { $contains: "上海" },
      role: { $contains: "前端" },
      years: 5
    }
  );
  assert.equal(result.total, 3);
  assert.equal(result.matched, 1);
  assert.deepEqual(result.failures, ["role", "years"]);
});

test("scoreModel aggregates selection, args, pass and errors", () => {
  const cases = [
    { id: "a", expectedTool: "x", expectedArgs: { v: 1 } },
    { id: "b", expectedTool: "y", expectedArgs: { v: 2 } },
    { id: "c", expectedTool: null, expectedArgs: {} }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "x", arguments: { v: 1 } }], usage: { input: 10, output: 2 }, latencyMs: 100 },
    { ok: true, toolCalls: [{ name: "x", arguments: { v: 9 } }], usage: { input: 10, output: 2 }, latencyMs: 300 },
    { ok: false, error: "boom", toolCalls: [], usage: { input: 0, output: 0 }, latencyMs: 0 }
  ];

  const summary = scoreModel({ model: "m", cases, results, pricing: { input: 1, output: 2 } });
  assert.equal(summary.total, 3);
  assert.equal(summary.selectionAccuracy, 1 / 3);
  assert.equal(summary.argAccuracy, 1);
  assert.equal(summary.passRate, 1 / 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.p50LatencyMs, 100);
  assert.ok(summary.totalCostCny > 0);
  assert.equal(summary.totalCost, summary.totalCostCny);
  assert.equal(summary.costCurrency, "CNY");
  assert.equal(summary.totalTokens, 24);
  assert.equal(summary.rows[2].actualTool, null);
});

test("scoreModel scores multiStep opening moves as legal first steps", () => {
  const cases = [
    { id: "s1", expectedTool: "create", expectedArgs: {} },
    {
      id: "m1",
      expectedTool: "create",
      expectedArgs: {},
      bucket: "multiStep",
      acceptableFirstCalls: ["create", "read"]
    },
    {
      id: "m2",
      expectedTool: "create",
      expectedArgs: {},
      bucket: "multiStep",
      acceptableFirstCalls: ["create", "read"]
    },
    {
      id: "a1",
      expectedTool: "tavily",
      expectedArgs: {},
      bucket: "ambiguous",
      acceptableFirstCalls: ["tavily", "google"]
    }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "create", arguments: {} }], usage: {}, latencyMs: 1 },
    { ok: true, toolCalls: [{ name: "read", arguments: {} }], usage: {}, latencyMs: 1 },
    { ok: true, toolCalls: [{ name: "write", arguments: {} }], usage: {}, latencyMs: 1 },
    { ok: true, toolCalls: [{ name: "google", arguments: {} }], usage: {}, latencyMs: 1 }
  ];

  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.selectionAccuracy, 0.25);
  assert.equal(summary.selectionAccuracySingleIntent, 1);
  assert.equal(summary.hasBucketVariety, true);
  assert.equal(summary.buckets.singleIntent.reviewed, 1);
  assert.equal(summary.buckets.multiStep.reviewed, 2);
  assert.equal(summary.buckets.multiStep.legalFirstSteps, 1);
  assert.equal(summary.buckets.multiStep.firstCallMisses, 1);
  assert.equal(summary.buckets.ambiguous.legalFirstSteps, 1);
  assert.equal(summary.firstCallMisses, 1);
  assert.equal(summary.legalFirstStepRate, 2 / 3);
  assert.equal(summary.rows[1].legalFirstStep, true);
  assert.equal(summary.rows[1].selectionCorrect, false);
  assert.equal(summary.rows[2].legalFirstStep, false);
  assert.deepEqual(summary.rows[1].acceptableFirstCalls, ["create", "read"]);
});

test("scoreModel excludes excludeFromBase cases from base metrics", () => {
  const cases = [
    { id: "a", expectedTool: "x", expectedArgs: {} },
    { id: "b", expectedTool: "y", expectedArgs: {}, excludeFromBase: true }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "x", arguments: {} }], usage: { input: 1, output: 1 }, latencyMs: 1 },
    { ok: true, toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 }
  ];

  const base = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(base.total, 2);
  assert.equal(base.reviewedTotal, 1);
  assert.equal(base.excludedTotal, 1);
  assert.equal(base.selectionAccuracy, 1);
  assert.equal(base.rows[1].excludeFromBase, true);

  const profiles = scoreModel({ model: "m", cases, results, pricing: null, scope: "profiles" });
  assert.equal(profiles.reviewedTotal, 2);
  assert.equal(profiles.excludedTotal, 0);
  assert.equal(profiles.selectionAccuracy, 0.5);
});

test("scoreModel classifies errors and reports accuracy without errors", () => {
  const cases = [
    { id: "a", expectedTool: "x", expectedArgs: {} },
    { id: "b", expectedTool: "y", expectedArgs: {} },
    { id: "c", expectedTool: "z", expectedArgs: {} }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "x", arguments: {} }], usage: { input: 1, output: 1 }, latencyMs: 1 },
    { ok: false, error: "timeout after 60000ms", toolCalls: [], usage: { input: 0, output: 0 }, latencyMs: 0 },
    { ok: false, error: "HTTP 500: boom", toolCalls: [], usage: { input: 0, output: 0 }, latencyMs: 0 }
  ];

  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.errors, 2);
  assert.deepEqual(summary.errorsByKind, { timeout: 1, http: 1 });
  assert.equal(summary.scoredTotal, 1);
  assert.equal(summary.selectionAccuracy, 1 / 3);
  assert.equal(summary.selectionAccuracyExcludingErrors, 1);
  assert.equal(summary.rows[1].errorKind, "timeout");
});

test("scoreModel reports cost in the configured currency", () => {
  const cases = [{ id: "a", expectedTool: "x", expectedArgs: {} }];
  const results = [
    { ok: true, toolCalls: [{ name: "x", arguments: {} }], usage: { input: 1000, output: 200 }, latencyMs: 1 }
  ];

  const usd = scoreModel({ model: "m", cases, results, pricing: { input: 1, output: 2 }, currency: "usd" });
  assert.equal(usd.costCurrency, "USD");
  assert.ok(usd.totalCost > 0);
  assert.equal(usd.avgCost, usd.totalCost);
  assert.equal(usd.totalCostCny, undefined);
  assert.equal(usd.avgCostCny, undefined);
  assert.equal(usd.totalTokens, 1200);

  const cny = scoreModel({ model: "m", cases, results, pricing: { input: 1, output: 2 } });
  assert.equal(cny.costCurrency, "CNY");
  assert.equal(cny.totalCostCny, cny.totalCost);
});

test("scoreModel treats no-tool cases correctly", () => {
  const cases = [{ id: "n", expectedTool: null, expectedArgs: {} }];
  const results = [{ ok: true, toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 }];
  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.selectionAccuracy, 1);
  assert.equal(summary.argAccuracy, null);
  assert.equal(summary.passRate, 1);
  assert.equal(summary.totalCostCny, 0);
});

test("scoreModel splits singleIntent selection from negative-case abstention", () => {
  const cases = [
    ...Array.from({ length: 13 }, (_, index) => ({ id: `p${index}`, expectedTool: "x", expectedArgs: {} })),
    ...Array.from({ length: 2 }, (_, index) => ({ id: `n${index}`, expectedTool: null, expectedArgs: {} }))
  ];
  const results = [
    ...Array.from({ length: 9 }, () => ({ ok: true, toolCalls: [{ name: "x", arguments: {} }], usage: {}, latencyMs: 1 })),
    ...Array.from({ length: 4 }, () => ({ ok: true, toolCalls: [{ name: "y", arguments: {} }], usage: {}, latencyMs: 1 })),
    ...Array.from({ length: 2 }, () => ({ ok: true, toolCalls: [], usage: {}, latencyMs: 1 }))
  ];

  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.selectionAccuracySingleIntent, 11 / 15);
  assert.equal(summary.selectionAccuracySingleIntentPositives, 9 / 13);
  assert.equal(summary.abstentionRateSingleIntent, 1);
  assert.deepEqual(summary.buckets.singleIntent.positives, { reviewed: 13, scored: 13, hits: 9, accuracy: 9 / 13 });
  assert.deepEqual(summary.buckets.singleIntent.negatives, { reviewed: 2, scored: 2, hits: 2, accuracy: 1 });
});

test("scoreModel keeps transport errors out of the behavioural first-step denominator", () => {
  const cases = [
    { id: "ok", expectedTool: "create", bucket: "multiStep", acceptableFirstCalls: ["create", "read"] },
    { id: "miss", expectedTool: "create", bucket: "multiStep", acceptableFirstCalls: ["create", "read"] },
    { id: "err", expectedTool: "create", bucket: "multiStep", acceptableFirstCalls: ["create", "read"] }
  ];
  const results = [
    { ok: true, toolCalls: [{ name: "read", arguments: {} }], usage: {}, latencyMs: 1 },
    { ok: true, toolCalls: [{ name: "write", arguments: {} }], usage: {}, latencyMs: 1 },
    { ok: false, error: "HTTP 429: rate limited", toolCalls: [], usage: {}, latencyMs: 0 }
  ];

  const summary = scoreModel({ model: "m", cases, results, pricing: null });
  assert.equal(summary.firstCallMisses, 2);
  assert.equal(summary.firstCallErrors, 1);
  assert.equal(summary.legalFirstStepRate, 1 / 3);
  assert.equal(summary.legalFirstStepRateExcludingErrors, 1 / 2);
  assert.equal(summary.buckets.multiStep.firstCallErrors, 1);
  assert.equal(summary.buckets.multiStep.firstCallBehaviorMisses, 1);
  assert.equal(summary.buckets.multiStep.legalFirstStepRateExcludingErrors, 1 / 2);
});

test("pct formats ratios", () => {
  assert.equal(pct(0.846), "85%");
  assert.equal(pct(0), "0%");
  assert.equal(pct(null), "n/a");
});

test("pickRepresentative takes the majority outcome and flags flips", async () => {
  const { pickRepresentative } = await import("../lib/score.js");
  const runs = [
    { ok: true, toolCalls: [{ name: "a" }] },
    { ok: true, toolCalls: [] },
    { ok: true, toolCalls: [{ name: "a" }] }
  ];
  const picked = pickRepresentative(runs);
  assert.equal(picked.result.toolCalls[0].name, "a");
  assert.equal(picked.unstable, true);
  assert.deepEqual(picked.outcomes, [
    { outcome: "a", count: 2 },
    { outcome: "(no tool)", count: 1 }
  ]);
  assert.equal(pickRepresentative([runs[0], runs[0]]).unstable, false);
});
