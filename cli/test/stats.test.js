import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareScorecards, formatCompare, regressionGate } from "../lib/compare.js";
import { runCompare } from "../mf.js";

function row(id, { selectionCorrect = true, passed = true } = {}) {
  return {
    id,
    expectedTool: "a",
    actualTool: selectionCorrect ? "a" : "b",
    selectionCorrect,
    args: { total: 1, matched: passed ? 1 : 0, failures: passed ? [] : ["x"] },
    passed,
    reviewed: true,
    latencyMs: 1,
    usage: { input: 1, output: 1 },
    error: null
  };
}

function card({ rows, unstable = null }) {
  return {
    suite: {
      fingerprint: {
        hash: "same",
        tools: [{ name: "a", hash: "t1" }],
        cases: rows.map((entry) => ({ id: entry.id, hash: `h-${entry.id}` }))
      }
    },
    models: [
      {
        model: "m",
        rows,
        ...(unstable ? { stability: { runs: 3, unstable: unstable.map((id) => ({ id, outcomes: [] })) } } : {})
      }
    ]
  };
}

function flippedCard(ids, flipped) {
  return card({
    rows: ids.map((id) => row(id, { selectionCorrect: !flipped.includes(id), passed: !flipped.includes(id) }))
  });
}

function environment(hash) {
  return {
    mfVersion: "0.10.0",
    node: "v24.6.0",
    os: "win32-x64",
    generatedAt: "2026-11-14T00:00:00.000Z",
    modelsFileHash: hash,
    sampling: { repeat: 1, retries: 2, minIntervalMs: 0 },
    unknown: []
  };
}

test("McNemar threshold: 5 one-way flips is not significant; 18 discordant needs 6", () => {
  const ids = Array.from({ length: 18 }, (_, index) => `c${index + 1}`);
  const five = compareScorecards(flippedCard(ids, []), flippedCard(ids, ids.slice(0, 5))).models[0];
  assert.equal(five.stats.pairedSelection.discordant, 5);
  assert.equal(five.stats.pairedSelection.requiredSameDirection, null);
  assert.ok(five.stats.pairedSelection.pValue > 0.05);

  const oneWaySix = compareScorecards(flippedCard(ids, []), flippedCard(ids, ids.slice(0, 6))).models[0];
  assert.equal(oneWaySix.stats.pairedSelection.discordant, 6);
  assert.equal(oneWaySix.stats.pairedSelection.requiredSameDirection, 6);
  assert.ok(oneWaySix.stats.pairedSelection.pValue < 0.05);

  const mixed = card({
    rows: ids.map((id, index) =>
      row(id, {
        selectionCorrect: index < 12 ? true : false,
        passed: index < 12 ? true : false
      })
    )
  });
  const mixedAfter = card({
    rows: ids.map((id, index) =>
      row(id, {
        selectionCorrect: index < 12 ? false : true,
        passed: index < 12 ? false : true
      })
    )
  });
  const report = compareScorecards(mixed, mixedAfter);
  assert.equal(report.models[0].stats.pairedSelection.discordant, 18);
  assert.equal(report.models[0].stats.pairedSelection.requiredSameDirection, 6);
  assert.ok(report.models[0].stats.pairedSelection.pValue > 0.05, "12 vs 6 is not significant");
  assert.match(formatCompare(report), /McNemar/);
});

test("independent-design MDE uses the reviewed case count", () => {
  const fifteen = Array.from({ length: 15 }, (_, index) => `c${index + 1}`);
  const eighteen = Array.from({ length: 18 }, (_, index) => `c${index + 1}`);
  const at15 = compareScorecards(flippedCard(fifteen, []), flippedCard(fifteen, [])).models[0];
  const at18 = compareScorecards(flippedCard(eighteen, []), flippedCard(eighteen, [])).models[0];
  assert.equal(Math.round(at15.stats.independentMde.delta * 100), 51);
  assert.equal(Math.round(at18.stats.independentMde.delta * 100), 47);
  assert.equal(at15.stats.independentMde.n, 15);
});

test("flips inside stability.unstable become warnings, not regressions", () => {
  const ids = ["s1", "u1"];
  const before = card({ rows: ids.map((id) => row(id)), unstable: ["u1"] });
  const after = card({
    rows: [row("s1", { selectionCorrect: false, passed: false }), row("u1", { selectionCorrect: false, passed: false })],
    unstable: ["u1"]
  });
  const model = compareScorecards(before, after).models[0];
  assert.deepEqual(model.regressions.map((entry) => entry.id), ["s1"]);
  assert.deepEqual(model.unstableFlips.map((entry) => entry.id), ["u1"]);
  assert.equal(model.reviewed, 2, "unstable flips still count toward metrics");

  const gate = regressionGate(compareScorecards(before, after), []);
  assert.equal(gate.status, "ok");
  assert.deepEqual(gate.regressions, ["m/s1"]);
  assert.deepEqual(gate.warnings, ["m/u1"]);
  assert.match(formatCompare(compareScorecards(before, after)), /不稳定用例翻转（不计入回归门禁）: u1/);
});

test("only unstable flips: gate stays ok, --fail-on-regression exits 0", async () => {
  const ids = ["u1", "u2"];
  const before = card({ rows: ids.map((id) => row(id)), unstable: ids });
  const after = card({
    rows: ids.map((id) => row(id, { selectionCorrect: false, passed: false })),
    unstable: ids
  });
  const gate = regressionGate(compareScorecards(before, after), []);
  assert.equal(gate.status, "ok");
  assert.deepEqual(gate.regressions, []);
  assert.deepEqual(gate.warnings.sort(), ["m/u1", "m/u2"]);

  const dir = await mkdtemp(join(tmpdir(), "mf-stats-"));
  try {
    const beforePath = join(dir, "before.json");
    const afterPath = join(dir, "after.json");
    await writeFile(beforePath, JSON.stringify(before), "utf8");
    await writeFile(afterPath, JSON.stringify(after), "utf8");
    const code = await runCompare(
      { paths: [beforePath, afterPath], json: false, failOnRegression: true },
      { log: () => {}, error: () => {} }
    );
    assert.equal(code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stats are omitted when environments differ", () => {
  const ids = ["c1", "c2"];
  const before = { ...flippedCard(ids, []), environment: environment("sha256:aa") };
  const after = { ...flippedCard(ids, ["c1"]), environment: environment("sha256:bb") };
  const model = compareScorecards(before, after).models[0];
  assert.equal(model.comparable, false);
  assert.equal(model.stats, null);
  assert.doesNotMatch(formatCompare(compareScorecards(before, after)), /McNemar/);
});
