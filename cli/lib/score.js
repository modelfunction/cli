function normalizeText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "string" && typeof b === "string") {
    return normalizeText(a) === normalizeText(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

export function matchArg(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$exists" in expected) {
      const present = actual !== undefined && actual !== null;
      return present === Boolean(expected.$exists);
    }
    if ("$contains" in expected) {
      const needle = normalizeText(expected.$contains);
      if (typeof actual === "string") return normalizeText(actual).includes(needle);
      if (Array.isArray(actual)) {
        return actual.some((item) => normalizeText(item).includes(needle));
      }
      return false;
    }
    if ("$oneOf" in expected) {
      return expected.$oneOf.some((option) => deepEqual(actual, option));
    }
  }
  return deepEqual(actual, expected);
}

export function matchArgs(actualArgs, expectedArgs) {
  const fields = Object.entries(expectedArgs ?? {});
  const failures = [];
  for (const [key, expected] of fields) {
    if (!matchArg(actualArgs?.[key], expected)) failures.push(key);
  }
  return {
    total: fields.length,
    matched: fields.length - failures.length,
    failures
  };
}

// Even at temperature 0 providers can flip a tool call between identical
// requests. Repeats exist so the scorecard can show that instead of baking one
// sample into the number.
export function pickRepresentative(runs) {
  const signature = (run) => (run?.ok ? run.toolCalls?.[0]?.name ?? "(no tool)" : `error: ${run?.error ?? ""}`);
  const counts = new Map();
  for (const run of runs) {
    const key = signature(run);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  for (const [key, count] of counts) {
    if (!best || count > best.count) best = { key, count };
  }
  const chosen = runs.find((run) => signature(run) === best.key) ?? runs[0];
  return {
    result: chosen,
    unstable: counts.size > 1,
    outcomes: [...counts.entries()].map(([outcome, count]) => ({ outcome, count }))
  };
}

export function tokensOf(usage) {
  return (usage?.input ?? 0) + (usage?.output ?? 0);
}

export function costOf(usage, pricing) {
  if (!pricing) return 0;
  const input = usage?.input ?? 0;
  const cached = Math.min(input, usage?.cached ?? 0);
  const output = usage?.output ?? 0;
  return (
    ((input - cached) * (pricing.input ?? 0) +
      cached * (pricing.cachedInput ?? pricing.input ?? 0) +
      output * (pricing.output ?? 0)) /
    1e6
  );
}

export function scoreModel({ model, cases, results, pricing, scope = "base", currency = "CNY" }) {
  const rows = cases.map((testCase, index) => {
    const result = results[index];
    const actualTool = result.ok ? (result.toolCalls?.[0]?.name ?? null) : null;
    const selectionCorrect = Boolean(result.ok) && actualTool === testCase.expectedTool;
    const args = selectionCorrect && testCase.expectedTool
      ? matchArgs(result.toolCalls?.[0]?.arguments, testCase.expectedArgs)
      : { total: 0, matched: 0, failures: [] };
    const passed = Boolean(result.ok) && selectionCorrect && args.failures.length === 0;
    const error = result.error ?? null;
    return {
      id: testCase.id,
      expectedTool: testCase.expectedTool,
      actualTool,
      selectionCorrect,
      args,
      passed,
      reviewed: testCase.reviewed !== false,
      ...(testCase.excludeFromBase ? { excludeFromBase: true } : {}),
      ...(testCase.excludeFromProfiles ? { excludeFromProfiles: true } : {}),
      source: testCase.source ?? "manual",
      latencyMs: result.latencyMs ?? 0,
      usage: result.usage ?? { input: 0, output: 0 },
      ...(result.retries > 0 ? { retries: result.retries } : {}),
      error,
      ...(error ? { errorKind: classifyError(error) } : {})
    };
  });

  const total = rows.length;
  // An excluded case still runs (so profile / all-in-one views keep their rows);
  // it just does not contribute to this scope's official metrics.
  const excluded = (row) => (scope === "profiles" ? row.excludeFromProfiles : row.excludeFromBase);
  const reviewedRows = rows.filter((row) => row.reviewed && !excluded(row));
  const unreviewedRows = rows.filter((row) => !row.reviewed);
  const excludedRows = rows.filter((row) => row.reviewed && excluded(row));
  const selectionHits = reviewedRows.filter((row) => row.selectionCorrect).length;
  const argFields = reviewedRows.reduce((sum, row) => sum + row.args.total, 0);
  const argHits = reviewedRows.reduce((sum, row) => sum + row.args.matched, 0);
  const passed = reviewedRows.filter((row) => row.passed).length;
  const errorRows = reviewedRows.filter((row) => row.error);
  const errors = errorRows.length;
  const errorsByKind = errorRows.reduce((counts, row) => {
    counts[row.errorKind] = (counts[row.errorKind] ?? 0) + 1;
    return counts;
  }, {});
  const scoredTotal = reviewedRows.length - errors;
  const selectionHitsWithoutErrors = reviewedRows.filter((row) => !row.error && row.selectionCorrect).length;
  const latencies = rows.filter((row) => row.latencyMs > 0).map((row) => row.latencyMs);
  const inputTokens = rows.reduce((sum, row) => sum + (row.usage.input ?? 0), 0);
  const outputTokens = rows.reduce((sum, row) => sum + (row.usage.output ?? 0), 0);
  const cachedTokens = Math.min(
    inputTokens,
    rows.reduce((sum, row) => sum + (row.usage.cached ?? 0), 0)
  );
  const totalCost = rows.reduce((sum, row) => sum + costOf(row.usage, pricing), 0);
  const totalTokens = inputTokens + outputTokens;
  const costCurrency = String(currency || "CNY").trim().toUpperCase();
  const reviewedTotal = reviewedRows.length;

  return {
    model,
    total,
    reviewedTotal,
    excludedTotal: excludedRows.length,
    unreviewedTotal: unreviewedRows.length,
    unreviewedSelectionAccuracy: unreviewedRows.length
      ? unreviewedRows.filter((row) => row.selectionCorrect).length / unreviewedRows.length
      : null,
    selectionAccuracy: reviewedTotal ? selectionHits / reviewedTotal : 0,
    selectionAccuracyExcludingErrors: scoredTotal ? selectionHitsWithoutErrors / scoredTotal : null,
    argAccuracy: argFields ? argHits / argFields : null,
    passRate: reviewedTotal ? passed / reviewedTotal : 0,
    errors,
    errorsByKind,
    scoredTotal,
    retries: rows.reduce((sum, row) => sum + (row.retries ?? 0), 0),
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    avgCost: total ? totalCost / total : 0,
    totalCost,
    costCurrency,
    ...(costCurrency === "CNY"
      ? { avgCostCny: total ? totalCost / total : 0, totalCostCny: totalCost }
      : {}),
    inputTokens,
    cachedTokens,
    outputTokens,
    totalTokens,
    rows
  };
}

export function classifyError(error) {
  const text = String(error ?? "");
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/^HTTP 429\b/.test(text)) return "rate-limit";
  if (/^HTTP \d{3}\b/.test(text)) return "http";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(text)) return "network";
  return "other";
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1));
  return Math.round(sorted[index]);
}

export function pct(value) {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}
