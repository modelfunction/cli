import { pct } from "./score.js";

export function normalizeProfiles(raw, toolNames) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") {
    throw new Error('suite "profiles" must be an object or an array of groups');
  }
  const known = new Set(toolNames);
  const profiles = [];
  const seen = new Set();
  // Platform registries often hand us an array of
  // { agentType, tools, skills } rather than { "group": ["tool"] }.
  const entries = Array.isArray(raw)
    ? raw.map((value, index) => [String(index), value])
    : Object.entries(raw);
  for (const [key, value] of entries) {
    // Array form: { "group": ["tool", ...] }. Object form (platform registries
    // often look like this): { "0": { agentType, tools, skills } }.
    const list = Array.isArray(value) ? value : value?.tools;
    const name = String(Array.isArray(value) ? key : value?.name ?? value?.agentType ?? key).trim();
    if (!name) throw new Error('suite "profiles": group name must be non-empty');
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`profile "${name}": must be a non-empty array of tool names`);
    }
    if (seen.has(name)) throw new Error(`profile "${name}": duplicate group name`);
    seen.add(name);
    const tools = [];
    for (const item of list) {
      if (typeof item !== "string" || item.trim() === "") {
        throw new Error(`profile "${name}": tool names must be non-empty strings`);
      }
      const toolName = item.trim();
      if (!known.has(toolName)) throw new Error(`profile "${name}": unknown tool "${toolName}"`);
      if (!tools.includes(toolName)) tools.push(toolName);
    }
    profiles.push({ name, tools });
  }
  if (profiles.length === 0) throw new Error('suite "profiles" is empty');
  return profiles;
}

export function selectProfiles(profiles, wanted) {
  if (!wanted || wanted.length === 0 || wanted.includes("all")) return profiles;
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  const missing = wanted.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `unknown profile(s): ${missing.join(", ")}（可用：${profiles.map((profile) => profile.name).join(", ")}）`
    );
  }
  return wanted.map((name) => byName.get(name));
}

// A case belongs to a group when its expected tool is mounted there. Negative
// cases ("no tool applies") hold everywhere: the group's agent still gets them.
export function selectProfileCases(cases, mountedTools) {
  return cases.filter(
    (testCase) =>
      testCase.excludeFromProfiles !== true &&
      (testCase.expectedTool === null || mountedTools.has(testCase.expectedTool))
  );
}

export function profileWarnings(profiles, suite) {
  const mounted = new Set(profiles.flatMap((profile) => profile.tools));
  const warnings = [];
  const unmounted = suite.tools.map((tool) => tool.name).filter((name) => !mounted.has(name));
  if (unmounted.length > 0) warnings.push(`工具不在任何挂载组: ${unmounted.join(", ")}`);
  const homeless = suite.cases.filter(
    (testCase) => testCase.expectedTool !== null && !mounted.has(testCase.expectedTool)
  ).length;
  if (homeless > 0) warnings.push(`${homeless} 条用例的期望工具不在任何挂载组，不参与分组评分`);
  const everything = suite.tools.length;
  for (const profile of profiles) {
    if (profile.tools.length === everything) {
      warnings.push(`profile "${profile.name}" 挂载了全部工具，与全量对比没有意义`);
    }
  }
  return warnings;
}

export function profileCaseCoverage(profiles, cases) {
  const considered = cases.filter((testCase) => testCase.excludeFromProfiles !== true);
  const negatives = considered.filter((testCase) => testCase.expectedTool === null).length;
  return profiles.map((profile) => {
    const mounted = new Set(profile.tools);
    const counts = new Map(profile.tools.map((name) => [name, 0]));
    for (const testCase of considered) {
      if (testCase.expectedTool !== null && mounted.has(testCase.expectedTool)) {
        counts.set(testCase.expectedTool, counts.get(testCase.expectedTool) + 1);
      }
    }
    const missing = [...counts.entries()].filter(([, count]) => count === 0).map(([name]) => name);
    let total = 0;
    for (const count of counts.values()) total += count;
    return {
      name: profile.name,
      tools: profile.tools.length,
      cases: total,
      negatives,
      negativeRatio: total + negatives > 0 ? negatives / (total + negatives) : 0,
      missing
    };
  });
}

