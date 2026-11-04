import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeProfiles,
  selectProfiles,
  selectProfileCases,
  analyzeMount,
  modelTotals,
  formatProfileReport
} from "../lib/profile.js";
import { runEval } from "../mf.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(HERE, "../fixtures/suite.json");
const MODELS = resolve(HERE, "../fixtures/models.json");

const TOOLS = ["resume_score", "interview_question", "salary_band", "jd_rewrite"];

function capture() {
  const lines = [];
  const errors = [];
  return {
    io: { log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) },
    lines,
    errors
  };
}

function baseOptions(overrides = {}) {
  return {
    suite: SUITE,
    models: ["mock"],
    modelsFile: MODELS,
    cases: null,
    profiles: null,
    showCases: false,
    json: true,
    out: null,
    failUnder: null,
    ...overrides
  };
}

function summaryOf(hits) {
  return {
    total: hits.length,
    reviewedTotal: hits.length,
    argAccuracy: 1,
    rows: hits.map((hit) => ({
      id: hit.id,
      expectedTool: hit.expected,
      actualTool: hit.actual,
      selectionCorrect: hit.correct,
      passed: hit.correct,
      reviewed: true,
      error: hit.error ?? null
    }))
  };
}

test("normalizeProfiles validates group names against the tool list", () => {
  const profiles = normalizeProfiles({ a: ["resume_score"], b: ["jd_rewrite", "jd_rewrite"] }, TOOLS);
  assert.deepEqual(profiles, [
    { name: "a", tools: ["resume_score"] },
    { name: "b", tools: ["jd_rewrite"] }
  ]);
  assert.equal(normalizeProfiles(undefined, TOOLS), null);
  assert.throws(() => normalizeProfiles({ a: ["nope"] }, TOOLS), /unknown tool "nope"/);
  assert.throws(() => normalizeProfiles({ a: [] }, TOOLS), /non-empty array/);
  assert.throws(() => normalizeProfiles([], TOOLS), /empty/);
});

test("normalizeProfiles accepts platform-style object groups", () => {
  assert.deepEqual(
    normalizeProfiles(
      [
        { agentType: "coding-default", tools: ["resume_score"], skills: ["anything"] },
        { agentType: "ops", tools: ["jd_rewrite"] }
      ],
      TOOLS
    ),
    [
      { name: "coding-default", tools: ["resume_score"] },
      { name: "ops", tools: ["jd_rewrite"] }
    ]
  );
  const profiles = normalizeProfiles(
    {
      0: { agentType: "coding-default", tools: ["resume_score"], skills: ["anything"] },
      1: { name: "ops", tools: ["jd_rewrite"] }
    },
    TOOLS
  );
  assert.deepEqual(profiles, [
    { name: "coding-default", tools: ["resume_score"] },
    { name: "ops", tools: ["jd_rewrite"] }
  ]);
  assert.throws(
    () => normalizeProfiles({ 0: { agentType: "skills-only", skills: ["a"] } }, TOOLS),
    /non-empty array/
  );
  assert.throws(
    () =>
      normalizeProfiles(
        {
          0: { agentType: "dup", tools: ["resume_score"] },
          1: { agentType: "dup", tools: ["jd_rewrite"] }
        },
        TOOLS
      ),
    /duplicate group name/
  );
});

test("selectProfiles accepts all or an explicit subset", () => {
  const profiles = [
    { name: "a", tools: ["resume_score"] },
    { name: "b", tools: ["jd_rewrite"] }
  ];
  assert.equal(selectProfiles(profiles, ["all"]).length, 2);
  assert.equal(selectProfiles(profiles, null).length, 2);
  assert.deepEqual(selectProfiles(profiles, ["b"]).map((profile) => profile.name), ["b"]);
  assert.throws(() => selectProfiles(profiles, ["zzz"]), /unknown profile/);
});

test("selectProfileCases keeps negative cases in every group", () => {
  const cases = [
    { id: "1", expectedTool: "resume_score" },
    { id: "2", expectedTool: "jd_rewrite" },
    { id: "3", expectedTool: null },
    { id: "4", expectedTool: "resume_score", excludeFromProfiles: true },
    { id: "5", expectedTool: null, excludeFromProfiles: true }
  ];
  const kept = selectProfileCases(cases, new Set(["resume_score"]));
  assert.deepEqual(kept.map((testCase) => testCase.id), ["1", "3"]);
});

