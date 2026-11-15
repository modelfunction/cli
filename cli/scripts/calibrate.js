#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSuite } from "../lib/lint.js";

export function runCalibration(calibration) {
  const rules = calibration.rules ?? [];
  const failures = [];
  let passed = 0;

  for (const entry of rules) {
    const anchorCodes = codesOf(entry.positiveAnchor?.suite);
    const guardCodes = codesOf(entry.falsePositiveGuard?.suite);
    const anchorOk = anchorCodes.includes(entry.rule);
    const guardOk = !guardCodes.includes(entry.rule);
    if (anchorOk && guardOk) {
      passed += 1;
    } else {
      failures.push({
        rule: entry.rule,
        anchorOk,
        guardOk,
        anchorCodes,
        guardCodes
      });
    }
  }

  return { total: rules.length, passed, failures };
}

function codesOf(suite) {
  if (!suite) return [];
  return lintSuite({ ...suite, tools: suite.tools ?? [] }).findings.map((finding) => finding.code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node scripts/calibrate.js <calibration.json>\n");
    process.exit(1);
  }
  const calibration = JSON.parse(await readFile(resolve(path), "utf8"));
  const result = runCalibration(calibration);
  process.stdout.write(
    `${result.passed}/${result.total} rules pass` +
      (calibration.generatedAgainst ? ` (generatedAgainst: ${calibration.generatedAgainst})` : "") +
      "\n"
  );
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      process.stderr.write(
        `${failure.rule}: anchor=${failure.anchorOk ? "ok" : JSON.stringify(failure.anchorCodes)} ` +
          `guard=${failure.guardOk ? "ok" : JSON.stringify(failure.guardCodes)}\n`
      );
    }
    process.exit(1);
  }
}
