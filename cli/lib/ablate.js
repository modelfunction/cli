export function analyzeAblation(model, full, reduced) {
  const fullRows = new Map((full.rows ?? []).map((row) => [row.id, row]));
  const reducedRows = new Map((reduced.rows ?? []).map((row) => [row.id, row]));
  const comparedIds = [...reducedRows.keys()].filter((id) => fullRows.has(id));

  const improved = [];
  const worsened = [];
  const perTool = new Map();

  for (const id of comparedIds) {
    const rowFull = fullRows.get(id);
    const rowReduced = reducedRows.get(id);
    if (rowFull.reviewed === false || rowReduced.reviewed === false) continue;

    const label = rowFull.expectedTool ?? "(none)";
    const bucket = perTool.get(label) ?? { tool: label, total: 0, fullCorrect: 0, reducedCorrect: 0 };
    bucket.total += 1;
    if (rowFull.selectionCorrect) bucket.fullCorrect += 1;
    if (rowReduced.selectionCorrect) bucket.reducedCorrect += 1;
    perTool.set(label, bucket);

    if (rowFull.selectionCorrect && !rowReduced.selectionCorrect) {
      worsened.push({
        id,
        expected: rowFull.expectedTool,
        fullTool: rowFull.actualTool ?? null,
        reducedTool: rowReduced.actualTool ?? null
      });
    }
    if (!rowFull.selectionCorrect && rowReduced.selectionCorrect) {
      improved.push({
        id,
        expected: rowFull.expectedTool,
        fullTool: rowFull.actualTool ?? null,
        reducedTool: rowReduced.actualTool ?? null
      });
    }
  }

  const tools = [...perTool.values()].map((bucket) => {
    const fullAccuracy = ratio(bucket.fullCorrect, bucket.total);
    const reducedAccuracy = ratio(bucket.reducedCorrect, bucket.total);
    return {
      ...bucket,
      fullAccuracy,
      reducedAccuracy,
      delta: fullAccuracy === null || reducedAccuracy === null ? null : reducedAccuracy - fullAccuracy
    };
  });

  return {
    model,
    compared: comparedIds.length,
    improved,
    worsened,
    tools,
    verdict:
      improved.length > worsened.length
        ? "interference"
        : worsened.length > improved.length
          ? "helpful"
          : "neutral"
  };
}

export function formatAblation(payload) {
  const scope = payload.profile ? `，组 ${payload.profile.name}，${payload.profile.tools} 个工具` : "";
  const lines = [
    `ablate: ${payload.tool}（suite ${payload.suite}${scope}，去掉后期望该工具的用例 ${payload.droppedCases} 条）`
  ];

  for (const analysis of payload.models) {
    lines.push("", `[${analysis.model}] 比较用例 ${analysis.compared} 条`);
    lines.push("  tool                    full   reduced   delta");
    lines.push("  ----------------------  -----  --------  -----");
    for (const bucket of analysis.tools) {
      lines.push(
        `  ${bucket.tool.padEnd(22)}  ${percent(bucket.fullAccuracy).padStart(5)}  ${percent(bucket.reducedAccuracy).padStart(8)}  ${signed(bucket.delta).padStart(5)}`
      );
    }
    if (analysis.improved.length > 0) {
      lines.push("  去掉后变对的用例:");
      for (const item of analysis.improved) {
        lines.push(
          `    - ${item.id}: ${item.fullTool ?? "(none)"} → ${item.reducedTool ?? "(none)"}（期望 ${item.expected ?? "(none)"}）`
        );
      }
    }
    if (analysis.worsened.length > 0) {
      lines.push("  去掉后变错的用例:");
      for (const item of analysis.worsened) {
        lines.push(
          `    - ${item.id}: ${item.fullTool ?? "(none)"} → ${item.reducedTool ?? "(none)"}（期望 ${item.expected ?? "(none)"}）`
        );
      }
    }
    const verdict =
      analysis.verdict === "interference"
        ? `存在干扰：去掉 ${payload.tool} 后改善 ${analysis.improved.length} 条、变差 ${analysis.worsened.length} 条`
        : analysis.verdict === "helpful"
          ? `有正向作用：去掉后变差 ${analysis.worsened.length} 条多于改善 ${analysis.improved.length} 条`
          : `影响中性：改善 ${analysis.improved.length} 条、变差 ${analysis.worsened.length} 条`;
    lines.push(`  结论: ${verdict}`);
  }

  return lines.join("\n");
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function percent(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function signed(value) {
  if (value === null) return "n/a";
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}