export function analyzeMount(profile, mounted, allInOne) {
  const after = new Map(mounted.rows.map((row) => [row.id, row]));
  const lifted = [];
  const jammed = [];
  for (const before of allInOne.rows) {
    const row = after.get(before.id);
    if (!row || before.reviewed === false || row.reviewed === false) continue;
    // A provider error is not evidence about mounting; score it separately.
    if (before.error || row.error) continue;
    if (!before.selectionCorrect && row.selectionCorrect) lifted.push(changeOf(before, row));
    else if (before.selectionCorrect && !row.selectionCorrect) jammed.push(changeOf(before, row));
  }

  const mountedMetrics = metricsOf(mounted);
  const allMetrics = metricsOf(allInOne);
  const reviewed = mountedMetrics.scored;
  return {
    profile: profile.name,
    mountedTools: profile.tools.length,
    cases: mounted.total,
    reviewed,
    errors: mountedMetrics.errors,
    mounted: mountedMetrics,
    allInOne: allMetrics,
    delta: {
      selection: reviewed ? mountedMetrics.selectionAccuracy - allMetrics.selectionAccuracy : null,
      args:
        mountedMetrics.argAccuracy === null || allMetrics.argAccuracy === null
          ? null
          : mountedMetrics.argAccuracy - allMetrics.argAccuracy,
      pass: reviewed ? mountedMetrics.passRate - allMetrics.passRate : null
    },
    lifted,
    jammed
  };
}

export function modelTotals(entries) {
  let reviewed = 0;
  let errors = 0;
  let mountedCorrect = 0;
  let allCorrect = 0;
  const usage = {
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    costCurrency: null,
    costCny: 0,
    estimated: false
  };
  for (const entry of entries) {
    reviewed += entry.reviewed;
    errors += entry.errors ?? 0;
    mountedCorrect += entry.mounted.correct;
    allCorrect += entry.allInOne.correct;
    usage.inputTokens += entry.usage?.inputTokens ?? 0;
    usage.cachedTokens += entry.usage?.cachedTokens ?? 0;
    usage.outputTokens += entry.usage?.outputTokens ?? 0;
    usage.totalTokens += entry.usage?.totalTokens ?? 0;
    usage.cost += entry.usage?.cost ?? 0;
    usage.costCurrency ||= entry.usage?.costCurrency ?? null;
    usage.costCny += entry.usage?.costCny ?? 0;
    usage.estimated ||= Boolean(entry.usage?.estimated);
  }
  usage.costCurrency ??= "CNY";
  if (reviewed === 0) {
    return {
      reviewed: 0,
      errors,
      mountedCorrect: 0,
      allCorrect: 0,
      mountedAccuracy: null,
      allAccuracy: null,
      delta: null,
      usage
    };
  }
  const mountedAccuracy = mountedCorrect / reviewed;
  const allAccuracy = allCorrect / reviewed;
  return {
    reviewed,
    errors,
    mountedCorrect,
    allCorrect,
    mountedAccuracy,
    allAccuracy,
    delta: mountedAccuracy - allAccuracy,
    usage
  };
}

