import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAnnotations, computeAgreement, formatAgreement } from "../lib/agreement.js";
import { runAgree } from "../mf.js";

function labels(entries) {
  return { name: null, labels: new Map(entries) };
}

test("agreement reports raw rate and Cohen's kappa", () => {
  const report = computeAgreement(
    labels([["c1", "x"], ["c2", "x"], ["c3", "y"], ["c4", null]]),
    labels([["c1", "x"], ["c2", "y"], ["c3", "y"], ["c4", null]])
  );
  assert.equal(report.paired, 4);
  assert.equal(report.agree, 3);
  assert.equal(report.agreementRate, 0.75);
  assert.ok(Math.abs(report.kappa - 7 / 11) < 1e-9);
  assert.deepEqual(report.disagreements, [{ id: "c2", a: "x", b: "y" }]);
  assert.match(formatAgreement(report), /rate 75\.0% · kappa 0\.64/);
});

test("agreement flags one-sided ids and suite gaps", () => {
  const report = computeAgreement(
    labels([["c1", "x"], ["c2", "y"]]),
    labels([["c1", "x"], ["c3", "z"]]),
    { suiteIds: ["c1", "c2", "c3", "c4"] }
  );
  assert.deepEqual(report.onlyA, ["c2"]);
  assert.deepEqual(report.onlyB, ["c3"]);
  assert.deepEqual(report.missingFromSuite, ["c4"]);
  assert.deepEqual(report.unknownIds, []);
  assert.ok(report.warnings.some((warning) => warning.includes("c4")));
});

test("loadAnnotations accepts wrapped labels and array entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-agree-"));
  try {
    const wrapped = join(root, "a.json");
    const array = join(root, "b.json");
    await writeFile(wrapped, JSON.stringify({ annotator: "alice", labels: { c1: "x", c2: null } }), "utf8");
    await writeFile(
      array,
      JSON.stringify([
        { id: "c1", expectedTool: "x" },
        { id: "c2", expectedTool: null }
      ]),
      "utf8"
    );
    const a = await loadAnnotations(wrapped);
    const b = await loadAnnotations(array);
    assert.equal(a.name, "alice");
    assert.equal(b.name, null);
    assert.deepEqual([...a.labels.entries()], [["c1", "x"], ["c2", null]]);
    assert.deepEqual([...b.labels.entries()], [["c1", "x"], ["c2", null]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runAgree exits 2 below thresholds", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-agree-run-"));
  try {
    const a = join(root, "a.json");
    const b = join(root, "b.json");
    await writeFile(a, JSON.stringify({ labels: { c1: "x", c2: "x" } }), "utf8");
    await writeFile(b, JSON.stringify({ labels: { c1: "x", c2: "y" } }), "utf8");
    const lines = [];
    const io = { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };

    const ok = await runAgree({ aFile: a, bFile: b, json: false, minAgreement: 0, minKappa: null }, io);
    assert.equal(ok, 0);
    assert.ok(lines.some((line) => line.includes("rate 50.0%")));

    const failed = await runAgree({ aFile: a, bFile: b, json: false, minAgreement: 0.8, minKappa: 0.6 }, io);
    assert.equal(failed, 2);
    assert.ok(lines.some((line) => line.startsWith("fail:")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
