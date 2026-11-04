import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAblate, runEval } from "../mf.js";
import { loadSuite } from "../lib/suite.js";
import { suiteFingerprint } from "../lib/fingerprint.js";

const HERE = dirname(fileURLToPath(import.meta.url));
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

async function makeSuite(root, tools, cases, name = "t") {
  const suitePath = join(root, "suite.json");
  await writeFile(suitePath, JSON.stringify({ name, tools, cases }, null, 2), "utf8");
  return suitePath;
}

test("ablate detects a distractor tool with the mock adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-ablate-"));
  try {
    const suitePath = await makeSuite(
      root,
      [
        { name: "a", description: "处理文档", parameters: { type: "object", properties: {} } },
        { name: "b", description: "处理文档内容", parameters: { type: "object", properties: {} } }
      ],
      [
        { id: "c1", input: "处理文档内容", expectedTool: "a", expectedArgs: {}, reviewed: true },
        { id: "c2", input: "处理文档内容", expectedTool: "b", expectedArgs: {}, reviewed: true }
      ]
    );

    const { io, lines } = capture();
    const code = await runAblate(
      { suite: suitePath, models: ["mock"], modelsFile: MODELS, tool: "b", cases: null, json: true },
      io
    );
    assert.equal(code, 0);

    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.tool, "b");
    assert.equal(payload.droppedCases, 1);
    const model = payload.models[0];
    assert.equal(model.compared, 1);
    assert.equal(model.improved.length, 1);
    assert.equal(model.improved[0].id, "c1");
    assert.equal(model.verdict, "interference");
    const bucket = model.tools.find((item) => item.tool === "a");
    assert.equal(bucket.fullAccuracy, 0);
    assert.equal(bucket.reducedAccuracy, 1);
    assert.equal(bucket.delta, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ablate rejects unknown tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-ablate-"));
  try {
    const suitePath = await makeSuite(
      root,
      [{ name: "a", description: "处理文档", parameters: { type: "object", properties: {} } }],
      [{ id: "c1", input: "处理文档", expectedTool: "a", expectedArgs: {}, reviewed: true }]
    );
    await assert.rejects(
      () =>
        runAblate(
          { suite: suitePath, models: ["mock"], modelsFile: MODELS, tool: "nope", cases: null, json: true },
          capture().io
        ),
      /unknown tool/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("eval --fail-on-regression exits 2 when a reviewed case regresses", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-regress-"));
  try {
    const suitePath = await makeSuite(
      root,
      [{ name: "a", description: "处理文档", parameters: { type: "object", properties: {} } }],
      [{ id: "c1", input: "帮我处理", expectedTool: "a", expectedArgs: {}, reviewed: true }]
    );
    const suite = await loadSuite(suitePath);
    const baselinePath = join(root, "baseline.json");
    const baseline = {
      suite: {
        name: suite.name,
        path: suite.path,
        tools: suite.tools.map((tool) => tool.name),
        cases: suite.cases.length,
        fingerprint: suiteFingerprint(suite, suite.cases)
      },
      models: [
        {
          model: "mock",
          rows: [
            {
              id: "c1",
              expectedTool: "a",
              actualTool: "a",
              selectionCorrect: true,
              args: { total: 0, matched: 0, failures: [] },
              passed: true,
              reviewed: true,
              latencyMs: 1,
              usage: { input: 1, output: 1 },
              error: null
            }
          ]
        }
      ]
    };
    await writeFile(baselinePath, JSON.stringify(baseline, null, 2), "utf8");

    const { io, errors } = capture();
    const code = await runEval(
      {
        suite: suitePath,
        models: ["mock"],
        modelsFile: MODELS,
        cases: null,
        showCases: false,
        json: true,
        out: null,
        failUnder: null,
        baseline: baselinePath,
        failOnRegression: true
      },
      io
    );
    assert.equal(code, 2);
    assert.match(errors.join("\n"), /regressions: mock\/c1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ablate --profile scopes tools and cases to the mounted group", async () => {
  const lines = [];
  const io = { log: (line) => lines.push(String(line)), error: () => {} };
  const code = await runAblate(
    {
      suite: resolve(HERE, "../fixtures/suite.json"),
      tool: "interview_question",
      profiles: ["screening"],
      models: ["mock"],
      modelsFile: MODELS,
      cases: null,
      json: true
    },
    io
  );
  assert.equal(code, 0);
  const payload = JSON.parse(lines.join("\n"));
  assert.deepEqual(payload.profile, { name: "screening", tools: 2 });
  assert.equal(payload.droppedCases, 2);
  assert.equal(payload.models[0].compared, 6);
  assert.equal(payload.models[0].tools.length, 2);
});

test("ablate --profile rejects tools outside the group and unknown groups", async () => {
  const io = { log: () => {}, error: () => {} };
  const base = {
    suite: resolve(HERE, "../fixtures/suite.json"),
    models: ["mock"],
    modelsFile: MODELS,
    cases: null,
    json: true
  };
  await assert.rejects(
    () => runAblate({ ...base, tool: "salary_band", profiles: ["screening"] }, io),
    /不在组 "screening"/
  );
  await assert.rejects(() => runAblate({ ...base, tool: "salary_band", profiles: ["nope"] }, io), /unknown profile/);
});
