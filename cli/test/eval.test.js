import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "../mf.js";
import { loadSuite } from "../lib/suite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(HERE, "../fixtures/suite.json");
const MODELS = resolve(HERE, "../fixtures/models.json");

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
    showCases: false,
    json: true,
    out: null,
    failUnder: null,
    ...overrides
  };
}

test("fixture suite loads with refs and validates cases", async () => {
  const suite = await loadSuite(SUITE);
  assert.equal(suite.tools.length, 4);
  assert.equal(suite.tools[0].name, "resume_score");
  assert.ok(suite.tools[0].source.endsWith("resume_score.json"));
  assert.equal(suite.cases.length, 13);
  assert.ok(suite.cases.some((testCase) => testCase.expectedTool === null));
});

test("suite cases accept exclusion flags and reject non-boolean values", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-exclude-"));
  try {
    const suitePath = join(root, "suite.json");
    const base = {
      name: "exclude",
      tools: [{ name: "search", description: "Search the web", parameters: { type: "object", properties: {} } }],
      cases: [{ id: "n", input: "hello", expectedTool: null, excludeFromBase: true, excludeFromProfiles: true }]
    };
    await writeFile(suitePath, JSON.stringify(base), "utf8");
    const suite = await loadSuite(suitePath);
    assert.equal(suite.cases[0].excludeFromBase, true);
    assert.equal(suite.cases[0].excludeFromProfiles, true);

    base.cases[0].excludeFromBase = "yes";
    await writeFile(suitePath, JSON.stringify(base), "utf8");
    await assert.rejects(() => loadSuite(suitePath), /excludeFromBase.*boolean/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mock baseline produces a stable scorecard", async () => {
  const { io } = capture();
  const code = await runEval(baseOptions(), io);
  assert.equal(code, 0);

  const { io: jsonIo, lines } = capture();
  await runEval(baseOptions(), jsonIo);
  const payload = JSON.parse(lines.join("\n"));
  const summary = payload.models[0];

  assert.equal(payload.suite.name, "recruiting-agent");
  assert.equal(payload.profiles, undefined);
  assert.equal(payload.suite.tools.length, 4);
  assert.equal(summary.model, "mock");
  assert.equal(summary.total, 13);
  assert.equal(summary.errors, 0);
  assert.equal(Math.round(summary.selectionAccuracy * 13), 11);
  assert.equal(Math.round(summary.argAccuracy * 17), 10);
  assert.equal(Math.round(summary.passRate * 13), 7);
  assert.equal(summary.rows.find((row) => row.id === "n01").actualTool, null);
  assert.equal(summary.rows.find((row) => row.id === "x01").actualTool, "salary_band");
});

test("--case filters the run and unknown ids throw", async () => {
  const { io, lines } = capture();
  await runEval(baseOptions({ cases: ["r01", "n01"] }), io);
  const payload = JSON.parse(lines.join("\n"));
  assert.equal(payload.models[0].total, 2);
  assert.equal(payload.models[0].selectionAccuracy, 1);

  await assert.rejects(() => runEval(baseOptions({ cases: ["nope"] }), capture().io), /unknown case ids/);
});

test("--fail-under returns exit code 2 below threshold", async () => {
  const { io, errors } = capture();
  const code = await runEval(baseOptions({ failUnder: 0.95 }), io);
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /below threshold/);

  const ok = await runEval(baseOptions({ failUnder: 0.5 }), capture().io);
  assert.equal(ok, 0);
});

test("model registry exposes the expected ids with pricing", async () => {
  const registry = JSON.parse(await readFile(MODELS, "utf8"));
  for (const id of ["mock", "deepseek", "qwen", "glm", "openai"]) {
    assert.ok(registry[id], `missing model ${id}`);
  }
  assert.equal(registry.mock.type, "mock");
  assert.equal(registry.deepseek.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.ok(registry.deepseek.pricing.input > 0);
});

test("--repeat scores the majority and records stability", async () => {
  const { io, lines } = capture();
  const code = await runEval(baseOptions({ repeat: 3 }), io);
  assert.equal(code, 0);
  const summary = JSON.parse(lines.join("\n")).models[0];
  assert.equal(summary.stability.runs, 3);
  assert.deepEqual(summary.stability.unstable, []);
  assert.equal(summary.total, 13);
});

test("--progress writes per-case progress to stderr", async () => {
  const { io, errors } = capture();
  const code = await runEval(baseOptions({ progress: true }), io);
  assert.equal(code, 0);
  assert.match(errors.join("\n"), /\[mock\] 13\/13/);
  assert.match(errors.join("\n"), /\[mock\] 2\/13/);
});

test("--max-tokens stops the run and returns exit code 2", async () => {
  const { io, errors } = capture();
  const code = await runEval(baseOptions({ maxTokens: 10 }), io);
  assert.equal(code, 2);
  assert.match(errors.join("\n"), /token limit reached/);
  assert.match(errors.join("\n"), /--max-tokens/);
});

test("--max-cost stops the run and returns exit code 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-budget-"));
  const modelsFile = join(dir, "models.json");
  await writeFile(
    modelsFile,
    JSON.stringify({ mock: { type: "mock", pricing: { input: 1_000_000, output: 1_000_000 } } }),
    "utf8"
  );
  try {
    const { io, errors } = capture();
    const code = await runEval(baseOptions({ modelsFile, maxCost: 0.001 }), io);
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /cost limit reached/);
    assert.match(errors.join("\n"), /--max-cost/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
