export function compareScorecards(before, after) {
  const fingerprintBefore = before.suite?.fingerprint ?? null;
  const fingerprintAfter = after.suite?.fingerprint ?? null;

  const toolChanges = diffEntries(fingerprintBefore?.tools, fingerprintAfter?.tools, "name");
  const caseChanges = diffEntries(fingerprintBefore?.cases, fingerprintAfter?.cases, "id");
  const executionBefore = before.suite?.execution?.hash ?? null;
  const executionAfter = after.suite?.execution?.hash ?? null;
  const executionChanged = executionBefore !== executionAfter;
  const casesBefore = new Map((fingerprintBefore?.cases ?? []).map((entry) => [entry.id, entry.hash]));
  const casesAfter = new Map((fingerprintAfter?.cases ?? []).map((entry) => [entry.id, entry.hash]));
  const commonCaseIds = [...casesBefore.keys()].filter(
    (id) => casesAfter.has(id) && casesAfter.get(id) === casesBefore.get(id)
  );

  const modelsAfter = new Map((after.models ?? []).map((summary) => [summary.model, summary]));
  const models = [];

  for (const modelBefore of before.models ?? []) {
    const modelAfter = modelsAfter.get(modelBefore.model);
    if (!modelAfter) {
      models.push({ model: modelBefore.model, comparable: false, reason: "模型不在新报告中" });
      continue;
    }

    const rowsBefore = new Map((modelBefore.rows ?? []).map((row) => [row.id, row]));
    const rowsAfter = new Map((modelAfter.rows ?? []).map((row) => [row.id, row]));
    const comparableIds = commonCaseIds.filter((id) => rowsBefore.has(id) && rowsAfter.has(id));

    const regressions = [];
    const fixes = [];
    const argsDrops = [];
    const confusionCounts = new Map();
    const interferenceMap = new Map();
    let reviewed = 0;
    let selectionBefore = 0;
    let selectionAfter = 0;
    let passBefore = 0;
    let passAfter = 0;

    for (const id of comparableIds) {
      const rowBefore = rowsBefore.get(id);
      const rowAfter = rowsAfter.get(id);
      if (rowBefore.reviewed === false || rowAfter.reviewed === false) continue;
      reviewed += 1;
      if (rowBefore.selectionCorrect) selectionBefore += 1;
      if (rowAfter.selectionCorrect) selectionAfter += 1;
      if (rowBefore.passed) passBefore += 1;
      if (rowAfter.passed) passAfter += 1;

      const confusionKey = `${rowAfter.expectedTool ?? "(none)"}→${rowAfter.actualTool ?? "(none)"}`;
      confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);

      if (
        rowBefore.selectionCorrect &&
        !rowAfter.selectionCorrect &&
        rowBefore.expectedTool &&
        rowAfter.actualTool
      ) {
        const interferenceKey = `${rowBefore.expectedTool}→${rowAfter.actualTool}`;
        const entry = interferenceMap.get(interferenceKey) ?? {
          expected: rowBefore.expectedTool,
          stolenBy: rowAfter.actualTool,
          cases: []
        };
        entry.cases.push(id);
        interferenceMap.set(interferenceKey, entry);
      }

      if (rowBefore.passed && !rowAfter.passed) {
        regressions.push({
          id,
          before: rowBefore.actualTool ?? null,
          after: rowAfter.actualTool ?? null,
          args: rowAfter.args?.failures ?? []
        });
      }
      if (!rowBefore.passed && rowAfter.passed) {
        fixes.push({ id, before: rowBefore.actualTool ?? null, after: rowAfter.actualTool ?? null });
      }
      if (
        rowBefore.args?.total > 0 &&
        rowAfter.args?.total > 0 &&
        (rowAfter.args.matched ?? 0) < (rowBefore.args.matched ?? 0)
      ) {
        argsDrops.push({
          id,
          before: rowBefore.args.matched,
          after: rowAfter.args.matched,
          total: rowBefore.args.total
        });
      }
    }

    const confusion = [...confusionCounts.entries()].map(([key, count]) => {
      const [expected, actual] = key.split("→");
      return { expected, actual, count };
    });
    const interference = [...interferenceMap.values()].map((entry) => ({
      ...entry,
      count: entry.cases.length,
      stolenByIsNewTool: toolChanges.some(
        (change) => change.change === "added" && change.name === entry.stolenBy
      )
    }));

    models.push({
      model: modelBefore.model,
      comparable: toolChanges.length === 0 && caseChanges.length === 0 && !executionChanged,
      commonCases: comparableIds.length,
      reviewed,
      metrics: {
        selection: { before: ratio(selectionBefore, reviewed), after: ratio(selectionAfter, reviewed) },
        pass: { before: ratio(passBefore, reviewed), after: ratio(passAfter, reviewed) }
      },
      regressions,
      fixes,
      argsDrops,
      confusion,
      interference
    });
  }

  return {
    beforeHash: fingerprintBefore?.hash ?? null,
    afterHash: fingerprintAfter?.hash ?? null,
    toolChanges,
    caseChanges,
    executionChanged,
    executionBefore,
    executionAfter,
    models,
    profiles: compareProfiles(before, after)
  };
}

