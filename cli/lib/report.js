import { pct } from "./score.js";
import { suiteFingerprint } from "./fingerprint.js";

const CURRENCY_SYMBOLS = { CNY: "¥", USD: "$" };

function money(value, estimated, currency = "CNY") {
  if (!value) return "0";
  const text = value >= 0.01 ? value.toFixed(3) : value.toFixed(4);
  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  return `${estimated ? "~" : ""}${symbol}${text}`;
}

function isEstimated(summary) {
  return summary.rows.some((row) => row.usage?.estimated);
}

export function formatBucketLine(summary) {
  const parts = [];
  const single = summary.buckets?.singleIntent;
  if (single?.reviewed > 0) {
    parts.push(`singleIntent ${single.selectionHits}/${single.reviewed} (${pct(single.selectionAccuracy)})`);
  }
  for (const bucket of ["multiStep", "ambiguous"]) {
    const entry = summary.buckets?.[bucket];
    if (entry?.reviewed > 0) {
      parts.push(`${bucket} 首轮合法 ${entry.legalFirstSteps}/${entry.reviewed}`);
    }
  }
  if (summary.firstCallMisses > 0) {
    const misses = summary.rows
      .filter((row) => row.bucket !== "singleIntent" && row.reviewed !== false && !row.legalFirstStep)
      .map((row) => row.id);
    parts.push(`首轮未命中 ${summary.firstCallMisses}（${misses.join(", ")}）`);
  }
  return `buckets: ${parts.join(" · ")}`;
}

export function formatCaseLines(summary, cases) {
  const lines = [];
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  for (const row of summary.rows) {
    const testCase = byId.get(row.id);
    const expected = row.expectedTool ?? "(no tool)";
    if (row.bucket && row.bucket !== "singleIntent" && row.legalFirstStep && !row.selectionCorrect) {
      lines.push(`OK   ${row.id}  ${row.actualTool ?? "(no tool)"}  (${row.bucket} 合法首步)`);
    } else if (row.error) {
      lines.push(`FAIL ${row.id}  error: ${row.error}`);
    } else if (!row.selectionCorrect) {
      const miss = row.bucket && row.bucket !== "singleIntent" ? "（不在合法首步集）" : "";
      lines.push(`FAIL ${row.id}  expected ${expected}, got ${row.actualTool ?? "(no tool)"}${miss}`);
    } else if (row.args.failures.length > 0) {
      lines.push(`FAIL ${row.id}  ${row.actualTool}  args mismatch: ${row.args.failures.join(", ")}`);
    } else {
      lines.push(`OK   ${row.id}  ${row.actualTool ?? "(no tool)"}`);
    }
    if (testCase?.note) lines.push(`     note: ${testCase.note}`);
  }
  return lines;
}

export function formatTable(summaries) {
  const headers = ["model", "select", "args", "pass", "p50ms", "p95ms", "cost/call", "errors"];
  const rows = summaries.map((summary) => [
    summary.model,
    pct(summary.selectionAccuracy),
    pct(summary.argAccuracy),
    pct(summary.passRate),
    String(summary.p50LatencyMs),
    String(summary.p95LatencyMs),
    money(summary.avgCost ?? summary.avgCostCny, isEstimated(summary), summary.costCurrency ?? "CNY"),
    String(summary.errors)
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const pad = (value, index) => (index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index]));
  const line = (cells) => cells.map(pad).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  return [line(headers), divider, ...rows.map(line)].join("\n");
}

export function formatMarkdown(suite, cases, summaries) {
  const fingerprint = suiteFingerprint(suite, cases);
  const lines = [
    `# ${suite.name} — function-calling scorecard`,
    "",
    (suite.description || "").trim(),
    "",
    `- Suite: \`${suite.path}\``,
    `- Cases: ${cases.length}`,
    `- Tools: ${suite.tools.map((tool) => tool.name).join(", ")}`,
    `- Fingerprint: \`${fingerprint.hash}\``,
    `- Tool versions: ${fingerprint.tools.map((tool) => `${tool.name}@${tool.hash}`).join(", ")}`,
    ""
  ];

  const withExec = summaries.some((summary) => summary.exec);
  const headers = withExec
    ? ["model", "select", "args", "pass", "exec", "run p50 ms", "max RSS MB", "p50 ms", "p95 ms", "cost/call", "errors"]
    : ["model", "select", "args", "pass", "p50 ms", "p95 ms", "cost/call", "errors"];
  lines.push(`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`);

  for (const summary of summaries) {
    const cells = [
      summary.model,
      pct(summary.selectionAccuracy),
      pct(summary.argAccuracy),
      pct(summary.passRate)
    ];
    if (withExec) {
      cells.push(summary.exec ? `${summary.exec.passed}/${summary.exec.executed}` : "-");
      cells.push(summary.exec?.p50DurationMs ?? "-");
      cells.push(summary.exec?.maxPeakRssMB ?? "-");
    }
    cells.push(
      String(summary.p50LatencyMs),
      String(summary.p95LatencyMs),
      money(summary.avgCost ?? summary.avgCostCny, isEstimated(summary), summary.costCurrency ?? "CNY"),
      String(summary.errors)
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }

  for (const summary of summaries) {
    lines.push(
      "",
      `## ${summary.model}（reviewed ${summary.reviewedTotal}/${summary.total}）`,
      ""
    );
    if (summary.hasBucketVariety) lines.push(formatBucketLine(summary), "");
    const bucketColumn = summary.hasBucketVariety;
    lines.push(
      bucketColumn ? "| case | bucket | expected | got | args | result |" : "| case | expected | got | args | result |",
      bucketColumn ? "| --- | --- | --- | --- | --- | --- |" : "| --- | --- | --- | --- | --- |"
    );
    for (const row of summary.rows) {
      const result = row.error
        ? `error: ${row.error}`
        : row.bucket && row.bucket !== "singleIntent" && row.legalFirstStep && !row.selectionCorrect
          ? "legal first step"
          : row.passed
            ? "pass"
            : "fail";
      const args = row.args.total
        ? `${row.args.matched}/${row.args.total}${row.args.failures.length ? ` (miss: ${row.args.failures.join(", ")})` : ""}`
        : "-";
      const cells = [row.id];
      if (bucketColumn) cells.push(row.bucket ?? "singleIntent");
      cells.push(row.expectedTool ?? "(none)", row.actualTool ?? "(none)", args, result);
      lines.push(`| ${cells.join(" | ")} |`);
    }
  }

  return lines.join("\n");
}