export function formatProfileReport(report, { showCases = false } = {}) {
  const lines = [
    `mount compare: ${report.groups.length} 组（profiles ${report.hash}）`,
    "组内用例只在对应挂载下评分；all-in-one 用同一批用例、全部工具都挂。"
  ];

  for (const model of report.models) {
    lines.push("", `[${model.model}]`);
    const rows = model.profiles.map((entry) => [
      entry.profile,
      String(entry.mountedTools),
      String(entry.cases),
      String(entry.errors ?? 0),
      pct(entry.mounted.selectionAccuracy),
      pct(entry.allInOne.selectionAccuracy),
      signedPoints(entry.delta.selection)
    ]);
    lines.push(
      ...renderTable(
        ["profile", "tools", "cases", "errors", "mounted", "all-in-one", "delta"],
        rows,
        [1, 2, 3, 4, 5, 6]
      )
    );
    const totals = model.totals;
    if (totals.reviewed > 0) {
      lines.push(
        `  合计: 分组 ${pct(totals.mountedAccuracy)}（${totals.mountedCorrect}/${totals.reviewed}）` +
          ` / 全量 ${pct(totals.allAccuracy)}（${totals.allCorrect}/${totals.reviewed}）` +
          `，${signedPoints(totals.delta)}` +
          (totals.errors > 0 ? `；${totals.errors} 次调用错误不计入对比` : "")
      );
    }
    const unstable = unstableOf(model.profiles);
    if (unstable.length > 0) lines.push(`  组内不稳定: ${unstable.join(", ")}`);
    if (showCases) {
      for (const entry of model.profiles) {
        for (const item of entry.lifted) {
          lines.push(
            `  + ${entry.profile}/${item.id}: ${item.before ?? "(no tool)"} → ${item.after ?? "(no tool)"}（期望 ${item.expected ?? "(no tool)"}）`
          );
        }
        for (const item of entry.jammed) {
          lines.push(
            `  - ${entry.profile}/${item.id}: ${item.before ?? "(no tool)"} → ${item.after ?? "(no tool)"}（期望 ${item.expected ?? "(no tool)"}）`
          );
        }
      }
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", "warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  return lines.join("\n");
}

export function formatProfileMarkdown(report) {
  const lines = [
    "## 挂载对比（分组 vs 全量）",
    "",
    "组内用例只在对应挂载下评分；全量 = 同一批用例、全部工具都挂。",
    ""
  ];
  for (const model of report.models) {
    lines.push(
      `### ${model.model}`,
      "",
      "| group | tools | cases | errors | mounted | all-in-one | delta |",
      "| --- | --- | --- | --- | --- | --- | --- |"
    );
    for (const entry of model.profiles) {
      lines.push(
        `| ${entry.profile} | ${entry.mountedTools} | ${entry.cases} | ${entry.errors ?? 0} | ${pct(entry.mounted.selectionAccuracy)} | ${pct(entry.allInOne.selectionAccuracy)} | ${signedPoints(entry.delta.selection)} |`
      );
    }
    const totals = model.totals;
    lines.push("");
    if (totals.reviewed > 0) {
      lines.push(
        `- 合计：分组 ${pct(totals.mountedAccuracy)}（${totals.mountedCorrect}/${totals.reviewed}），` +
          `全量 ${pct(totals.allAccuracy)}（${totals.allCorrect}/${totals.reviewed}），${signedPoints(totals.delta)}` +
          (totals.errors > 0 ? `；${totals.errors} 次调用错误不计入对比` : "")
      );
    } else {
      lines.push("- 合计：没有已复核用例，无法比较");
    }
    const unstable = unstableOf(model.profiles);
    if (unstable.length > 0) lines.push(`- 组内不稳定：${unstable.join(", ")}`);
    lines.push("");
  }
  if (report.warnings.length > 0) lines.push(`> ${report.warnings.join("；")}`, "");
  return lines.join("\n").trimEnd();
}

function unstableOf(entries) {
  return entries.flatMap((entry) =>
    (entry.stability?.unstable ?? []).map((item) => `${entry.profile}/${item.id}`)
  );
}

function changeOf(before, after) {
  return {
    id: before.id,
    expected: before.expectedTool ?? null,
    before: before.actualTool ?? null,
    after: after.actualTool ?? null
  };
}

function metricsOf(summary) {
  const reviewedRows = summary.rows.filter((row) => row.reviewed !== false);
  const errorRows = reviewedRows.filter((row) => row.error);
  const viableRows = reviewedRows.filter((row) => !row.error);
  const correct = viableRows.filter((row) => row.selectionCorrect).length;
  return {
    selectionAccuracy: viableRows.length ? correct / viableRows.length : null,
    argAccuracy: summary.argAccuracy,
    passRate: viableRows.length
      ? viableRows.filter((row) => row.passed).length / viableRows.length
      : null,
    correct,
    errors: errorRows.length,
    scored: viableRows.length
  };
}

function signedPoints(value) {
  if (value === null || value === undefined) return "n/a";
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points}pp`;
}

function renderTable(headers, rows, numericColumns) {
  const widths = headers.map((header, index) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index])))
  );
  const line = (cells) =>
    cells
      .map((cell, index) => padDisplay(cell, widths[index], numericColumns.includes(index)))
      .join("  ");
  return [line(headers), widths.map((width) => "-".repeat(width)).join("  "), ...rows.map(line)].map(
    (text) => `  ${text}`
  );
}

function padDisplay(text, width, rightAlign) {
  const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
  return rightAlign ? fill + text : text + fill;
}

export function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
      char
    )
      ? 2
      : 1;
  }
  return width;
}