function compareProfiles(before, after) {
  const beforeReport = before.profiles ?? null;
  const afterReport = after.profiles ?? null;
  if (!beforeReport && !afterReport) return null;
  if (!beforeReport || !afterReport) {
    return { comparable: false, reason: "只有一份报告包含分组结果", models: [] };
  }
  const comparable = beforeReport.hash === afterReport.hash;
  const modelsAfter = new Map((afterReport.models ?? []).map((model) => [model.model, model]));
  const models = [];
  for (const modelBefore of beforeReport.models ?? []) {
    const modelAfter = modelsAfter.get(modelBefore.model);
    if (!modelAfter) {
      models.push({ model: modelBefore.model, reason: "模型不在新报告中", profiles: [] });
      continue;
    }
    const entriesAfter = new Map((modelAfter.profiles ?? []).map((entry) => [entry.profile, entry]));
    const entries = [];
    for (const entryBefore of modelBefore.profiles ?? []) {
      const entryAfter = entriesAfter.get(entryBefore.profile);
      if (!entryAfter) {
        entries.push({ name: entryBefore.profile, reason: "新报告没有这一组" });
        continue;
      }
      entries.push({
        name: entryBefore.profile,
        reviewed: entryAfter.reviewed,
        mounted: {
          before: entryBefore.mounted?.selectionAccuracy ?? null,
          after: entryAfter.mounted?.selectionAccuracy ?? null
        },
        allInOne: {
          before: entryBefore.allInOne?.selectionAccuracy ?? null,
          after: entryAfter.allInOne?.selectionAccuracy ?? null
        }
      });
    }
    models.push({ model: modelBefore.model, profiles: entries });
  }
  return {
    comparable,
    reason: comparable ? null : "分组定义已变更（profiles hash 不同）",
    beforeHash: beforeReport.hash,
    afterHash: afterReport.hash,
    models
  };
}

