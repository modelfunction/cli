// Golden corpus for the static engine. The fixtures are tool/skill inventories
// extracted from open-source agent repos; the expected files freeze what lint,
// cluster and check() make of them so a rule tweak cannot silently move real
// reports. Regenerate intentionally: npm run golden:update.
import { realpathSync } from "node:fs";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSuite } from "../lib/lint.js";
import { clusterTools } from "../lib/cluster.js";
import { check } from "../lib/check.js";

const goldenRoot = fileURLToPath(new URL("../test/golden/", import.meta.url));

export async function buildGolden() {
  const suitesDir = join(goldenRoot, "suites");
  const files = (await readdir(suitesDir)).filter((name) => name.endsWith(".json")).sort();
  const suites = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(suitesDir, file), "utf8"));
    suites.push(digestSuite(file, normalizeSuite(raw)));
  }
  return { suites, checks: await digestChecks() };
}

function normalizeSuite(raw) {
  const tools = (raw.tools ?? []).map((tool) => ({
    ...tool,
    parameters: tool.parameters ?? tool.input ?? { type: "object", properties: {} }
  }));
  const skills = (raw.skills ?? []).map((skill) =>
    typeof skill === "string" ? { name: skill, description: "" } : skill
  );
  return { tools, skills, profiles: raw.profiles ?? null };
}

function digestSuite(file, suite) {
  const report = lintSuite({ tools: suite.tools, skills: suite.skills, profiles: suite.profiles });
  const byCode = {};
  for (const finding of report.findings) {
    const key = `${finding.severity}:${finding.code}`;
    byCode[key] = (byCode[key] ?? 0) + 1;
  }
  const cluster = clusterTools(suite.tools);
  return {
    suite: file.replace(/\.suite\.json$/, ""),
    counts: { tools: suite.tools.length, skills: suite.skills.length },
    lint: {
      byCode: Object.fromEntries(Object.entries(byCode).sort(([a], [b]) => a.localeCompare(b))),
      actions: report.findings
        .filter((finding) => finding.severity !== "info")
        .map(actionKey)
        .sort()
    },
    cluster: {
      clusters: cluster.clusters.map((item) => ({ label: item.label, tools: item.tools })),
      riskyPairs: cluster.riskyPairs.map((pair) => ({
        a: pair.a,
        b: pair.b,
        similarity: pair.similarity,
        basis: pair.basis
      })),
      familyHints: cluster.familyHints.map((hint) => ({
        token: hint.token,
        size: hint.size,
        merged: hint.merged,
        loose: hint.loose
      })),
      boundaries: cluster.boundaries.map((family) => ({
        label: family.label,
        size: family.size,
        tools: family.tools,
        axes: family.axes,
        sharedParams: family.sharedParams,
        pairs: family.pairs
      }))
    }
  };
}

function actionKey(finding) {
  const subject = finding.kind === "skill" ? finding.skill : finding.tool;
  const other = Array.isArray(finding.pair) ? finding.pair.find((name) => name !== subject) : null;
  const param = finding.param ? `.${finding.param}` : "";
  const pair = other ? ` × ${other}` : "";
  return `${finding.severity} ${finding.code} ${subject}${param}${pair}`;
}

async function digestChecks() {
  let entries;
  try {
    entries = JSON.parse(await readFile(join(goldenRoot, "checks.json"), "utf8"));
  } catch {
    return [];
  }
  return entries.map((entry) => {
    const result = check({ manifest: entry.manifest, installed: entry.installed });
    return {
      name: entry.name,
      verdict: result.verdict,
      summary: result.summary,
      family: result.family ?? [],
      findings: result.findings.map((finding) => {
        const param = finding.param ? `.${finding.param}` : "";
        const withWhat = finding.with ? ` × ${finding.with}` : "";
        return `${finding.severity} ${finding.code} ${finding.subject}${param}${withWhat}`;
      })
    };
  });
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  const update = process.argv.includes("--update");
  const result = await buildGolden();
  if (!update) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const expectedDir = join(goldenRoot, "expected");
    await mkdir(expectedDir, { recursive: true });
    for (const report of result.suites) {
      await writeFile(join(expectedDir, `${report.suite}.json`), `${JSON.stringify(report, null, 2)}\n`);
    }
    await writeFile(join(expectedDir, "checks.json"), `${JSON.stringify(result.checks, null, 2)}\n`);
    process.stdout.write(`golden updated: ${result.suites.length} suites, ${result.checks.length} checks\n`);
  }
}
