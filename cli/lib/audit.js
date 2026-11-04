// One static pass over a whole tool set: lint + cluster boundaries + case
// coverage + mount checks. No model calls, no execution, no network.
// The markdown output is meant to be forwarded as a trial deliverable.
import { lintSuite, formatLint } from "./lint.js";
import { clusterTools, formatClusters } from "./cluster.js";
import { computeCoverage, formatCoverage } from "./cases.js";
import { normalizeProfiles, profileWarnings, profileCaseCoverage } from "./profile.js";

export function auditSuite(suite) {
  const lint = lintSuite(suite);
  const clusters = clusterTools(suite.tools);
  const coverage = computeCoverage(suite);
  const profiles = normalizeProfiles(suite.profiles, suite.tools.map((tool) => tool.name));
  const mounted = profiles ? new Set(profiles.flatMap((profile) => profile.tools)) : null;
  const profile = profiles
    ? {
        groups: profileCaseCoverage(profiles, suite.cases),
        warnings: profileWarnings(profiles, suite),
        unmounted: suite.tools.map((tool) => tool.name).filter((name) => !mounted.has(name))
      }
    : null;

  return {
    suite: {
      name: suite.name,
      path: suite.path ?? null,
      tools: suite.tools.length,
      skills: suite.skills?.length ?? 0,
      cases: suite.cases.length,
      reviewed: suite.cases.filter((testCase) => testCase.reviewed !== false).length
    },
    lint: {
      tools: lint.tools,
      skills: lint.skills,
      counts: lint.counts,
      findings: lint.findings,
      profilePairs: lint.profilePairs ?? []
    },
    clusters,
    coverage,
    profiles: profile,
    actions: buildActions({ lint, clusters, coverage, profile })
  };
}

function buildActions({ lint, clusters, coverage, profile }) {
  const actions = [];

  const families = (clusters.boundaries ?? [])
    .filter((family) => family.size > 1)
    .sort((a, b) => b.pairs.length - a.pairs.length)
    .slice(0, 3);
  for (const family of families) {
    actions.push({
      kind: "boundary",
      subject: family.label,
      message: `为「${family.label}」补选择边界（${family.pairs.length} 对互抢）`,
      detail: family.suggestion
    });
  }

  const unsourced = lint.findings.filter((finding) => finding.code === "required-unsourced");
  for (const finding of unsourced.slice(0, 5)) {
    actions.push({
      kind: "param-source",
      subject: `${finding.tool}.${finding.param}`,
      message: `补参数来源：${finding.tool}.${finding.param}`,
      detail: finding.message
    });
  }

  const empty = coverage.tools.filter((tool) => tool.total === 0);
  if (empty.length > 0) {
    actions.push({
      kind: "cases",
      subject: `${empty.length} tools`,
      message: `为 ${empty.length} 个工具补用例`,
      detail: empty.map((tool) => tool.name).join(", ")
    });
  }
  const noArgs = coverage.tools.filter((tool) => tool.total > 0 && tool.withArgs === 0);
  if (noArgs.length > 0) {
    actions.push({
      kind: "args",
      subject: `${noArgs.length} tools`,
      message: `为 ${noArgs.length} 个工具补带参数的用例`,
      detail: noArgs.map((tool) => tool.name).join(", ")
    });
  }
  if (coverage.unreviewed > 0) {
    actions.push({
      kind: "review",
      subject: `${coverage.unreviewed} cases`,
      message: `复核 ${coverage.unreviewed} 条未复核用例（复核后才计入正式分数）`,
      detail: "把认可的用例 reviewed 改为 true"
    });
  }
  if (profile && profile.unmounted.length > 0) {
    actions.push({
      kind: "mount",
      subject: `${profile.unmounted.length} tools`,
      message: `${profile.unmounted.length} 个工具不在任何挂载组`,
      detail: profile.unmounted.join(", ")
    });
  }

  return actions;
}

export function formatAudit(report) {
  const { suite, lint, clusters, coverage, profiles, actions } = report;
  const lines = [
    `# ${suite.name} — 工具集审计`,
    "",
    `- 工具 ${suite.tools} · skills ${suite.skills} · 用例 ${suite.cases}（已复核 ${suite.reviewed}）`,
    `- 文件：${suite.path ?? "(内存)"}`,
    `- 纯静态：不调用模型、不执行工具、无网络`,
    "",
    "## 建议动作"
  ];
  if (actions.length === 0) {
    lines.push("暂无必须处理项。");
  } else {
    actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.message}`);
      if (action.detail) lines.push(`   ${action.detail}`);
    });
  }

  lines.push("", "## 描述与参数（lint）", "", formatLint(lint));
  lines.push("", "## 混淆与分组（cluster）", "", formatClusters(clusters));
  lines.push("", "## 用例覆盖（coverage）", "", formatCoverage(coverage));
  lines.push("", "## 挂载分组（profiles）", "");
  if (!profiles) {
    lines.push("未定义 profiles（平台可先用 `mf cluster --out <suite>` 生成候选分组）。");
  } else {
    lines.push("group                   tools  cases  negatives  neg%  tools-without-cases");
    lines.push("----------------------  -----  -----  ---------  ----  -------------------");
    for (const row of profiles.groups) {
      lines.push(
        `${row.name.padEnd(22)}  ${String(row.tools).padStart(5)}  ${String(row.cases).padStart(5)}  ${String(row.negatives).padStart(9)}  ${`${Math.round((row.negativeRatio ?? 0) * 100)}%`.padStart(4)}  ${row.missing.length ? row.missing.join(", ") : "-"}`
      );
    }
    if (profiles.unmounted.length > 0) lines.push("", `未挂载工具：${profiles.unmounted.join(", ")}`);
    for (const warning of profiles.warnings) lines.push(`- ${warning}`);
  }

  return lines.join("\n");
}
