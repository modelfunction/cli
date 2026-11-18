import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironment, compareEnvironments } from "../lib/environment.js";
import { compareScorecards, formatCompare, regressionGate } from "../lib/compare.js";
import { runCompare, runEval } from "../mf.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(HERE, "../fixtures/suite.json");
const MODELS = resolve(HERE, "../fixtures/models.json");
const MF = resolve(HERE, "../mf.js");

function environment(overrides = {}) {
  return {
    mfVersion: "0.10.0",
    node: "v24.6.0",
    os: "win32-x64",
    generatedAt: "2026-11-14T00:00:00.000Z",
    modelsFileHash: "sha256:aaaa",
    sampling: { repeat: 1, retry: 2, minIntervalMs: 0 },
    unknown: [],
    ...overrides
  };
}

function row(overrides = {}) {
  return {
    id: "c1",
    expectedTool: "a",
    actualTool: "a",
    selectionCorrect: true,
    args: { total: 1, matched: 1, failures: [] },
    passed: true,
    reviewed: true,
    latencyMs: 1,
    usage: { input: 1, output: 1 },
    error: null,
    ...overrides
  };
}

function scorecard(env, { caseHash = "c1", rows = [row()] } = {}) {
  return {
    suite: {
      fingerprint: {
        hash: `s-${caseHash}`,
        tools: [{ name: "a", hash: "t1" }],
        cases: [{ id: "c1", hash: caseHash }]
      }
    },
    ...(env ? { environment: env } : {}),
    models: [{ model: "m", rows }]
  };
}