test("analyzeMount reports lifted cases and the delta against all-in-one", () => {
  const allInOne = summaryOf([
    { id: "a1", expected: "search", actual: "search", correct: true },
    { id: "a2", expected: "search", actual: "wiki", correct: false },
    { id: "n1", expected: null, actual: null, correct: true }
  ]);
  const mounted = summaryOf([
    { id: "a1", expected: "search", actual: "search", correct: true },
    { id: "a2", expected: "search", actual: "search", correct: true },
    { id: "n1", expected: null, actual: null, correct: true }
  ]);
  const entry = analyzeMount({ name: "search", tools: ["search"] }, mounted, allInOne);

  assert.equal(entry.cases, 3);
  assert.equal(entry.reviewed, 3);
  assert.equal(entry.mountedTools, 1);
  assert.equal(Math.round(entry.mounted.selectionAccuracy * 3), 3);
  assert.equal(Math.round(entry.allInOne.selectionAccuracy * 3), 2);
  assert.equal(Math.round(entry.delta.selection * 100), 33);
  assert.deepEqual(
    entry.lifted.map((item) => [item.id, item.before, item.after]),
    [["a2", "wiki", "search"]]
  );
  assert.deepEqual(entry.jammed, []);

  const totals = modelTotals([entry]);
  assert.deepEqual([totals.reviewed, totals.mountedCorrect, totals.allCorrect], [3, 3, 2]);
  const text = formatProfileReport({
    hash: "abc",
    groups: [{ name: "search" }],
    warnings: [],
    models: [{ model: "mock", profiles: [entry], totals }]
  });
  assert.match(text, /search/);
  assert.match(text, /\+33pp/);
});

test("analyzeMount does not count provider errors as jammed", () => {
  const allInOne = summaryOf([
    { id: "a1", expected: "search", actual: "search", correct: true },
    { id: "a2", expected: "search", actual: "wiki", correct: false },
    { id: "a3", expected: "search", actual: "search", correct: true }
  ]);
  const mounted = summaryOf([
    { id: "a1", expected: "search", actual: "search", correct: true },
    { id: "a2", expected: "search", actual: "search", correct: true },
    { id: "a3", expected: "search", actual: "search", correct: true, error: "timeout after 60000ms" }
  ]);
  const entry = analyzeMount({ name: "search", tools: ["search"] }, mounted, allInOne);

  assert.equal(entry.reviewed, 2);
  assert.equal(entry.errors, 1);
  assert.equal(entry.mounted.selectionAccuracy, 1);
  assert.deepEqual(entry.jammed, []);
  assert.deepEqual(entry.lifted.map((item) => item.id), ["a2"]);

  const totals = modelTotals([entry]);
  assert.equal(totals.errors, 1);
  assert.equal(totals.reviewed, 2);
});

test("--profile scores each group against its own mounted toolset", async () => {
  const { io, lines } = capture();
  const code = await runEval(baseOptions({ profiles: ["all"] }), io);
  assert.equal(code, 0);

  const report = JSON.parse(lines.join("\n")).profiles;
  assert.equal(report.groups.length, 2);
  assert.deepEqual(report.groups.map((group) => group.name), ["screening", "offer"]);
  assert.deepEqual(report.groups.map((group) => group.cases), [8, 9]);
  assert.deepEqual(report.groups.map((group) => group.tools), [2, 2]);
  assert.match(report.hash, /^[0-9a-f]{16}$/);

  const model = report.models[0];
  assert.equal(model.model, "mock");
  assert.equal(model.profiles.length, 2);
  assert.equal(model.profiles[0].mountedTools, 2);
  assert.ok(model.profiles[0].mounted.selectionAccuracy !== null);
  assert.ok(model.profiles[0].allInOne.selectionAccuracy !== null);
  assert.equal(model.totals.reviewed, 17);
  assert.ok(model.totals.mountedCorrect <= 17);
  assert.ok(model.profiles[0].usage.inputTokens > 0);
  assert.equal(model.profiles[0].usage.estimated, true);
  assert.equal(
    model.totals.usage.inputTokens,
    model.profiles.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)
  );
  assert.ok(model.totals.usage.costCny >= 0);
});

test("--profile can run a subset and rejects unknown groups", async () => {
  const { io, lines } = capture();
  await runEval(baseOptions({ profiles: ["offer"] }), io);
  const report = JSON.parse(lines.join("\n")).profiles;
  assert.deepEqual(report.groups.map((group) => group.name), ["offer"]);
  assert.equal(report.models[0].totals.reviewed, 9);

  await assert.rejects(() => runEval(baseOptions({ profiles: ["zzz"] }), capture().io), /unknown profile/);
});

test("--profile honours --repeat and exposes per-group stability", async () => {
  const { io, lines } = capture();
  await runEval(baseOptions({ profiles: ["offer"], repeat: 2 }), io);
  const payload = JSON.parse(lines.join("\n"));
  const entry = payload.profiles.models[0].profiles[0];
  assert.equal(entry.stability.runs, 2);
  assert.deepEqual(entry.stability.unstable, []);
  assert.equal(payload.models[0].stability.runs, 2);
});
