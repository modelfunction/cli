import { legalFirstCallsOf } from "./score.js";

export function replayScorecard(scorecard, suite) {
  const caseById = new Map((suite.cases ?? []).map((testCase) => [testCase.id, testCase]));
  const models = [];

  for (const model of scorecard.models ?? []) {
    const changes = [];
    let reviewed = 0;
    let missing = 0;
    let beforeHits = 0;
    let afterHits = 0;

    for (const row of model.rows ?? []) {
      const current = caseById.get(row.id);
      if (!current) {
        missing += 1;
        continue;
      }
      if (row.reviewed === false || current.reviewed === false) continue;
      if (row.excludeFromBase || current.excludeFromBase) continue;

      reviewed += 1;
      const actualTool = row.actualTool ?? null;
      const errored = Boolean(row.error);
      const bucket = current.bucket ?? "singleIntent";
      const newSelectionCorrect = !errored && actualTool === current.expectedTool;
      const newLegalFirstStep =
        bucket === "singleIntent"
          ? newSelectionCorrect
          : !errored && actualTool !== null && legalFirstCallsOf(current).includes(actualTool);

      if (row.selectionCorrect) beforeHits += 1;
      if (newSelectionCorrect) afterHits += 1;

      const oldExpectedTool = row.expectedTool ?? null;
      const oldBucket = row.bucket ?? "singleIntent";
      if (oldExpectedTool !== current.expectedTool || oldBucket !== bucket) {
        changes.push({
          id: row.id,
          actualTool,
          oldExpectedTool,
          newExpectedTool: current.expectedTool,
          oldBucket,
          newBucket: bucket,
          oldSelectionCorrect: Boolean(row.selectionCorrect),
          newSelectionCorrect,
          newLegalFirstStep
        });
      }
    }

    models.push({
      model: model.model,
      reviewed,
      missing,
      selection: {
        before: ratio(beforeHits, reviewed),
        after: ratio(afterHits, reviewed)
      },
      changed: changes
    });
  }

  return {
    suite: suite.name,
    models,
    limitations: ["args/pass 无法重算：历史评分卡只保存参数匹配结果，不保存实际参数"]
  };
}

export function formatReplay(report) {
  const lines = [`suite: ${report.suite}`];
  for (const model of report.models) {
    lines.push("");
    lines.push(
      `[${model.model}] 已复核 ${model.reviewed} 条；选择准确率 ${percent(model.selection.before)} → ${percent(model.selection.after)}（重述后）`
    );
    if (model.missing > 0) {
      lines.push(`  当前套件中找不到 ${model.missing} 条历史用例（不在重述范围）`);
    }
    for (const change of model.changed) {
      const oldVerdict = change.oldSelectionCorrect ? "hit" : "miss";
      const newVerdict = change.newSelectionCorrect ? "hit" : "miss";
      lines.push(
        `  ${change.id}: ${change.oldExpectedTool ?? "(none)"} [${change.oldBucket}] → ` +
          `${change.newExpectedTool ?? "(none)"} [${change.newBucket}]；` +
          `实际 ${change.actualTool ?? "(none)"}，${oldVerdict} → ${newVerdict}`
      );
    }
  }
  for (const limitation of report.limitations) lines.push(`note: ${limitation}`);
  return lines.join("\n");
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percent(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}