async function compareExit(before, after, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mf-env-"));
  try {
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    await writeFile(beforePath, JSON.stringify(before), "utf8");
    await writeFile(afterPath, JSON.stringify(after), "utf8");
    const lines = [];
    const errors = [];
    const code = await runCompare(
      { paths: [beforePath, afterPath], json: false, ...options },
      { log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) }
    );
    return { code, lines, errors };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildEnvironment hashes the registry bytes and reports unknown fields honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-env-build-"));
  try {
    const first = join(dir, "models-a.json");
    const second = join(dir, "models-b.json");
    await writeFile(first, '{"mock":{"type":"mock"}}', "utf8");
    await writeFile(second, '{"mock":{"type":"mock"},"m2":{"type":"mock"}}', "utf8");

    const envA = await buildEnvironment({ modelsFile: first, version: "0.10.0" });
    const envB = await buildEnvironment({ modelsFile: second, version: "0.10.0" });
    const expected = createHash("sha256").update('{"mock":{"type":"mock"}}').digest("hex");
    assert.equal(envA.modelsFileHash, `sha256:${expected}`);
    assert.match(envA.modelsFileHash, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(envA.modelsFileHash, envB.modelsFileHash);
    assert.equal(envA.mfVersion, "0.10.0");
    assert.equal(envA.generatedAt, new Date(envA.generatedAt).toISOString());
    assert.deepEqual(envA.unknown, []);

    const missing = await buildEnvironment({ modelsFile: join(dir, "nope.json"), version: null });
    assert.equal(missing.modelsFileHash, null);
    assert.deepEqual(missing.unknown.sort(), ["mfVersion", "modelsFileHash"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareEnvironments: same, modelsFileHash differs, cross-env, missing block, unknown", () => {
  const same = compareEnvironments(environment(), environment({ generatedAt: "2027-01-01T00:00:00.000Z" }));
  assert.equal(same.comparable, true);
  assert.deepEqual(same.differences, [], "generatedAt must not make scorecards incomparable");

  const differs = compareEnvironments(environment(), environment({ modelsFileHash: "sha256:bbbb" }));
  assert.equal(differs.comparable, false);
  assert.deepEqual(differs.differences.map((entry) => entry.field), ["modelsFileHash"]);

  const forced = compareEnvironments(
    environment(),
    environment({ modelsFileHash: "sha256:bbbb" }),
    { crossEnv: true }
  );
  assert.equal(forced.comparable, true);
  assert.equal(forced.crossEnv, true);
  assert.equal(forced.differences.length, 1);

  const missingOne = compareEnvironments(environment(), undefined);
  assert.equal(missingOne.comparable, true);
  assert.equal(missingOne.warnings.length, 1);
  assert.match(missingOne.warnings[0], /无环境信息/);

  const missingBoth = compareEnvironments(undefined, undefined);
  assert.equal(missingBoth.comparable, true);
  assert.equal(missingBoth.warnings.length, 1);
  assert.match(missingBoth.warnings[0], /两份报告都无环境信息/);

  const unknown = compareEnvironments(
    environment(),
    environment({ modelsFileHash: null, unknown: ["modelsFileHash"] })
  );
  assert.equal(unknown.comparable, true);
  assert.deepEqual(unknown.differences, []);
  assert.deepEqual(unknown.unknown, [{ field: "modelsFileHash", before: false, after: true }]);

  const sampling = compareEnvironments(environment(), environment({ sampling: { repeat: 3, retry: 2, minIntervalMs: 0 } }));
  assert.equal(sampling.comparable, false);
  assert.deepEqual(sampling.differences.map((entry) => entry.field), ["sampling"]);

  // 0.10–0.11.3 cards emitted the legacy names; they stay comparable.
  const legacy = compareEnvironments(
    environment({ sampling: { repeat: 1, retries: 2, minInterval: 0 } }),
    environment()
  );
  assert.equal(legacy.comparable, true);
  assert.deepEqual(legacy.differences, []);
});

test("E1/E2/E3: modelsFileHash mismatch is not comparable unless --cross-env", async () => {
  const before = scorecard(environment());
  const after = scorecard(environment({ modelsFileHash: "sha256:bbbb" }));

  const report = compareScorecards(before, after);
  assert.equal(report.environment.comparable, false);
  assert.equal(report.models[0].comparable, false);
  assert.equal(report.models[0].reason, "环境不一致");
  assert.match(formatCompare(report), /environment: 不一致（modelsFileHash）/);
  assert.match(formatCompare(report), /不可直接比较（环境不一致）/);

  const forced = compareScorecards(before, after, { crossEnv: true });
  assert.equal(forced.environment.comparable, true);
  assert.equal(forced.models[0].comparable, true);
  assert.match(formatCompare(forced), /跨环境比较（强制）/);

  assert.equal((await compareExit(before, after)).code, 1);
  assert.equal((await compareExit(before, after, { crossEnv: true })).code, 0);
});

test("E4/E5/E9: missing or declared-unknown environment stays comparable with visibility", async () => {
  const oldCard = scorecard(null);
  const newCard = scorecard(environment());
  const missing = compareScorecards(oldCard, newCard);
  assert.equal(missing.environment.comparable, true);
  assert.equal(missing.models[0].comparable, true);
  assert.match(formatCompare(missing), /warn: 至少一份报告无环境信息/);
  assert.equal((await compareExit(oldCard, newCard)).code, 0);

  const bothMissing = compareScorecards(scorecard(null), scorecard(null));
  assert.equal(bothMissing.environment.comparable, true);
  assert.match(formatCompare(bothMissing), /warn: 两份报告都无环境信息/);

  const declaredBefore = scorecard(environment());
  const declaredAfter = scorecard(environment({ modelsFileHash: null, unknown: ["modelsFileHash"] }));
  const declared = compareScorecards(declaredBefore, declaredAfter);
  assert.equal(declared.environment.comparable, true);
  assert.match(formatCompare(declared), /environment unknown \(declared\): modelsFileHash/);
  assert.equal((await compareExit(declaredBefore, declaredAfter)).code, 0);
});

test("E6/E8: case changes still exit 1; environment mismatch makes the gate skip", () => {
  const before = scorecard(environment());
  const caseChanged = scorecard(environment(), { caseHash: "c2" });
  const report = compareScorecards(before, caseChanged);
  assert.equal(report.caseChanges.length, 1);
  assert.equal(report.models[0].comparable, false);

  const gate = regressionGate(
    compareScorecards(before, scorecard(environment({ modelsFileHash: "sha256:bbbb" }))),
    []
  );
  assert.equal(gate.status, "skip");
  assert.match(gate.message, /环境不一致/);

  const forced = regressionGate(
    compareScorecards(before, scorecard(environment({ modelsFileHash: "sha256:bbbb" })), { crossEnv: true }),
    []
  );
  assert.equal(forced.status, "ok");
});

test("E7/E10: eval writes an environment block with generatedAt and modelsFileHash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-env-eval-"));
  try {
    const out = join(dir, "card.json");
    const io = { log: () => {}, error: () => {} };
    const code = await runEval(
      {
        suite: SUITE,
        models: ["mock"],
        modelsFile: MODELS,
        cases: ["r01"],
        showCases: false,
        json: false,
        out,
        failUnder: null,
        repeat: 2
      },
      io
    );
    assert.equal(code, 0);
    const card = JSON.parse(await readFile(out, "utf8"));
    assert.ok(card.environment);
    assert.match(card.environment.mfVersion, /^\d+\.\d+\.\d+/);
    assert.match(card.environment.modelsFileHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(card.environment.generatedAt, new Date(card.environment.generatedAt).toISOString());
    assert.equal(card.environment.sampling.repeat, 2);
    assert.deepEqual(card.environment.unknown, []);

    const expected = createHash("sha256").update(await readFile(MODELS)).digest("hex");
    assert.equal(card.environment.modelsFileHash, `sha256:${expected}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compare warns on unknown flags instead of silently dropping them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-env-flag-"));
  try {
    const beforePath = join(dir, "a.json");
    const afterPath = join(dir, "b.json");
    await writeFile(beforePath, JSON.stringify(scorecard(environment())), "utf8");
    await writeFile(afterPath, JSON.stringify(scorecard(environment())), "utf8");
    const result = spawnSync(process.execPath, [MF, "compare", beforePath, afterPath, "--bogus"], {
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warn: unknown option "--bogus" for compare \(ignored\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