export function formatCompare(report) {
  const lines = [];
  if (!report.beforeHash || !report.afterHash) {
    lines.push("warn: 至少一份报告没有 fingerprint（旧版本生成），无法确认定义是否相同");
  }
  lines.push(`tool changes: ${report.toolChanges.length}  case changes: ${report.caseChanges.length}`);
  if (report.executionChanged) {
    lines.push("execution: 执行入口代码已变更，执行结果不可直接比较");
  }
  for (const change of report.toolChanges) {
    lines.push(`  tool ${change.change}: ${change.name}`);
  }
  for (const change of report.caseChanges) {
    lines.push(`  case ${change.change}: ${change.name}`);
  }

  for (const model of report.models) {
    lines.push("");
    if (model.reviewed === undefined) {
      lines.push(`[${model.model}] ${model.reason}`);
      continue;
    }
    lines.push(`[${model.model}] ${model.comparable ? "可比较" : "不可直接比较（工具定义或用例已变更）"}`);
    lines.push(`  共同且未变更用例: ${model.commonCases}（已复核 ${model.reviewed}）`);
    lines.push(`  选择准确率: ${percent(model.metrics.selection.before)} → ${percent(model.metrics.selection.after)}`);
    lines.push(`  通过率:     ${percent(model.metrics.pass.before)} → ${percent(model.metrics.pass.after)}`);
    if (model.interference.length > 0) {
      lines.push("  工具间干扰（原本选对，现在被别的工具抢走）:");
      for (const item of model.interference) {
        const tag = item.stolenByIsNewTool ? "（来自本次新增的工具）" : "";
        lines.push(`    - ${item.expected} → ${item.stolenBy}: ${item.count} 条${tag}  ${item.cases.join(", ")}`);
      }
    }
    const offDiagonal = (model.confusion ?? []).filter((entry) => entry.expected !== entry.actual);
    if (offDiagonal.length > 0) {
      lines.push("  误选分布:");
      for (const entry of offDiagonal) {
        lines.push(`    - 期望 ${entry.expected}，实际 ${entry.actual}: ${entry.count}`);
      }
    }
    if (model.regressions.length > 0) {
      lines.push("  回归:");
      for (const item of model.regressions) {
        const args = item.args.length > 0 ? `（参数缺 ${item.args.join(", ")}）` : "";
        lines.push(`    - ${item.id}: ${item.before ?? "(none)"} → ${item.after ?? "(none)"}${args}`);
      }
    }
    if (model.fixes.length > 0) {
      lines.push("  修复:");
      for (const item of model.fixes) {
        lines.push(`    - ${item.id}: ${item.before ?? "(none)"} → ${item.after ?? "(none)"}`);
      }
    }
    if (model.argsDrops.length > 0) {
      lines.push("  参数匹配下降:");
      for (const item of model.argsDrops) {
        lines.push(`    - ${item.id}: ${item.before}/${item.total} → ${item.after}/${item.total}`);
      }
    }
  }

  if (report.profiles) {
    lines.push("");
    if (!report.profiles.comparable) {
      lines.push(`挂载分组: ${report.profiles.reason}`);
    } else {
      lines.push(`挂载分组（同一定义 ${report.profiles.beforeHash}，组内准确率）:`);
    }
    for (const model of report.profiles.models) {
      if (model.reason) {
        lines.push(`  [${model.model}] ${model.reason}`);
        continue;
      }
      lines.push(`  [${model.model}]`);
      for (const entry of model.profiles) {
        if (entry.reason) {
          lines.push(`    ${entry.name}: ${entry.reason}`);
          continue;
        }
        const delta =
          entry.mounted.before === null || entry.mounted.after === null
            ? ""
            : `（${signed(entry.mounted.after - entry.mounted.before)}）`;
        lines.push(
          `    ${entry.name}  ${percent(entry.mounted.before)} → ${percent(entry.mounted.after)}${delta}` +
            `  全量 ${percent(entry.allInOne.before)} → ${percent(entry.allInOne.after)}`
        );
      }
    }
  }

  return lines.join("\n");
}

function signed(value) {
  const points = Math.round(value * 100);
  return `${points > 0 ? "+" : ""}${points}pp`;
}

function diffEntries(beforeList, afterList, key) {
  const before = new Map((beforeList ?? []).map((entry) => [entry[key], entry.hash]));
  const after = new Map((afterList ?? []).map((entry) => [entry[key], entry.hash]));
  const changes = [];
  for (const [name, hash] of before) {
    if (!after.has(name)) changes.push({ name, change: "removed", before: hash });
    else if (after.get(name) !== hash) changes.push({ name, change: "changed", before: hash, after: after.get(name) });
  }
  for (const [name, hash] of after) {
    if (!before.has(name)) changes.push({ name, change: "added", after: hash });
  }
  return changes;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percent(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}
