import { resolve } from "node:path";
import { executeTool } from "./exec.js";

export async function runExecutionChecks({ suite, cases, summaries, options }) {
  const config = suite.execution ?? {};
  const entry = options.execEntry ?? config.entry;
  if (!entry) {
    throw new Error("--execute 需要 --entry，或套件中的 execution.entry");
  }
  const entryPath = resolve(entry);
  const runtime = config.runtime ?? options.execRuntime ?? "node";
  const engine = runtime === "python" ? "python-audit" : "node-permission";
  const python = config.python ?? options.execPython ?? "python";
  const exportName = config.export ?? options.execExport ?? "run";
  const timeoutMs = config.timeoutMs ?? options.execTimeoutMs ?? 10_000;
  const allowRead = config.allowRead ?? [];
  const allowWrite = config.allowWrite ?? [];
  const allowNet = config.allowNet ?? [];

  const tools = new Map(suite.tools.map((tool) => [tool.name, tool]));

  for (const summary of summaries) {
    const rows = new Map(summary.rows.map((row) => [row.id, row]));
    const results = [];
    let skipped = 0;
    let blocked = 0;

    for (const testCase of cases) {
      const row = rows.get(testCase.id);
      if (!row || row.reviewed === false || !testCase.toolInput || testCase.expectedTool === null) {
        skipped += 1;
        continue;
      }
      if (!row.selectionCorrect) {
        skipped += 1;
        results.push({ id: testCase.id, skipped: true, reason: "selection failed" });
        continue;
      }

      const sideEffects = tools.get(testCase.expectedTool)?.sideEffects ?? null;
      const safe = sideEffects === "none" || sideEffects === "read";
      if (!safe && !options.allowSideEffects) {
        blocked += 1;
        skipped += 1;
        results.push({
          id: testCase.id,
          skipped: true,
          reason: `sideEffects=${sideEffects ?? "unknown"} requires --allow-side-effects`
        });
        continue;
      }

      const execution = await executeTool({
        entry: entryPath,
        runtime,
        python,
        exportName,
        timeoutMs,
        warmup: 0,
        inputJson: JSON.stringify({ tool: testCase.expectedTool, arguments: testCase.toolInput }),
        allowRead,
        allowWrite,
        allowNet
      });

      const checks = evaluateExpect(testCase.expect, execution.result);
      const entryResult = {
        id: testCase.id,
        passed: checks.passed,
        failures: checks.failures,
        sideEffects,
        durationMs: execution.result.metrics?.durationMs ?? null,
        peakRssMB: execution.result.metrics?.peakRssMB ?? null,
        exitCode: execution.code
      };
      results.push(entryResult);
      row.exec = entryResult;
    }

    const executed = results.filter((item) => !item.skipped);
    const durations = executed.map((item) => item.durationMs).filter((value) => typeof value === "number");
    const rss = executed.map((item) => item.peakRssMB).filter((value) => typeof value === "number");
    const passed = executed.filter((item) => item.passed).length;
    summary.exec = {
      engine,
      total: results.length,
      executed: executed.length,
      skipped,
      blocked,
      passed,
      passRate: executed.length > 0 ? passed / executed.length : null,
      p50DurationMs: percentile(durations, 0.5),
      maxPeakRssMB: rss.length > 0 ? Math.max(...rss) : null,
      results
    };
    summary.execPassRate = summary.exec.passRate;
  }
}

function evaluateExpect(expect, execution) {
  const failures = [];
  const expected = expect ?? { ok: true };
  const metrics = execution.metrics ?? {};

  if (expected.ok !== undefined && execution.ok !== expected.ok) {
    failures.push(`ok: expected ${expected.ok}, got ${execution.ok}`);
  }
  if (expected.errorType && execution.error?.name !== expected.errorType) {
    failures.push(`errorType: expected ${expected.errorType}, got ${execution.error?.name ?? "none"}`);
  }
  if (expected.contains !== undefined) {
    const text = JSON.stringify(execution.result ?? "");
    for (const needle of [].concat(expected.contains)) {
      if (!text.includes(String(needle))) failures.push(`contains: 缺少 ${needle}`);
    }
  }
  if (expected.equals !== undefined && JSON.stringify(execution.result) !== JSON.stringify(expected.equals)) {
    failures.push("equals: 返回结果不一致");
  }
  if (typeof expected.maxDurationMs === "number") {
    const value = metrics.durationMs;
    if (typeof value !== "number" || value > expected.maxDurationMs) {
      failures.push(`maxDurationMs: ${value ?? "n/a"} > ${expected.maxDurationMs}`);
    }
  }
  if (typeof expected.maxPeakRssMB === "number") {
    const value = metrics.peakRssMB;
    if (typeof value !== "number" || value > expected.maxPeakRssMB) {
      failures.push(`maxPeakRssMB: ${value ?? "n/a"} > ${expected.maxPeakRssMB}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1));
  return Math.round(sorted[index]);
}
