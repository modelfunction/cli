import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "local", "stability-watch.mjs");

async function writeCards(dir, outcomes) {
  for (const [index, rows] of outcomes.entries()) {
    const card = {
      environment: { generatedAt: `2026-11-${String(10 + index).padStart(2, "0")}T00:00:00Z` },
      models: [
        {
          model: "m",
          rows: rows.map(([id, correct]) => ({
            id,
            reviewed: true,
            selectionCorrect: correct,
            error: null
          }))
        }
      ]
    };
    await writeFile(join(dir, `scorecard.202611${String(10 + index).padStart(2, "0")}-000000.json`), JSON.stringify(card));
  }
}

test("stability-watch escalates direction changes, not chronic misses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-stability-"));
  try {
    await writeCards(dir, [
      [["flip", true], ["chronic", false], ["stable", true]],
      [["flip", true], ["chronic", false], ["stable", true]],
      [["flip", false], ["chronic", false], ["stable", true]],
      [["flip", false], ["chronic", false], ["stable", true]]
    ]);
    const run = spawnSync(process.execPath, [script, "--dir", dir, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(run.stdout);
    const model = report.models.find((entry) => entry.model === "m");
    assert.deepEqual(model.alerts, [
      { id: "flip", before: "ok", after: "miss", beforeRuns: "2/2", afterRuns: "0/2" }
    ]);
    assert.deepEqual(model.chronic, [{ id: "chronic", direction: "miss", runs: 4 }]);
    assert.ok(!model.alerts.some((entry) => entry.id === "chronic"));
    assert.ok(!model.alerts.some((entry) => entry.id === "stable"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stability-watch exits 0 when nothing changes direction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-stability-"));
  try {
    await writeCards(dir, [
      [["chronic", false]],
      [["chronic", false]],
      [["chronic", false]]
    ]);
    const run = spawnSync(process.execPath, [script, "--dir", dir], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /chronic: m\/chronic/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
