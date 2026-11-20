// Double-annotation agreement for expectedTool labels. Two people label the
// same cases independently; this reports raw agreement and Cohen's kappa, and
// lists the disagreements that need arbitration. No model calls, no network.
import { readFile } from "node:fs/promises";

const NULL_KEY = " null";

function normalizeLabel(value) {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`label must be a tool name or null, got ${typeof value}`);
  }
  return value.trim() === "" ? null : value.trim();
}

function normalizeEntries(raw) {
  if (Array.isArray(raw)) {
    const labels = new Map();
    for (const entry of raw) {
      if (!entry || typeof entry.id !== "string") throw new Error("array entries need { id, expectedTool }");
      const value = Object.prototype.hasOwnProperty.call(entry, "expectedTool")
        ? entry.expectedTool
        : entry.label;
      if (value === undefined) throw new Error(`entry ${entry.id} has no expectedTool`);
      labels.set(entry.id, normalizeLabel(value));
    }
    return labels;
  }
  if (raw && typeof raw === "object") {
    const source = raw.labels && typeof raw.labels === "object" ? raw.labels : raw;
    const labels = new Map();
    for (const [id, value] of Object.entries(source)) {
      labels.set(id, normalizeLabel(value));
    }
    return labels;
  }
  throw new Error("annotations must be an object or an array");
}

export async function loadAnnotations(path) {
  const raw = JSON.parse(await readFile(path, "utf8"));
  const name = typeof raw?.annotator === "string" ? raw.annotator : null;
  return { path, name, labels: normalizeEntries(raw) };
}

function keyOf(label) {
  return label === null ? NULL_KEY : label;
}

export function computeAgreement(first, second, { suiteIds = null } = {}) {
  const a = first.labels;
  const b = second.labels;
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  const onlyA = ids.filter((id) => a.has(id) && !b.has(id));
  const onlyB = ids.filter((id) => b.has(id) && !a.has(id));
  const paired = ids.filter((id) => a.has(id) && b.has(id));

  const countsA = new Map();
  const countsB = new Map();
  const disagreements = [];
  let agree = 0;

  for (const id of paired) {
    const va = a.get(id);
    const vb = b.get(id);
    countsA.set(keyOf(va), (countsA.get(keyOf(va)) ?? 0) + 1);
    countsB.set(keyOf(vb), (countsB.get(keyOf(vb)) ?? 0) + 1);
    if (va === vb) agree += 1;
    else disagreements.push({ id, a: va, b: vb });
  }

  const n = paired.length;
  const agreementRate = n > 0 ? agree / n : null;
  let kappa = null;
  if (n > 0) {
    const categories = new Set([...countsA.keys(), ...countsB.keys()]);
    let expected = 0;
    for (const category of categories) {
      expected += ((countsA.get(category) ?? 0) / n) * ((countsB.get(category) ?? 0) / n);
    }
    if (expected < 1) kappa = (agreementRate - expected) / (1 - expected);
  }

  const warnings = [];
  if (onlyA.length > 0) warnings.push(`只在 ${first.name ?? "A"} 中标注：${onlyA.join(", ")}`);
  if (onlyB.length > 0) warnings.push(`只在 ${second.name ?? "B"} 中标注：${onlyB.join(", ")}`);
  if (onlyA.length > 0 || onlyB.length > 0) {
    warnings.push("这些用例没有双判，不计入一致性；补齐后再跑");
  }

  const unknownIds = [];
  const missingFromSuite = [];
  if (suiteIds) {
    const suiteSet = new Set(suiteIds);
    for (const id of ids) if (!suiteSet.has(id)) unknownIds.push(id);
    for (const id of suiteSet) if (!a.has(id) && !b.has(id)) missingFromSuite.push(id);
    if (missingFromSuite.length > 0) warnings.push(`${missingFromSuite.length} 条套件用例两边都没标注：${missingFromSuite.join(", ")}`);
    if (unknownIds.length > 0) warnings.push(`${unknownIds.length} 个标注 id 不在套件里：${unknownIds.join(", ")}`);
  }

  return {
    annotations: { a: first.name ?? null, b: second.name ?? null },
    paired: n,
    agree,
    agreementRate,
    kappa,
    disagreements,
    onlyA,
    onlyB,
    unknownIds,
    missingFromSuite,
    warnings
  };
}

export function formatAgreement(report) {
  const a = report.annotations.a ?? "A";
  const b = report.annotations.b ?? "B";
  const lines = [`annotations: ${a} × ${b}`];
  if (report.paired === 0) {
    lines.push("paired 0 · 两份标注没有共同 id，无法计算一致性");
  } else {
    const rate = `${(report.agreementRate * 100).toFixed(1)}%`;
    const kappa = report.kappa === null ? "undefined" : report.kappa.toFixed(2);
    lines.push(`paired ${report.paired} · agree ${report.agree} · rate ${rate} · kappa ${kappa}`);
  }
  if (report.disagreements.length > 0) {
    lines.push(`disagreements: ${report.disagreements.length}`);
    for (const item of report.disagreements) {
      lines.push(`  ${item.id}: ${a}=${item.a ?? "(no-call)"} ≠ ${b}=${item.b ?? "(no-call)"}`);
    }
  }
  for (const warning of report.warnings) lines.push(`warn: ${warning}`);
  return lines.join("\n");
}
