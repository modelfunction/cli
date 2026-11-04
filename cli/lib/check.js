// Install-gate entry point: judge new capabilities against what is already
// installed. Static only — no model call, no network, no file system, no state.
// Quality findings are advisory: the verdict is pass/warn, never "block".
import { lintSuite } from "./lint.js";

export function check({ manifest, installed = [] } = {}) {
  const target = normalizeEntry(manifest);
  if (!target) throw new Error('check: manifest 需要非空 "name"');
  const { results } = evaluateTargets([target], installed);
  const [result] = results;
  return {
    verdict: result.verdict,
    summary: result.summary,
    findings: result.findings,
    ...(result.family ? { family: result.family } : {})
  };
}

// Installers usually apply a pack at once: new skills must be checked against
// installed ones AND against each other.
export function checkMany({ manifests, installed = [] } = {}) {
  if (!Array.isArray(manifests) || manifests.length === 0) {
    throw new Error("checkMany: manifests 需要非空数组");
  }
  const targets = manifests.map((entry) => normalizeEntry(entry));
  if (targets.some((target) => target === null)) {
    throw new Error('checkMany: 每个 manifest 都需要非空 "name"');
  }
  const names = new Set();
  for (const target of targets) {
    if (names.has(target.name)) throw new Error(`checkMany: duplicate name "${target.name}"`);
    names.add(target.name);
  }
  const { results } = evaluateTargets(targets, installed);
  return {
    verdict: results.some((item) => item.verdict === "warn") ? "warn" : "pass",
    summary: uniqueSummary(results),
    items: results.length,
    results
  };
}

// A gate that silently ignores a mis-shaped `installed` returns a false pass —
// the worst failure mode for an install check. Accept the array and
// {tools,skills} forms, plus `mf scan --json` output (wrapped in `report`);
// anything else non-empty is an input error.
function installedPool(installed) {
  if (installed == null) return [];
  if (Array.isArray(installed)) return installed;
  if (typeof installed !== "object") {
    throw new Error("installed 需要能力数组、{ tools, skills } 或 mf scan --json 的 report");
  }
  if (Object.keys(installed).length === 0) return [];
  const source =
    installed.report && typeof installed.report === "object" ? installed.report : installed;
  const tools = source.tools ?? [];
  const skills = source.skills ?? [];
  if (!Array.isArray(tools) || !Array.isArray(skills)) {
    throw new Error("installed.tools / installed.skills 必须是数组");
  }
  if (!Array.isArray(source.tools) && !Array.isArray(source.skills)) {
    throw new Error("installed 需要能力数组、{ tools, skills } 或 mf scan --json 的 report");
  }
  return [...tools, ...skills];
}

function evaluateTargets(targets, installed) {
  const pool = installedPool(installed);
  const entries = pool.map(normalizeEntry).filter(Boolean);

  const tools = [];
  const skills = [];
  for (const entry of entries) (isToolLike(entry) ? tools : skills).push(entry);
  for (const target of targets) (isToolLike(target) ? tools : skills).push(target);

  // The gate only reports findings touching the new capabilities; skipping
  // installed × installed pairs keeps a 500-capability pool linear-ish.
  const pairScope = new Set(targets.map((target) => target.name));
  const report = lintSuite({ tools, skills }, { pairScope });
  const pairFindings = report.findings.filter((finding) => finding.pair);
  const results = targets.map((target) => {
    const findings = report.findings
      .filter((finding) => touches(finding, target.name))
      .map((finding) => shape(finding, target.name));
    const summary = { error: 0, warn: 0, info: 0 };
    for (const finding of findings) summary[finding.severity] += 1;
    const family = familyOf(pairFindings, target.name);
    return {
      name: target.name,
      verdict: summary.error + summary.warn > 0 ? "warn" : "pass",
      summary,
      findings,
      ...(family.length > 1 ? { family } : {})
    };
  });
  return { results };
}

