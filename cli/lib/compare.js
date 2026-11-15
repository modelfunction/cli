import { compareEnvironments, formatEnvironmentDifferences } from "./environment.js";

const PERSISTENT_MIN_OCCURRENCES = 3;
const PERSISTENT_MIN_CASES = 2;

export function compareScorecards(before, after, { crossEnv = false } = {}) {
  const environment = compareEnvironments(before.environment, after.environment, { crossEnv });
  const environmentComparable = environment.comparable;
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

    const unstableBefore = new Set((modelBefore.stability?.unstable ?? []).map((item) => item.id));
    const unstableAfter = new Set((modelAfter.stability?.unstable ?? []).map((item) => item.id));
    // Both sides need repeat data before stable/drifting means anything; with a
    // missing side every case falls back to "stable", which is absence of
    // evidence, not evidence of stability.
    const stabilityCaptured = Boolean(modelBefore.stability) && Boolean(modelAfter.stability);

    const failureKindCaptured = Boolean(modelBefore.failureKinds && modelAfter.failureKinds);
    const failureKindBefore = {};
    const failureKindAfter = {};
    const failureKindFlips = [];
    const regressions = [];
    const unstableFlips = [];
    const fixes = [];
    const argsDrops = [];
    const confusionCounts = new Map();
    const interferenceMap = new Map();
    const persistentMap = new Map();
    const bucketCounts = new Map();
    let reviewed = 0;
    let excluded = 0;
    let selectionBefore = 0;
    let selectionAfter = 0;
    let passBefore = 0;
    let passAfter = 0;
    let selectionFlipRegressions = 0;
    let selectionFlipFixes = 0;

    for (const id of comparableIds) {
      const rowBefore = rowsBefore.get(id);
      const rowAfter = rowsAfter.get(id);
      if (rowBefore.reviewed === false || rowAfter.reviewed === false) continue;
      if (rowBefore.excludeFromBase || rowAfter.excludeFromBase) {
        excluded += 1;
        continue;
      }
      reviewed += 1;
      if (failureKindCaptured) {
        const beforeKind = rowBefore.failureKind ?? "unknown";
        const afterKind = rowAfter.failureKind ?? "unknown";
        failureKindBefore[beforeKind] = (failureKindBefore[beforeKind] ?? 0) + 1;
        failureKindAfter[afterKind] = (failureKindAfter[afterKind] ?? 0) + 1;
        if (beforeKind !== afterKind) failureKindFlips.push({ id, before: beforeKind, after: afterKind });
      }
      if (rowBefore.selectionCorrect) selectionBefore += 1;
      if (rowAfter.selectionCorrect) selectionAfter += 1;
      if (rowBefore.passed) passBefore += 1;
      if (rowAfter.passed) passAfter += 1;
      if (rowBefore.selectionCorrect && !rowAfter.selectionCorrect) selectionFlipRegressions += 1;
      if (!rowBefore.selectionCorrect && rowAfter.selectionCorrect) selectionFlipFixes += 1;
      const bucketKey = bucketOf(rowAfter);
      const counts = bucketCounts.get(bucketKey) ?? {
        reviewed: 0,
        selectionBefore: 0,
        selectionAfter: 0,
        legalBefore: 0,
        legalAfter: 0
      };
      counts.reviewed += 1;
      if (rowBefore.selectionCorrect) counts.selectionBefore += 1;
      if (rowAfter.selectionCorrect) counts.selectionAfter += 1;
      if (isLegalFirstStep(rowBefore)) counts.legalBefore += 1;
      if (isLegalFirstStep(rowAfter)) counts.legalAfter += 1;
      bucketCounts.set(bucketKey, counts);

      if (!isLegalFirstStep(rowAfter)) {
        const confusionKey = `${rowAfter.expectedTool ?? "(none)"}→${rowAfter.actualTool ?? "(none)"}`;
        confusionCounts.set(confusionKey, (confusionCounts.get(confusionKey) ?? 0) + 1);
      }
      recordPersistent(persistentMap, rowBefore, "before", id, unstableBefore);
      recordPersistent(persistentMap, rowAfter, "after", id, unstableAfter);

      if (
        isLegalFirstStep(rowBefore) &&
        !isLegalFirstStep(rowAfter) &&
        rowBefore.expectedTool &&
        rowAfter.actualTool
      ) {
        const bucket = bucketOf(rowAfter);
        const interferenceKey = `${bucket}→${rowBefore.expectedTool}→${rowAfter.actualTool}`;
        const entry = interferenceMap.get(interferenceKey) ?? {
          bucket,
          expected: rowBefore.expectedTool,
          stolenBy: rowAfter.actualTool,
          cases: []
        };
        entry.cases.push(id);
        interferenceMap.set(interferenceKey, entry);
      }

      // Non-single buckets have no full-trajectory verdict yet, so their
      // regression question is the opening move: legal before, not legal now.
      const bucket = bucketOf(rowAfter);
      const beforeLegal = isLegalFirstStep(rowBefore);
      const afterLegal = isLegalFirstStep(rowAfter);
      const regressed = bucket === "singleIntent"
        ? rowBefore.passed && !rowAfter.passed
        : beforeLegal && !afterLegal;
      const fixed = bucket === "singleIntent"
        ? !rowBefore.passed && rowAfter.passed
        : !beforeLegal && afterLegal;
      if (regressed) {
        const unstable =
          stabilityCaptured && (unstableBefore.has(id) || unstableAfter.has(id));
        const entry = {
          id,
          bucket,
          before: rowBefore.actualTool ?? null,
          after: rowAfter.actualTool ?? null,
          args: rowAfter.args?.failures ?? []
        };
        if (unstable) unstableFlips.push(entry);
        else regressions.push(entry);
      }
      if (fixed) {
        fixes.push({ id, bucket, before: rowBefore.actualTool ?? null, after: rowAfter.actualTool ?? null });
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
    const persistentInterference = [...persistentMap.values()]
      .filter(
        (entry) =>
          entry.occurrences >= PERSISTENT_MIN_OCCURRENCES && entry.cases.size >= PERSISTENT_MIN_CASES
      )
      .map((entry) => ({
        bucket: entry.bucket,
        expected: entry.expected,
        stolenBy: entry.stolenBy,
        occurrences: entry.occurrences,
        runs: entry.sides.size,
        cases: [...entry.cases.keys()],
        stable: [...entry.cases.values()].filter((drifting) => !drifting).length,
        drifting: [...entry.cases.values()].filter(Boolean).length
      }))
      .sort(
        (a, b) =>
          a.bucket.localeCompare(b.bucket) ||
          b.occurrences - a.occurrences ||
          a.expected.localeCompare(b.expected)
      );

    const buckets = {};
    for (const [name, counts] of bucketCounts) {
      buckets[name] = {
        reviewed: counts.reviewed,
        selection: {
          before: ratio(counts.selectionBefore, counts.reviewed),
          after: ratio(counts.selectionAfter, counts.reviewed)
        },
        legalFirstStep: {
          before: ratio(counts.legalBefore, counts.reviewed),
          after: ratio(counts.legalAfter, counts.reviewed)
        },
        firstCallMisses: {
          before: counts.reviewed - counts.legalBefore,
          after: counts.reviewed - counts.legalAfter
        }
      };
    }

    const definitionComparable = toolChanges.length === 0 && caseChanges.length === 0 && !executionChanged;
    const stats =
      definitionComparable && environmentComparable && reviewed > 0
        ? {
            pairedSelection: pairedSelectionStats(selectionFlipRegressions, selectionFlipFixes),
            independentMde: independentMde(reviewed)
          }
        : null;
    models.push({
      model: modelBefore.model,
      comparable: definitionComparable && environmentComparable,
      ...(definitionComparable && !environmentComparable ? { reason: "环境不一致" } : {}),
      commonCases: comparableIds.length,
      reviewed,
      excluded,
      stabilityCaptured,
      metrics: {
        selection: { before: ratio(selectionBefore, reviewed), after: ratio(selectionAfter, reviewed) },
        pass: { before: ratio(passBefore, reviewed), after: ratio(passAfter, reviewed) }
      },
      stats,
      buckets,
      failureKinds: failureKindCaptured
        ? {
            before: failureKindBefore,
            after: failureKindAfter,
            changed: [...new Set([...Object.keys(failureKindBefore), ...Object.keys(failureKindAfter)])]
              .map((kind) => ({
                kind,
                before: failureKindBefore[kind] ?? 0,
                after: failureKindAfter[kind] ?? 0,
                delta: (failureKindAfter[kind] ?? 0) - (failureKindBefore[kind] ?? 0)
              }))
              .filter((entry) => entry.delta !== 0)
              .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
            flips: failureKindFlips
          }
        : null,
      regressions,
      unstableFlips,
      fixes,
      argsDrops,
      confusion,
      interference,
      persistentInterference
    });
  }

  return {
    beforeHash: fingerprintBefore?.hash ?? null,
    afterHash: fingerprintAfter?.hash ?? null,
    toolChanges,
    caseChanges,
    judgmentChanges: compareJudgments(before, after, caseChanges),
    executionChanged,
    executionBefore,
    executionAfter,
    environment,
    models,
    profiles: compareProfiles(before, after)
  };
}

function compareJudgments(before, after, caseChanges) {
  if (caseChanges.length === 0) return [];
  const judgmentsFor = (report, id) =>
    (report.suite?.judgments ?? []).filter((entry) => entry.caseId === id);
  return caseChanges.map((change) => {
    const seen = new Set();
    const judgments = [];
    for (const entry of [...judgmentsFor(after, change.name), ...judgmentsFor(before, change.name)]) {
      const key = JSON.stringify(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      judgments.push(entry);
    }
    return {
      id: change.name,
      change: change.change,
      beforeExpected: expectedToolOf(before, change.name),
      afterExpected: expectedToolOf(after, change.name),
      judgments
    };
  });
}

function expectedToolOf(report, id) {
  for (const model of report.models ?? []) {
    const row = (model.rows ?? []).find((entry) => entry.id === id);
    if (row) return row.expectedTool ?? null;
  }
  return null;
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

export function regressionGate(comparison, summaries = []) {
  const missing = comparison.models.filter((model) => model.reason === "模型不在新报告中");
  if (missing.length > 0) {
    return {
      status: "fail",
      message: `baseline model(s) not in this report: ${missing.map((model) => model.model).join(", ")}；无法判定回归（门禁失败）`
    };
  }

  const errored = summaries.filter(
    (summary) => summary.reviewedTotal > 0 && summary.errors === summary.reviewedTotal
  );
  if (errored.length > 0) {
    const detail = errored
      .map((summary) => {
        const kinds = summary.errorsByKind && Object.keys(summary.errorsByKind).length
          ? ` ${JSON.stringify(summary.errorsByKind)}`
          : "";
        return `${summary.model} (${summary.errors}/${summary.reviewedTotal}${kinds})`;
      })
      .join(", ");
    return {
      status: "fail",
      message: `all calls failed for: ${detail}；基础设施故障，无法判定回归（门禁失败）`
    };
  }

  if (comparison.environment?.comparable === false) {
    return {
      status: "skip",
      message: `${comparison.environment.reason ?? "环境不一致"}，无法判定回归（门禁跳过）`
    };
  }

  const comparable = comparison.models.filter((model) => model.comparable && model.reviewed > 0);
  if (comparable.length === 0) {
    return { status: "skip", message: "定义或用例已变更，无法判定回归（门禁跳过）" };
  }

  const warnings = comparable.flatMap((model) =>
    (model.unstableFlips ?? []).map((item) => `${model.model}/${item.id}`)
  );
  return {
    status: "ok",
    regressions: comparable.flatMap((model) =>
      model.regressions.map((item) => `${model.model}/${item.id}`)
    ),
    ...(warnings.length > 0 ? { warnings } : {})
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
  for (const change of report.judgmentChanges ?? []) {
    lines.push(
      `  judgment ${change.change}: ${change.id} ${change.beforeExpected ?? "(none)"} → ${change.afterExpected ?? "(none)"}`
    );
    for (const entry of change.judgments) {
      lines.push(
        `    ${String(entry.changedAt).slice(0, 10)} ${entry.reason}${entry.evidencePointer ? ` [${entry.evidencePointer}]` : ""}`
      );
    }
  }
  if (report.environment) {
    for (const warning of report.environment.warnings ?? []) {
      lines.push(`warn: ${warning}`);
    }
    const environmentLine = formatEnvironmentDifferences(report.environment);
    if (environmentLine) lines.push(environmentLine);
  }

  for (const model of report.models) {
    lines.push("");
    if (model.reviewed === undefined) {
      lines.push(`[${model.model}] ${model.reason}`);
      continue;
    }
    const incomparableReason = model.reason ?? "工具定义或用例已变更";
    lines.push(
      `[${model.model}] ${model.comparable ? "可比较" : `不可直接比较（${incomparableReason}）`}`
    );
    lines.push(`  共同且未变更用例: ${model.commonCases}（已复核 ${model.reviewed}）`);
    if (model.excluded > 0) {
      lines.push(`  排除出回归判定: ${model.excluded} 条（excludeFromBase）`);
    }
    lines.push(`  选择准确率: ${percent(model.metrics.selection.before)} → ${percent(model.metrics.selection.after)}`);
    lines.push(`  通过率:     ${percent(model.metrics.pass.before)} → ${percent(model.metrics.pass.after)}`);
    if (model.unstableFlips?.length) {
      lines.push(
        `  不稳定用例翻转（不计入回归门禁）: ${model.unstableFlips.map((item) => item.id).join(", ")}`
      );
    }
    if (model.stats) lines.push(`  ${formatStatsLine(model.stats)}`);
    if (model.buckets?.multiStep || model.buckets?.ambiguous) {
      const parts = [];
      const single = model.buckets.singleIntent;
      if (single) {
        parts.push(`singleIntent 选择 ${percent(single.selection.before)} → ${percent(single.selection.after)}`);
      }
      for (const name of ["multiStep", "ambiguous"]) {
        const entry = model.buckets[name];
        if (!entry) continue;
        parts.push(
          `${name} 首轮合法 ${percent(entry.legalFirstStep.before)} → ${percent(entry.legalFirstStep.after)}` +
            `（首轮未命中 ${entry.firstCallMisses.before} → ${entry.firstCallMisses.after}）`
        );
      }
      lines.push(`  分桶: ${parts.join(" · ")}`);
    }
    if (model.failureKinds?.changed.length > 0) {
      lines.push(
        `  失败分解变化: ${model.failureKinds.changed
          .map((entry) => `${entry.kind} ${entry.before} → ${entry.after}`)
          .join(" · ")}`
      );
    }
    if (model.failureKinds?.flips.length > 0) {
      const list = model.failureKinds.flips
        .slice(0, 8)
        .map((item) => `${item.id} ${item.before}→${item.after}`);
      const more = model.failureKinds.flips.length > 8 ? ` 等 ${model.failureKinds.flips.length} 条` : "";
      lines.push(`  失败分类改判: ${list.join(", ")}${more}`);
    }
    if (model.interference.length > 0) {
      lines.push("  工具间干扰（原本是合法首步，现在被别的工具抢走）:");
      for (const item of model.interference) {
        const tag = item.stolenByIsNewTool ? "（来自本次新增的工具）" : "";
        lines.push(
          `    - [${item.bucket ?? "singleIntent"}] ${item.expected} → ${item.stolenBy}: ${item.count} 条${tag}  ${item.cases.join(", ")}`
        );
      }
    }
    if (model.persistentInterference?.length > 0) {
      lines.push("  持续干扰（同一对工具 ≥3 次且 ≥2 条用例，跨比较的两份报告；按桶分列）:");
      for (const item of model.persistentInterference) {
        lines.push(
          `    - [${item.bucket ?? "singleIntent"}] ${item.expected} → ${item.stolenBy}: ${item.occurrences} 次 / ${item.cases.length} 条用例（稳定错选 ${item.stable}，高熵漂移 ${item.drifting}）  ${item.cases.join(", ")}`
        );
      }
      if (!model.stabilityCaptured) {
        lines.push(
          "    注：至少一份报告未采集 stability 元数据（--repeat）；stable 表示未观测到漂移，不等同于已确认稳定"
        );
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

function bucketOf(row) {
  return row?.bucket ?? "singleIntent";
}

// Old scorecards predate buckets; selectionCorrect is the legacy first-call
// verdict, which is exactly what singleIntent still means.
function isLegalFirstStep(row) {
  if (typeof row?.legalFirstStep === "boolean") return row.legalFirstStep;
  return Boolean(row?.selectionCorrect);
}

function recordPersistent(map, row, side, id, unstableIds) {
  if (!row?.expectedTool || !row.actualTool || row.expectedTool === row.actualTool) return;
  // A multiStep legal opening move is not a misroute, so it never enters the
  // persistent-interference family.
  if (isLegalFirstStep(row)) return;
  const bucket = bucketOf(row);
  const key = `${bucket}→${row.expectedTool}→${row.actualTool}`;
  const entry = map.get(key) ?? {
    bucket,
    expected: row.expectedTool,
    stolenBy: row.actualTool,
    occurrences: 0,
    cases: new Map(),
    sides: new Set()
  };
  entry.occurrences += 1;
  entry.cases.set(id, (entry.cases.get(id) ?? false) || unstableIds.has(id));
  entry.sides.add(side);
  map.set(key, entry);
}

function pairedSelectionStats(beforeCorrectAfterWrong, beforeWrongAfterCorrect) {
  const discordant = beforeCorrectAfterWrong + beforeWrongAfterCorrect;
  return {
    beforeCorrectAfterWrong,
    beforeWrongAfterCorrect,
    discordant,
    pValue: mcnemarExactP(beforeCorrectAfterWrong, beforeWrongAfterCorrect),
    requiredSameDirection: requiredSameDirection(discordant)
  };
}

function independentMde(n) {
  // Worst case p=.5; alpha=.05 two-sided, power=.80, equal groups.
  const zAlpha = 1.959963984540054;
  const zBeta = 0.8416212335729143;
  return {
    n,
    alpha: 0.05,
    power: 0.8,
    delta: (zAlpha + zBeta) * Math.sqrt(0.5 / n)
  };
}

// Two-sided exact McNemar: only discordant pairs carry information.
function mcnemarExactP(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = 2 ** -n;
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term *= (n - i + 1) / i;
    sum += term;
  }
  return Math.min(1, 2 * sum);
}

// Minimum one-way flips (no opposite flips) that the exact two-sided test
// calls significant. With 18 reviewed cases this is 6, matching the agreed
// reporting threshold.
function requiredSameDirection(n) {
  if (n === 0) return null;
  for (let k = 0; k <= n; k += 1) {
    if (mcnemarExactP(k, 0) < 0.05) return k;
  }
  return null;
}

function formatStatsLine(stats) {
  const paired = stats.pairedSelection;
  const pText = paired.discordant === 0 || paired.pValue === 1
    ? "n/a"
    : paired.pValue < 0.001
      ? "<0.001"
      : paired.pValue.toFixed(3);
  const requirement =
    paired.discordant === 0
      ? "无配对翻转"
      : paired.requiredSameDirection === null
        ? "当前用例数下无法达 p<.05"
        : `需 ≥${paired.requiredSameDirection} 例同向翻转（无反向）才达 p<.05`;
  const mde =
    stats.independentMde.delta >= 1
      ? ">100pp（n 过小，无法检出实际差异）"
      : `${Math.round(stats.independentMde.delta * 100)}pp（n=${stats.independentMde.n}）`;
  return (
    `统计: 配对选择翻转 ${paired.beforeCorrectAfterWrong}（成功→失败）/ ` +
    `${paired.beforeWrongAfterCorrect}（失败→成功），n=${paired.discordant}，` +
    `McNemar 精确 p=${pText}；${requirement}；独立两样本 80% 功效 MDE ≈ ${mde}`
  );
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percent(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}