// A pair finding touches both items, so the batch summary is deduped by
// subject/with; per-item summaries keep the same finding under each item.
function uniqueSummary(results) {
  const seen = new Map();
  for (const result of results) {
    for (const finding of result.findings) {
      const key = [
        finding.code,
        finding.severity,
        finding.subject,
        finding.with ?? "",
        finding.param ?? ""
      ].join("|");
      if (!seen.has(key)) seen.set(key, finding);
    }
  }
  const summary = { error: 0, warn: 0, info: 0 };
  for (const finding of seen.values()) summary[finding.severity] += 1;
  return summary;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const parameters = entry.parameters ?? entry.inputSchema ?? entry.input ?? null;
  return {
    name,
    description: typeof entry.description === "string" ? entry.description : "",
    // Scan marks descriptions assembled at runtime; without this the gate
    // treats every Claude-Code-style tool as "description missing".
    ...(typeof entry.descriptionSource === "string"
      ? { descriptionSource: entry.descriptionSource }
      : {}),
    parameters: parameters && typeof parameters === "object" ? parameters : null
  };
}

// A capability with a parameter schema is a tool; name + description alone is
// a prompt-injected skill (SKILL.md form).
function isToolLike(entry) {
  return entry.parameters !== null;
}

function touches(finding, name) {
  if (finding.kind === "skill") {
    if (finding.skill === name) return true;
    return Array.isArray(finding.pair) && finding.pair.includes(name);
  }
  if (finding.tool === name) return true;
  return Array.isArray(finding.pair) && finding.pair.includes(name);
}

// An install gate should only warn about things that change model behavior:
// selection conflicts, unsourceable required params, and hard schema errors.
// Description and naming rules stay informative — otherwise every mature
// gateway tool warns on install and the signal becomes noise.
const GATE_CRITICAL_CODES = new Set([
  "desc-missing",
  "param-type-missing",
  "required-unsourced",
  "pair-no-boundary",
  "skill-pair-no-boundary"
]);

function shape(finding, name) {
  const other = (finding.pair ?? []).find((item) => item !== name);
  return {
    severity: GATE_CRITICAL_CODES.has(finding.code) ? finding.severity : "info",
    code: finding.code,
    subject: name,
    ...(finding.param ? { param: finding.param } : {}),
    ...(other ? { with: other } : {}),
    message: finding.message,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {})
  };
}

// The connected family around the manifest — what an installer shows as
// "these installed capabilities compete with the new one".
function familyOf(pairs, name) {
  const edges = new Map();
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a).add(b);
  };
  for (const finding of pairs) {
    const [a, b] = finding.pair;
    link(a, b);
    link(b, a);
  }
  if (!edges.has(name)) return [name];
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const next of edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return [...seen].sort();
}

function findingLines(finding) {
  const param = finding.param ? `.${finding.param}` : "";
  const withWhat = finding.with ? ` × ${finding.with}` : "";
  const lines = [
    `[${finding.severity}] ${finding.code}  ${finding.subject}${param}${withWhat}`,
    `        ${finding.message}`
  ];
  if (finding.suggestion) lines.push(`        ${finding.suggestion}`);
  return lines;
}

export function formatCheck(result) {
  const lines = [
    `verdict: ${result.verdict}（error ${result.summary.error} / warn ${result.summary.warn} / info ${result.summary.info}）`
  ];
  if (result.findings.length === 0) lines.push("没有发现问题");
  for (const finding of result.findings) lines.push(...findingLines(finding));
  if (result.family) lines.push("", `族：${result.family.join(", ")}`);
  return lines.join("\n");
}

export function formatCheckMany(result) {
  const lines = [
    `verdict: ${result.verdict}（${result.items} 个新能力；去重后 error ${result.summary.error} / warn ${result.summary.warn} / info ${result.summary.info}）`
  ];
  result.results.forEach((item, index) => {
    lines.push(
      "",
      `[${index + 1}] ${item.name}  ${item.verdict}（error ${item.summary.error} / warn ${item.summary.warn} / info ${item.summary.info}）`
    );
    if (item.findings.length === 0) lines.push("    没有发现问题");
    for (const finding of item.findings) {
      for (const line of findingLines(finding)) lines.push(`    ${line}`);
    }
    if (item.family) lines.push(`    族：${item.family.join(", ")}`);
  });
  return lines.join("\n");
}
