#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuite, toModelTools } from "./lib/suite.js";
import { scoreModel, pickRepresentative, pct, costOf, tokensOf } from "./lib/score.js";
import { formatTable, formatCaseLines, formatMarkdown, formatBucketLine } from "./lib/report.js";
import { scanProject, buildSuiteDraft, formatScanSummary, addTools, redactReport } from "./lib/scan.js";
import { probeStdioServer, probeHttpServer } from "./lib/mcp-probe.js";
import { loadAdapterTools } from "./lib/adapter-import.js";
import { addCases, computeCoverage, formatCoverage } from "./lib/cases.js";
import { lintSuite, formatLint } from "./lib/lint.js";
import { check, checkMany, formatCheck, formatCheckMany } from "./lib/check.js";
import { auditSuite, formatAudit } from "./lib/audit.js";
import { suiteFingerprint, hashText, hashOf } from "./lib/fingerprint.js";
import { runExecutionChecks } from "./lib/eval-exec.js";
import { checkSandbox, formatSandboxReport } from "./lib/sandbox-check.js";
import { compareScorecards, formatCompare, regressionGate } from "./lib/compare.js";
import { analyzeAblation, formatAblation } from "./lib/ablate.js";
import { clusterTools, formatClusters } from "./lib/cluster.js";
import {
  normalizeProfiles,
  selectProfiles,
  selectProfileCases,
  profileWarnings,
  analyzeMount,
  modelTotals,
  profileCaseCoverage,
  formatProfileReport,
  formatProfileMarkdown
} from "./lib/profile.js";
import { runExec } from "./lib/exec.js";
import { createBudget, CostLimitError, TokenLimitError } from "./lib/budget.js";
import { writeFileAtomic } from "./lib/fsutil.js";
import {
  applyModelCredentials,
  credentialsPath,
  listCredentials,
  redactText,
  registerSecrets,
  removeCredential,
  setCredential
} from "./lib/credentials.js";
import {
  buildFeedbackBundle,
  defaultFeedbackPath,
  formatStats,
  noteUsage,
  readUsageEvents,
  recordRunSync,
  summarizeUsage,
  usageDir
} from "./lib/usage.js";
import { createMockAdapter } from "./lib/adapters/mock.js";
import { createOpenAiAdapter } from "./lib/adapters/openai.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUITE = resolve(HERE, "fixtures/suite.json");
const DEFAULT_MODELS = resolve(HERE, "fixtures/models.json");

const SYSTEM_PROMPT = [
  "You are a tool-calling assistant.",
  "Call exactly one tool when the user request clearly matches it.",
  "Do not call any tool when no tool applies; ask a clarifying question instead of inventing arguments.",
  "Only use values that appear in the user message."
].join(" ");

const USAGE = `mf — function-calling accuracy scorecard

Usage:
  mf eval [options]
  mf scan [options]
  mf case add --suite <file> (--input <file> | stdin) [--source agent] [--reviewed] [--dry-run]
  mf coverage [--suite <file>] [--json]
  mf audit [--suite <file>] [--out <file>] [--json]  # 静态审计：lint + 分组边界 + 用例覆盖 + 挂载
  mf lint [--suite <file>] [--json]  # 静态检查 tools 与 skills，不调用模型
  mf check (--manifest <file> | --manifests <file>) [--installed <file>] [--json]  # 安装门禁：新能力 × 已装能力（--manifests 支持一包）
  mf compare <before.json> <after.json> [--fail-on-regression] [--json]
  mf ablate --tool <name> [--suite <file>] [--profile <group>] [--models <ids>] [--max-cost <amount>] [--max-tokens <n>] [--progress] [--json]
  mf cluster [--suite <file>] [--threshold <0.5>] [--max-size <10>] [--out <file>] [--json]  # 建议挂载分组 + 同族候选
  mf exec --entry <file> (--input <json> | --input-json <json>) [--runtime node|python] [--python <cmd>] [--export run] [--allow-read <paths>] [--allow-write <paths>] [--allow-net <hosts>] [--timeout <ms>] [--warmup <n>] [--json]
  mf sandbox check [--json]   # probe available isolation engines on this machine
  mf config set-key <ENV_NAME>  # store a model key in ~/.modelfunction/credentials.json (hidden input)
  mf config remove-key <ENV_NAME>  # delete a stored key
  mf config list [--json]       # names + masked values only
  mf config path                # print the credentials file path
  mf stats [--json]             # local usage summary (never uploaded)
  mf feedback [--out <file>] [--json]  # export a redacted feedback bundle; you decide whether to send it
  mf mcp                # start stdio MCP server for coding agents

Eval options:
  --suite <path>        eval suite (default: built-in demo suite)
  --models <ids>        comma-separated ids from models.json (default: models with API keys set)
  --models-file <path>  model registry (default: built-in registry)
  --case <ids>          run only these case ids (comma-separated, repeatable)
  --profile <names>     score each mounted group separately ("all" or names from suite.profiles)
  --repeat <n>          run each case n times and score the majority; reports unstable cases (default 1)
  --max-cost <amount>   stop after the estimated spend crosses this limit (exit 2; no partial scorecard)
  --max-tokens <n>      stop after cumulative input+output tokens cross this limit (exit 2)
  --retry <n>           retries per request on HTTP 429/5xx and network errors (default 2; 3 attempts total)
  --min-interval <ms>   minimum spacing between model requests; use it to stay under an endpoint RPM
  --progress            print per-case progress to stderr (stdout stays clean for --json)
  --show-cases          print per-case results
  --json                print JSON instead of the table
  --out <file>          write scorecard (.md => markdown, otherwise JSON)
  --fail-under <ratio>  exit 2 if any model's selection accuracy is below ratio (e.g. 0.8)
  --baseline <file>     previous scorecard JSON (used with --fail-on-regression)
  --fail-on-regression  exit 2 if any reviewed case regressed vs --baseline
  --execute             run toolInput and assert expect (needs --entry or suite.execution.entry)
  --exec-timeout <ms>   per execution timeout (suite.execution.timeoutMs or 10000)
  --allow-side-effects  allow executing tools declaring write/external/unknown sideEffects

Scan options:
  --root <dir>          repository to scan (default: .)
  --from <file>         import tools from a module (export default [...] or export const tools)
  --probe               connect stdio or streamable-HTTP MCP servers and read tools/list
  --timeout <ms>        probe timeout per server (default: 5000)
  --out <file>          suite draft to write (default: mf.suite.json)
  --report <file>       scan report to write (default: mf.scan.json)
  --no-write            print only, do not write files

Env keys: DEEPSEEK_API_KEY, DASHSCOPE_API_KEY, ZHIPU_API_KEY, OPENAI_API_KEY, SILICONFLOW_API_KEY
Credentials: env vars win; missing model keys are read from ~/.modelfunction/credentials.json (MF_CONFIG_DIR overrides).
Usage: recorded locally under ~/.modelfunction/usage (counts only, never uploaded); MF_NO_USAGE=1 opts out.

Examples:
  mf eval --models mock --show-cases
  mf eval --models deepseek,qwen --out scorecard.md
  mf scan
  mf scan --root ../my-agent --no-write
  mf case add --suite mf.suite.json --input cases.json
  mf coverage --suite mf.suite.json
`;

export async function runEval(options, io = console) {
  if (options.profiles && options.execute) {
    throw new Error("--profile 暂不支持与 --execute 组合");
  }
  const suite = await loadSuite(options.suite);
  const cases = selectCases(suite.cases, options.cases);
  const { registry, adapters } = await resolveModels(options.models, options.modelsFile, io, {
    retries: options.retries,
    minIntervalMs: options.minIntervalMs
  });
  const tools = toModelTools(suite.tools);

  const budget = createBudget({ maxCost: options.maxCost ?? null, maxTokens: options.maxTokens ?? null });
  const runs = [];
  try {
    for (const adapter of adapters) {
      const config = registry[adapter.id];
      const pricing = config?.pricing ?? null;
      const currency = currencyOf(adapter.id, config);
      const evaluated = await evaluate(adapter, tools, cases, options.repeat ?? 1, {
        pricing,
        budget,
        onProgress: makeProgress(options, io, adapter.id, cases.length)
      });
      const summary = scoreModel({
        model: adapter.id,
        cases,
        results: evaluated.results,
        pricing,
        scope: "base",
        currency
      });
      if (evaluated.stability) summary.stability = evaluated.stability;
      runs.push({ adapter, results: evaluated.results, summary });
    }
  } catch (error) {
    if (error instanceof CostLimitError || error instanceof TokenLimitError) {
      io.error(budgetLimitMessage(error));
      return 2;
    }
    throw error;
  }
  const summaries = runs.map((run) => run.summary);

  let executionInfo = null;
  if (options.execute) {
    const entry = options.execEntry ?? options.entry ?? suite.execution?.entry;
    if (!entry) throw new Error("--execute 需要 --entry，或套件中的 execution.entry");
    await runExecutionChecks({
      suite,
      cases,
      summaries,
      options: {
        ...options,
        execEntry: entry,
        execRuntime: options.runtime,
        execPython: options.python
      }
    });
    const entryPath = resolve(entry);
    const runtime = suite.execution?.runtime ?? options.runtime ?? "node";
    executionInfo = {
      runtime,
      engine: runtime === "python" ? "python-audit" : "node-permission",
      entry: basename(entryPath),
      hash: hashText(await readFile(entryPath, "utf8"))
    };
  }

  let profileReport = null;
  if (options.profiles) {
    try {
      profileReport = await evaluateProfiles({
        suite,
        cases,
        runs,
        registry,
        selection: options.profiles,
        repeat: options.repeat ?? 1,
        budget,
        progress: options.progress,
        io
      });
    } catch (error) {
      if (error instanceof CostLimitError || error instanceof TokenLimitError) {
        io.error(budgetLimitMessage(error));
        return 2;
      }
      throw error;
    }
  }

  if (options.out) {
    const target = resolve(options.out);
    const markdown = extname(target).toLowerCase() === ".md";
    const payload = markdown
      ? formatMarkdown(suite, cases, summaries) +
        (profileReport ? `\n\n${formatProfileMarkdown(profileReport)}` : "")
      : JSON.stringify(serialize(suite, cases, summaries, executionInfo, profileReport), null, 2);
    await writeFileAtomic(target, payload);
    io.log(`wrote ${target}`);
  }

  if (options.json) {
    io.log(JSON.stringify(serialize(suite, cases, summaries, executionInfo, profileReport), null, 2));
  } else {
    io.log(`suite: ${suite.name} — ${cases.length} cases, ${suite.tools.length} tools`);
    io.log(`file:  ${suite.path}`);
    for (const summary of summaries) {
      io.log("");
      if (options.showCases) {
        io.log(`[${summary.model}]`);
        for (const line of formatCaseLines(summary, cases)) io.log(`  ${line}`);
        io.log("");
      }
      io.log(formatTable([summary]));
      if (summary.hasBucketVariety) io.log(formatBucketLine(summary));
      if (summary.stability) {
        const unstable = summary.stability.unstable;
        const list = unstable.slice(0, 8).map((item) => item.id).join(", ");
        io.log(
          `stability: ${summary.stability.runs} 次/用例，${unstable.length} 条结果不稳定` +
            (unstable.length > 0 ? `（${list}${unstable.length > 8 ? "…" : ""}）` : "")
        );
      }
      if (summary.unreviewedTotal > 0) {
        io.log(`note: ${summary.unreviewedTotal} unreviewed case(s) excluded from select/args/pass`);
      }
      if (summary.excludedTotal > 0) {
        io.log(`note: ${summary.excludedTotal} case(s) marked excludeFromBase, excluded from base score`);
      }
      if (summary.errors > 0) {
        const kinds = Object.entries(summary.errorsByKind)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(", ");
        io.log(`note: ${summary.errors} call error(s) counted as misses (${kinds})`);
      }
      if (summary.exec) {
        const parts = [
          `exec: ${summary.exec.passed}/${summary.exec.executed} passed`,
          `engine ${summary.exec.engine}`
        ];
        if (summary.exec.skipped > 0) {
          parts.push(
            `${summary.exec.skipped} skipped${summary.exec.blocked > 0 ? `（${summary.exec.blocked} 因 sideEffects 被拦截，需 --allow-side-effects）` : ""}`
          );
        }
        if (summary.exec.p50DurationMs !== null) parts.push(`p50 ${summary.exec.p50DurationMs}ms`);
        if (summary.exec.maxPeakRssMB !== null) parts.push(`peak ${summary.exec.maxPeakRssMB}MB`);
        io.log(parts.join(", "));
      }
    }
    if (summaries.length > 1) {
      io.log("");
      io.log("combined");
      io.log(formatTable(summaries));
    }
    if (profileReport) {
      io.log("");
      io.log(formatProfileReport(profileReport, { showCases: options.showCases }));
    }
    if (summaries.some((summary) => summary.rows.some((row) => row.usage?.estimated))) {
      io.log("");
      io.log("note: tokens marked with ~ are estimated (mock adapter); pricing in models.json is indicative.");
    }
    if (summaries.some((summary) => summary.model === "mock")) {
      io.log("");
      io.log("note: mock 是规则路由器，只用于验证流程；它在你自己的工具上得低分不代表真实模型表现，请用 --models <id> 测真实模型。");
    }
  }

  let regressions = [];
  if (options.failOnRegression) {
    if (!options.baseline) {
      io.error("--fail-on-regression requires --baseline <scorecard.json>");
      return 2;
    }
    const baseline = JSON.parse(await readFile(resolve(options.baseline), "utf8"));
    const comparison = compareScorecards(baseline, serialize(suite, cases, summaries, executionInfo));
    if (!options.json) {
      io.log("");
      io.log(formatCompare(comparison));
    }
    const gate = regressionGate(comparison, summaries);
    if (gate.status === "fail") {
      io.error(gate.message);
      return 2;
    }
    if (gate.status === "skip") {
      io.error(gate.message);
    } else {
      regressions = gate.regressions;
      if (regressions.length > 0) io.error(`regressions: ${regressions.join(", ")}`);
    }
  }

  const failed = options.failUnder === null
    ? []
    : summaries.filter((summary) => headlineSelection(summary) < options.failUnder);
  const profileBelow =
    profileReport && options.failUnder !== null
      ? profileReport.models.flatMap((model) =>
          model.profiles
            .filter((entry) => entry.reviewed > 0 && headlineSelection(entry.mounted) < options.failUnder)
            .map((entry) => `${model.model}/${entry.profile} (${pct(headlineSelection(entry.mounted))})`)
        )
      : [];

  noteUsage({
    models: summaries.map((summary) => summary.model),
    caseCount: cases.length,
    toolCount: suite.tools.length,
    reviewedCount: cases.filter((testCase) => testCase.reviewed !== false).length,
    repeat: options.repeat ?? 1,
    profileGroups: profileReport ? profileReport.groups.length : 0,
    selectionAccuracy: average(summaries.map((summary) => headlineSelection(summary))),
    argAccuracy: average(summaries.map((summary) => summary.argAccuracy)),
    passRate: average(summaries.map((summary) => summary.passRate)),
    unstableCases: summaries.reduce((total, summary) => total + (summary.stability?.unstable.length ?? 0), 0),
    execEngine: executionInfo?.engine,
    execExecuted: sumExec(summaries, "executed"),
    execPassed: sumExec(summaries, "passed"),
    execBlocked: sumExec(summaries, "blocked"),
    execSkipped: sumExec(summaries, "skipped"),
    failedThreshold: failed.length > 0 || profileBelow.length > 0,
    regressions: regressions.length > 0
  });

  if (failed.length > 0) {
    io.error(
      `below threshold ${pct(options.failUnder)}: ${failed
        .map((summary) => `${summary.model} (${pct(headlineSelection(summary))})`)
        .join(", ")}`
    );
    return 2;
  }
  if (profileBelow.length > 0) {
    io.error(`profile below threshold ${pct(options.failUnder)}: ${profileBelow.join(", ")}`);
    return 2;
  }
  if (regressions.length > 0) return 2;
  return 0;
}

// singleIntent is the only externally claimable headline; legacy suites have
// no other bucket, so this equals selectionAccuracy there.
function headlineSelection(summary) {
  return summary.selectionAccuracySingleIntent ?? summary.selectionAccuracy;
}

function average(values) {
  const usable = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (usable.length === 0) return undefined;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function sumExec(summaries, field) {
  return summaries.reduce((total, summary) => total + (summary.exec?.[field] ?? 0), 0);
}

export async function runAblate(options, io = console) {
  const suite = await loadSuite(resolve(options.suite ?? DEFAULT_SUITE));
  if (!options.tool) throw new Error("--tool is required");
  const ablated = suite.tools.find((tool) => tool.name === options.tool);
  if (!ablated) throw new Error(`unknown tool "${options.tool}"`);

  const scope = options.profiles && options.profiles.length > 0 ? ablationScope(suite, options.profiles) : null;
  if (scope && !scope.tools.some((tool) => tool.name === ablated.name)) {
    throw new Error(`tool "${ablated.name}" 不在组 "${scope.name}" 里`);
  }

  const selectedCases = selectCases(suite.cases, options.cases);
  const baseTools = scope ? scope.tools : suite.tools;
  const baseCases = scope
    ? selectProfileCases(selectedCases, new Set(scope.tools.map((tool) => tool.name)))
    : selectedCases;
  const reducedCases = baseCases.filter((testCase) => testCase.expectedTool !== ablated.name);
  const droppedCases = baseCases.length - reducedCases.length;
  const { registry, adapters } = await resolveModels(options.models, options.modelsFile, io, {
    retries: options.retries,
    minIntervalMs: options.minIntervalMs
  });

  const fullTools = toModelTools(baseTools);
  const reducedTools = toModelTools(baseTools.filter((tool) => tool.name !== ablated.name));
  const models = [];
  const budget = createBudget({ maxCost: options.maxCost ?? null, maxTokens: options.maxTokens ?? null });

  try {
    for (const adapter of adapters) {
      const config = registry[adapter.id];
      const pricing = config?.pricing ?? null;
      const currency = currencyOf(adapter.id, config);
      const fullResults = (
        await evaluate(adapter, fullTools, baseCases, 1, {
          pricing,
          budget,
          onProgress: makeProgress(options, io, `${adapter.id}/full`, baseCases.length)
        })
      ).results;
      const full = scoreModel({ model: adapter.id, cases: baseCases, results: fullResults, pricing, currency });
      const reducedResults = (
        await evaluate(adapter, reducedTools, reducedCases, 1, {
          pricing,
          budget,
          onProgress: makeProgress(options, io, `${adapter.id}/ablated`, reducedCases.length)
        })
      ).results;
      const reduced = scoreModel({ model: adapter.id, cases: reducedCases, results: reducedResults, pricing, currency });
      models.push(analyzeAblation(adapter.id, full, reduced));
    }
  } catch (error) {
    if (error instanceof CostLimitError || error instanceof TokenLimitError) {
      io.error(budgetLimitMessage(error));
      return 2;
    }
    throw error;
  }

  const payload = {
    tool: ablated.name,
    suite: suite.name,
    droppedCases,
    models,
    ...(scope ? { profile: { name: scope.name, tools: baseTools.length } } : {})
  };
  noteUsage({
    models: models.map((model) => model.model),
    caseCount: baseCases.length,
    toolCount: baseTools.length,
    profileGroups: scope ? 1 : 0
  });
  io.log(options.json ? JSON.stringify(payload, null, 2) : formatAblation(payload));
  return 0;
}

export async function runScan(options, io = console) {
  const report = await scanProject(options.root ?? ".");

  if (options.from) {
    const tools = await loadAdapterTools(options.from);
    addTools(report, tools, {
      source: relative(process.cwd(), resolve(options.from)) || options.from,
      origin: "adapter",
      confidence: "high",
      note: "从用户模块动态导入，schema 为运行时真实值"
    });
  }

  if (options.probe) {
    for (const server of [...report.mcpServers]) {
      const result =
        server.transport === "stdio"
          ? await probeStdioServer(server, { timeoutMs: options.timeoutMs })
          : await probeHttpServer(server, { timeoutMs: options.timeoutMs });
      if (!result.ok) {
        report.probes.push({ server: server.name, ok: false, error: result.error, stderr: result.stderr });
        continue;
      }
      const added = addTools(report, result.tools, {
        source: server.source,
        origin: "mcp-probe",
        confidence: "high",
        replaceExisting: true,
        note: `server ${server.name}`,
        meta: { provider: server.name }
      });
      report.probes.push({ server: server.name, ok: true, toolCount: added.length, tools: added });
    }
  }

  noteUsage({
    scanTools: report.tools.length,
    scanSkills: report.skills.length,
    scanMcpServers: report.mcpServers.length,
    scanProbes: report.probes.length
  });

  const draft = buildSuiteDraft(report);

  if (options.json) {
    io.log(JSON.stringify({ report: redactReport(report), draft }, null, 2));
    return report.tools.length > 0 || report.skills.length > 0 ? 0 : 3;
  }

  io.log(formatScanSummary(report));

  if (!options.noWrite) {
    const suitePath = resolve(options.out ?? "mf.suite.json");
    const reportPath = resolve(options.report ?? "mf.scan.json");
    await writeFileAtomic(suitePath, JSON.stringify(draft, null, 2));
    await writeFileAtomic(reportPath, JSON.stringify(redactReport(report), null, 2));
    io.log("");
    io.log(`wrote ${suitePath}`);
    io.log(`wrote ${reportPath}`);
  }

  return report.tools.length > 0 || report.skills.length > 0 ? 0 : 3;
}

export async function runCaseAdd(options, io = console) {
  const suitePath = resolve(options.suite ?? DEFAULT_SUITE);
  let payload;
  if (options.inputPath) {
    payload = JSON.parse(await readFile(resolve(options.inputPath), "utf8"));
  } else {
    payload = JSON.parse(await readStdin());
  }

  const result = await addCases(suitePath, payload, {
    source: options.source,
    reviewed: options.reviewed,
    dryRun: options.dryRun
  });

  io.log(`suite: ${result.path}`);
  io.log(`added: ${result.added.length}${result.dryRun ? " (dry-run)" : ""}`);
  for (const testCase of result.added) {
    io.log(
      `  + ${testCase.id} → ${testCase.expectedTool ?? "(no tool)"} [${testCase.source}${testCase.reviewed ? ", reviewed" : ""}]`
    );
  }
  if (result.warnings.length > 0) {
    for (const warning of result.warnings) io.error(`warn: ${warning}`);
  }
  if (result.rejected.length > 0) {
    io.error(`rejected: ${result.rejected.length}`);
    for (const item of result.rejected) io.error(`  - ${item.id}: ${item.reason}`);
    return 1;
  }
  return 0;
}

export async function runCoverage(options, io = console) {
  // A scan draft has no cases yet; "what is still missing" is exactly the view
  // a user needs right after scanning. A skills-only suite is also valid.
  const suite = await loadSuite(resolve(options.suite ?? DEFAULT_SUITE), {
    allowEmptyCases: true,
    allowEmptyTools: true
  });
  const report = computeCoverage(suite);
  noteUsage({ toolCount: suite.tools.length, caseCount: suite.cases.length });
  io.log(options.json ? JSON.stringify(report, null, 2) : formatCoverage(report));
  return 0;
}

export async function runAudit(options, io = console) {
  const suite = await loadSuite(resolve(options.suite ?? DEFAULT_SUITE), {
    allowEmptyCases: true,
    allowEmptyTools: true
  });
  const report = auditSuite(suite);
  const rules = {};
  for (const finding of report.lint.findings) rules[finding.code] = (rules[finding.code] ?? 0) + 1;
  noteUsage({
    toolCount: report.suite.tools,
    caseCount: report.suite.cases,
    lintErrors: report.lint.counts.error,
    lintWarns: report.lint.counts.warn,
    lintInfos: report.lint.counts.info,
    lintRules: rules,
    clusters: report.clusters.clusters.length,
    profileGroups: report.profiles?.groups.length ?? 0
  });

  if (options.out) {
    const target = resolve(options.out);
    const markdown = extname(target).toLowerCase() === ".md";
    await writeFileAtomic(target, markdown ? `${formatAudit(report)}\n` : `${JSON.stringify(report, null, 2)}\n`);
    io.log(`wrote ${target}`);
  }
  io.log(options.json ? JSON.stringify(report, null, 2) : formatAudit(report));
  return 0;
}

export async function runSandboxCheck(options, io = console) {
  const report = checkSandbox();
  io.log(options.json ? JSON.stringify(report, null, 2) : formatSandboxReport(report));
  return 0;
}

// Advisory install gate: static only, never blocks. Exit code stays 0 for a
// warn verdict so a platform can log it without failing the install.
export async function runCheck(options, io = console) {
  const installed = options.installed
    ? JSON.parse(await readFile(resolve(options.installed), "utf8"))
    : [];

  if (options.manifests) {
    const manifests = JSON.parse(await readFile(resolve(options.manifests), "utf8"));
    const result = checkMany({ manifests, installed });
    noteUsage({
      checkVerdict: result.verdict,
      checkFindings: Object.values(result.summary).reduce((sum, count) => sum + count, 0)
    });
    io.log(options.json ? JSON.stringify(result, null, 2) : formatCheckMany(result));
    return 0;
  }
  if (!options.manifest) {
    throw new Error("--manifest 或 --manifests <file> 必填（[name, description, parameters?]）");
  }
  const manifest = JSON.parse(await readFile(resolve(options.manifest), "utf8"));
  const result = check({ manifest, installed });
  noteUsage({ checkVerdict: result.verdict, checkFindings: result.findings.length });
  io.log(options.json ? JSON.stringify(result, null, 2) : formatCheck(result));
  return 0;
}

export async function runLint(options, io = console) {
  const suite = await loadSuite(resolve(options.suite ?? DEFAULT_SUITE), {
    allowEmptyCases: true,
    allowEmptyTools: true
  });
  const report = lintSuite(suite);
  const rules = {};
  for (const finding of report.findings) rules[finding.code] = (rules[finding.code] ?? 0) + 1;
  noteUsage({
    toolCount: report.tools,
    lintErrors: report.counts.error,
    lintWarns: report.counts.warn,
    lintInfos: report.counts.info,
    lintRules: rules
  });
  io.log(options.json ? JSON.stringify(report, null, 2) : formatLint(report));
  return report.counts.error > 0 ? 1 : 0;
}

export async function runCompare(options, io = console) {
  const [beforePath, afterPath] = options.paths;
  const before = JSON.parse(await readFile(resolve(beforePath), "utf8"));
  const after = JSON.parse(await readFile(resolve(afterPath), "utf8"));
  const report = compareScorecards(before, after);
  io.log(options.json ? JSON.stringify(report, null, 2) : formatCompare(report));
  const regressions = report.models
    .filter((model) => model.comparable && model.reviewed > 0)
    .flatMap((model) => (model.regressions ?? []).map((item) => `${model.model}/${item.id}`));
  if (options.failOnRegression && regressions.length > 0) {
    io.error(`regressions: ${regressions.join(", ")}`);
    return 2;
  }
  const changed = report.toolChanges.length > 0 || report.caseChanges.length > 0;
  return changed ? 1 : 0;
}

export async function runConfig(options, io = console) {
  const [sub, name] = options.args ?? [];
  if (sub === "set-key") {
    if (!name) throw new Error("usage: mf config set-key <ENV_NAME>");
    const value = await (options.readSecret ?? readSecret)(`${name}: `);
    const result = await setCredential(name, value);
    io.log(`saved ${result.name} → ${result.path}`);
    io.log("permissions: 0600 where supported. env vars still win; CI should use env or a secret manager.");
    return 0;
  }
  if (sub === "remove-key") {
    if (!name) throw new Error("usage: mf config remove-key <ENV_NAME>");
    const result = await removeCredential(name);
    io.log(
      result.removed
        ? `removed ${result.name} from ${result.path}`
        : `${result.name} is not stored (${result.path})`
    );
    return 0;
  }
  if (sub === "list") {
    const entries = await listCredentials();
    if (options.json) {
      io.log(JSON.stringify({ path: credentialsPath(), keys: entries }, null, 2));
      return 0;
    }
    if (entries.length === 0) {
      io.log(`no stored keys (${credentialsPath()})`);
      return 0;
    }
    for (const entry of entries) io.log(`${entry.name}  ${entry.masked}`);
    io.log(`file: ${credentialsPath()}`);
    return 0;
  }
  if (sub === "path") {
    io.log(credentialsPath());
    return 0;
  }
  throw new Error("usage: mf config <set-key <ENV_NAME> | remove-key <ENV_NAME> | list | path>");
}

export async function runStats(options, io = console) {
  const { events, files, skipped } = await readUsageEvents();
  const summary = summarizeUsage(events);
  if (options.json) {
    io.log(JSON.stringify({ path: usageDir(), files: files.length, skipped, ...summary }, null, 2));
  } else {
    io.log(formatStats(summary, { events: events.length, files: files.length, skipped, path: usageDir() }));
  }
  return 0;
}

export async function runFeedback(options, io = console) {
  const { events } = await readUsageEvents();
  const version = await readVersion();
  const bundle = buildFeedbackBundle({ events, version });
  const target = resolve(options.out ?? defaultFeedbackPath());
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFileAtomic(target, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  if (options.json) io.log(JSON.stringify(bundle, null, 2));
  io.log(`wrote ${target}`);
  io.log(bundle.privacy);
  io.log("send it to hi@yunzerui.com if you want us to look（可选，不发送不影响使用）。");
  return 0;
}

// Hidden input: a key must never appear in argv, shell history, or logs.
async function readSecret(prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (!value) throw new Error("empty input; nothing written");
    return value;
  }
  process.stdout.write(prompt);
  return new Promise((resolvePromise, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolvePromise(value.trim());
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readVersion() {
  const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
  return pkg.version;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function selectCases(cases, ids) {
  if (!ids || ids.length === 0) return cases;
  const wanted = new Set(ids);
  const missing = ids.filter((id) => !cases.some((testCase) => testCase.id === id));
  if (missing.length > 0) throw new Error(`unknown case ids: ${missing.join(", ")}`);
  return cases.filter((testCase) => wanted.has(testCase.id));
}

function currencyOf(id, config) {
  const code = String(config?.currency ?? "CNY").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new Error(`model "${id}": currency must be a 3-letter code (got "${config.currency}")`);
  }
  return code;
}

async function resolveModels(ids, modelsFile, io, network = {}) {
  const registry = JSON.parse(await readFile(resolve(modelsFile), "utf8"));
  // Env wins; the credentials file only fills what is missing.
  await applyModelCredentials(registry);
  const explicit = Boolean(ids && ids.length > 0);
  const chosen = explicit ? ids : autoSelect(registry);
  if (!explicit && chosen.length > 0) {
    const detail = chosen
      .map((id) => `${id} (${registry[id]?.apiKeyEnv ?? "?"})`)
      .join(", ");
    io.error(`note: auto-selected ${detail} from ${modelsFile}; pass --models or --models-file to pin the registry`);
  }
  const adapters = [];

  for (const id of chosen) {
    const config = registry[id];
    if (!config) {
      throw new Error(`unknown model "${id}" (available: ${Object.keys(registry).join(", ")})`);
    }
    if (config.type === "mock") {
      adapters.push({ id, ...createMockAdapter() });
      continue;
    }
    if (config.type !== "openai") {
      throw new Error(`model "${id}": unsupported type "${config.type}"`);
    }
    const apiKey = process.env[config.apiKeyEnv] ?? process.env.MODEL_API_KEY;
    if (!apiKey) {
      const names = `${config.apiKeyEnv} (or MODEL_API_KEY)`;
      if (explicit) throw new Error(`model "${id}": environment variable ${names} is not set`);
      io.error(`skip ${id}: ${names} is not set`);
      continue;
    }
    registerSecrets([apiKey]);
    adapters.push({
      id,
      ...createOpenAiAdapter({
        id,
        ...config,
        retries: network.retries,
        minIntervalMs: network.minIntervalMs
      })
    });
  }

  if (adapters.length === 0) {
    if (explicit) throw new Error("no runnable models");
    io.error("no API keys found; falling back to the mock adapter");
    adapters.push({ id: "mock", ...createMockAdapter() });
  }
  return { registry, adapters };
}

function autoSelect(registry) {
  return Object.entries(registry)
    .filter(([, config]) => config.type === "openai" && process.env[config.apiKeyEnv])
    .map(([id]) => id);
}

async function evaluate(
  adapter,
  tools,
  cases,
  repeat = 1,
  { pricing = null, budget = null, onProgress = null } = {}
) {
  const results = [];
  const unstable = [];
  for (const [index, testCase] of cases.entries()) {
    const runs = [];
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      const result = await callOnce(adapter, tools, testCase);
      budget?.spend({ cost: costOf(result.usage, pricing), tokens: tokensOf(result.usage) });
      runs.push(result);
    }
    if (repeat === 1) {
      results.push(runs[0]);
    } else {
      const picked = pickRepresentative(runs);
      results.push(picked.result);
      if (picked.unstable) unstable.push({ id: testCase.id, outcomes: picked.outcomes });
    }
    onProgress?.(index + 1, cases.length);
  }
  return { results, stability: repeat > 1 ? { runs: repeat, unstable } : null };
}

function makeProgress(options, io, label, total) {
  if (!options.progress) return null;
  const step = Math.max(1, Math.ceil(total / 10));
  return (done, count) => {
    if (done !== count && done % step !== 0) return;
    io.error(`[${label}] ${done}/${count}`);
  };
}

function budgetLimitMessage(error) {
  const hint = error instanceof TokenLimitError ? "--max-tokens" : "--max-cost";
  return `${error.message}；已发出的请求已计费，本次不计分。减少 --case/--models/--repeat 或提高 ${hint} 后重跑。`;
}

async function callOnce(adapter, tools, testCase) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: testCase.input }
  ];
  try {
    return await adapter.call({ input: testCase.input, messages, tools });
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      toolCalls: [],
      usage: { input: 0, output: 0 },
      latencyMs: 0
    };
  }
}

function serialize(suite, cases, summaries, executionInfo = null, profileReport = null) {
  return {
    suite: {
      name: suite.name,
      path: suite.path,
      tools: suite.tools.map((tool) => tool.name),
      cases: cases.length,
      fingerprint: suiteFingerprint(suite, cases),
      ...(executionInfo ? { execution: executionInfo } : {})
    },
    models: summaries,
    ...(profileReport ? { profiles: profileReport } : {})
  };
}

function ablationScope(suite, names) {
  if (names.length !== 1) throw new Error("mf ablate --profile 一次只能指定一个组");
  const profiles = normalizeProfiles(suite.profiles, suite.tools.map((tool) => tool.name));
  if (!profiles) {
    throw new Error(`suite ${suite.name} 没有 profiles；先运行 mf cluster --out <suite> 生成分组`);
  }
  const [profile] = selectProfiles(profiles, names);
  const mounted = new Set(profile.tools);
  return { name: profile.name, tools: suite.tools.filter((tool) => mounted.has(tool.name)) };
}

async function evaluateProfiles({
  suite,
  cases,
  runs,
  registry,
  selection,
  repeat = 1,
  budget = null,
  progress = false,
  io = console
}) {
  const profiles = normalizeProfiles(suite.profiles, suite.tools.map((tool) => tool.name));
  if (!profiles) {
    throw new Error(`suite ${suite.name} 没有 profiles；先运行 mf cluster --out <suite> 生成分组`);
  }
  const selected = selectProfiles(profiles, selection);
  const indexById = new Map(cases.map((testCase, index) => [testCase.id, index]));
  const warnings = profileWarnings(selected, suite);
  const excludedFromProfiles = cases.filter((testCase) => testCase.excludeFromProfiles === true);
  if (excludedFromProfiles.length > 0) {
    warnings.push(
      `${excludedFromProfiles.length} 条用例标记 excludeFromProfiles，不参与分组评分: ${excludedFromProfiles
        .map((testCase) => testCase.id)
        .join(", ")}`
    );
  }

  const groups = [];
  const caseSets = selected.map((profile) => {
    const profileCases = selectProfileCases(cases, new Set(profile.tools));
    if (profileCases.length === 0) warnings.push(`profile "${profile.name}" 没有可评分的用例，已跳过`);
    groups.push({ name: profile.name, tools: profile.tools.length, cases: profileCases.length });
    return profileCases;
  });
  for (const row of profileCaseCoverage(selected, cases)) {
    if (row.cases === 0) {
      warnings.push(`组 ${row.name} 只有负例，mounted 分数只反映"不该调用"，不反映工具选择`);
    }
  }

  const models = [];
  for (const run of runs) {
    const config = registry[run.adapter.id];
    const pricing = config?.pricing ?? null;
    const currency = currencyOf(run.adapter.id, config);
    const entries = [];
    for (const [index, profile] of selected.entries()) {
      const profileCases = caseSets[index];
      if (profileCases.length === 0) continue;
      const mountedTools = suite.tools.filter((tool) => profile.tools.includes(tool.name));
      const mountedEval = await evaluate(run.adapter, toModelTools(mountedTools), profileCases, repeat, {
        pricing,
        budget,
        onProgress: makeProgress({ progress }, io, `${run.adapter.id}/${profile.name}`, profileCases.length)
      });
      const mounted = scoreModel({
        model: run.adapter.id,
        cases: profileCases,
        results: mountedEval.results,
        pricing,
        scope: "profiles",
        currency
      });
      const allInOne = scoreModel({
        model: run.adapter.id,
        cases: profileCases,
        results: profileCases.map((testCase) => run.results[indexById.get(testCase.id)]),
        pricing,
        scope: "profiles",
        currency
      });
      const entry = analyzeMount(profile, mounted, allInOne);
      entry.usage = {
        inputTokens: mounted.inputTokens,
        cachedTokens: mounted.cachedTokens,
        outputTokens: mounted.outputTokens,
        totalTokens: mounted.totalTokens,
        cost: mounted.totalCost,
        costCurrency: mounted.costCurrency,
        ...(mounted.costCurrency === "CNY" ? { costCny: mounted.totalCostCny } : {}),
        estimated: mounted.rows.some((row) => row.usage?.estimated)
      };
      if (mountedEval.stability) entry.stability = mountedEval.stability;
      entries.push(entry);
    }
    if (entries.length > 0 && entries.every((entry) => entry.reviewed === 0)) {
      warnings.push("所有用例都未复核，分组分数不可用；把认可的用例 reviewed 改为 true 后再看");
    }
    models.push({ model: run.adapter.id, profiles: entries, totals: modelTotals(entries) });
  }

  return {
    hash: hashOf(
      selected.map((profile) => [profile.name, [...profile.tools].sort()]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
    ),
    groups,
    warnings,
    models
  };
}

export async function runCluster(options, io = console) {
  const suite = await loadSuite(options.suite, { allowEmptyCases: true });
  const result = clusterTools(suite.tools, { threshold: options.threshold, maxSize: options.maxSize });
  noteUsage({ toolCount: suite.tools.length, clusters: result.clusters.length });
  if (options.out) {
    const target = resolve(options.out);
    const profiles = Object.fromEntries(result.clusters.map((cluster) => [cluster.label, cluster.tools]));
    // Keep the suite file as the author wrote it (refs, execution, extra keys)
    // and only add profiles.
    const raw = JSON.parse(await readFile(suite.path, "utf8"));
    await writeFileAtomic(target, `${JSON.stringify({ ...raw, profiles }, null, 2)}\n`);
    if (raw.profiles && Object.keys(raw.profiles).length > 0) {
      io.log(`note: 覆盖原有 ${Object.keys(raw.profiles).length} 个分组，原 profiles 不保留`);
    }
    io.log(`profiles written: ${target}`);
  }
  if (options.json) io.log(JSON.stringify(result, null, 2));
  else io.log(formatClusters(result));
  return 0;
}

function parseArgs(argv) {
  const options = {
    command: argv[0],
    suite: DEFAULT_SUITE,
    models: null,
    modelsFile: DEFAULT_MODELS,
    cases: null,
    profiles: null,
    repeat: 1,
    maxCost: null,
    maxTokens: null,
    retries: 2,
    minIntervalMs: 0,
    progress: false,
    showCases: false,
    json: false,
    out: null,
    failUnder: null,
    root: ".",
    report: null,
    noWrite: false,
    from: null,
    probe: false,
    timeoutMs: 5000,
    inputPath: null,
    source: "agent",
    reviewed: false,
    dryRun: false,
    tool: null,
    manifest: null,
    manifests: null,
    installed: null,
    threshold: 0.5,
    maxSize: 10,
    baseline: null,
    failOnRegression: false,
    execute: false,
    execEntry: null,
    execTimeoutMs: 10_000,
    allowSideEffects: false,
    entry: null,
    runtime: "node",
    python: "python",
    exportName: "run",
    inputJson: null,
    allowRead: [],
    allowWrite: [],
    allowNet: [],
    passEnv: [],
    warmup: 0
  };

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (arg) {
      case "--suite": options.suite = resolve(value()); break;
      case "--models": options.models = splitList(value()); break;
      case "--models-file": options.modelsFile = resolve(value()); break;
      case "--case": options.cases = (options.cases ?? []).concat(splitList(value())); break;
      case "--profile": options.profiles = splitList(value()); break;
      case "--repeat": {
        const raw = Number(value());
        if (!Number.isInteger(raw) || raw < 1 || raw > 10) throw new Error("--repeat expects an integer between 1 and 10");
        options.repeat = raw;
        break;
      }
      case "--max-cost": {
        const raw = Number(value());
        if (!Number.isFinite(raw) || raw <= 0) throw new Error("--max-cost expects a positive amount");
        options.maxCost = raw;
        break;
      }
      case "--max-tokens": {
        const raw = Number(value());
        if (!Number.isInteger(raw) || raw <= 0) throw new Error("--max-tokens expects a positive integer");
        options.maxTokens = raw;
        break;
      }
      case "--retry": {
        const raw = Number(value());
        if (!Number.isInteger(raw) || raw < 0 || raw > 10) throw new Error("--retry expects an integer between 0 and 10");
        options.retries = raw;
        break;
      }
      case "--min-interval": {
        const raw = Number(value());
        if (!Number.isInteger(raw) || raw < 0 || raw > 60_000) throw new Error("--min-interval expects an integer between 0 and 60000 (ms)");
        options.minIntervalMs = raw;
        break;
      }
      case "--progress": options.progress = true; break;
      case "--show-cases": options.showCases = true; break;
      case "--json": options.json = true; break;
      case "--out": options.out = value(); break;
      case "--root": options.root = resolve(value()); break;
      case "--from": options.from = value(); break;
      case "--probe": options.probe = true; break;
      case "--timeout": {
        const raw = Number(value());
        if (!Number.isFinite(raw) || raw <= 0) throw new Error("--timeout expects a positive number of milliseconds");
        options.timeoutMs = raw;
        break;
      }
      case "--report": options.report = value(); break;
      case "--no-write": options.noWrite = true; break;
      case "--input": options.inputPath = value(); break;
      case "--source": options.source = value(); break;
      case "--reviewed": options.reviewed = true; break;
      case "--dry-run": options.dryRun = true; break;
      case "--tool": options.tool = value(); break;
      case "--manifest": options.manifest = resolve(value()); break;
      case "--manifests": options.manifests = resolve(value()); break;
      case "--installed": options.installed = resolve(value()); break;
      case "--threshold": {
        const raw = Number(value());
        if (!Number.isFinite(raw) || raw <= 0 || raw > 1) throw new Error("--threshold expects a ratio between 0 and 1");
        options.threshold = raw;
        break;
      }
      case "--max-size": {
        const raw = Number(value());
        if (!Number.isInteger(raw) || raw <= 0) throw new Error("--max-size expects a positive integer");
        options.maxSize = raw;
        break;
      }
      case "--baseline": options.baseline = resolve(value()); break;
      case "--fail-on-regression": options.failOnRegression = true; break;
      case "--entry": options.entry = value(); break;
      case "--execute": options.execute = true; break;
      case "--exec-timeout": options.execTimeoutMs = Number(value()) || 10_000; break;
      case "--allow-side-effects": options.allowSideEffects = true; break;
      case "--runtime": options.runtime = value(); break;
      case "--python": options.python = value(); break;
      case "--export": options.exportName = value(); break;
      case "--input-json": options.inputJson = value(); break;
      case "--allow-read": options.allowRead = splitList(value()); break;
      case "--allow-write": options.allowWrite = splitList(value()); break;
      case "--allow-net": options.allowNet = splitList(value()); break;
      case "--pass-env": options.passEnv = splitList(value()); break;
      case "--warmup": options.warmup = Number(value()) || 0; break;
      case "--fail-under": {
        const raw = Number(value());
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) throw new Error("--fail-under expects a ratio between 0 and 1");
        options.failUnder = raw;
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option "${arg}"`);
    }
  }
  return options;
}

function splitList(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

// pnpm installs packages through symlinks; Node resolves ESM to the real
// path, so a plain resolve(argv[1]) mismatch makes the CLI exit silently.
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  let argv = process.argv.slice(2);
  // `npx modelfunction-cli mf scan` passes the bin name through; accept it.
  if (argv[0] === "mf") argv = argv.slice(1);

  const version = await readVersion();
  const startedAt = Date.now();
  let commandName = null;
  const skipUsage = new Set(["mcp", "config", "stats", "feedback"]);
  // Usage is local and count-only; the exit hook keeps every branch covered.
  process.on("exit", (code) => {
    if (!commandName || skipUsage.has(commandName)) return;
    recordRunSync({
      command: commandName,
      exitCode: typeof code === "number" ? code : 0,
      durationMs: Date.now() - startedAt,
      version
    });
  });

  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`mf ${version}\n`);
    process.exit(0);
  } else if (argv[0] === "sandbox") {
    if (argv[1] !== "check") {
      process.stderr.write("usage: mf sandbox check [--json]\n");
      process.exit(1);
    }
    commandName = "sandbox";
    try {
      const code = await runSandboxCheck({ json: argv.includes("--json") });
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv[0] === "compare") {
    const paths = argv.slice(1).filter((arg) => !arg.startsWith("--"));
    if (paths.length !== 2) {
      process.stderr.write("usage: mf compare <before.json> <after.json> [--fail-on-regression] [--json]\n");
      process.exit(1);
    }
    commandName = "compare";
    try {
      const code = await runCompare({
        paths,
        json: argv.includes("--json"),
        failOnRegression: argv.includes("--fail-on-regression")
      });
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv[0] === "config") {
    try {
      const code = await runConfig({ args: argv.slice(1), json: argv.includes("--json") });
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv[0] === "stats") {
    try {
      const code = await runStats({ json: argv.includes("--json") });
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv[0] === "feedback") {
    try {
      const outIndex = argv.indexOf("--out");
      if (outIndex >= 0 && !argv[outIndex + 1]) {
        process.stderr.write("usage: mf feedback [--out <file>] [--json]\n");
        process.exit(1);
      }
      const code = await runFeedback({
        out: outIndex >= 0 ? argv[outIndex + 1] : null,
        json: argv.includes("--json")
      });
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv[0] === "mcp") {
    try {
      const { startMcpServer } = await import("./lib/mcp-server.js");
      await startMcpServer();
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  } else if (argv.length === 0 || argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(USAGE);
  } else if (!["eval", "scan", "case", "coverage", "audit", "lint", "check", "ablate", "cluster", "exec"].includes(argv[0])) {
    process.stderr.write(`unknown command "${argv[0]}"\n\n${USAGE}`);
    process.exit(1);
  } else if (argv[0] === "case" && argv[1] !== "add") {
    process.stderr.write(`usage: mf case add --suite <file> (--input <file> | stdin)\n`);
    process.exit(1);
  } else {
    try {
      const args = argv[0] === "case" ? [argv[0], ...argv.slice(2)] : argv;
      const options = parseArgs(args);
      if (options.help) {
        process.stdout.write(USAGE);
        process.exit(0);
      }
      commandName = argv[0] === "case" ? "case" : argv[0];
      const code =
        argv[0] === "scan"
          ? await runScan(options)
          : argv[0] === "case"
            ? await runCaseAdd(options)
            : argv[0] === "coverage"
              ? await runCoverage(options)
              : argv[0] === "audit"
                ? await runAudit(options)
              : argv[0] === "lint"
                ? await runLint(options)
                : argv[0] === "check"
                ? await runCheck(options)
                : argv[0] === "ablate"
                  ? await runAblate(options)
                  : argv[0] === "cluster"
                    ? await runCluster(options)
                    : argv[0] === "exec"
                    ? await runExec(options)
                    : await runEval(options);
      process.exit(code);
    } catch (error) {
      process.stderr.write(`${redactText(error?.message ?? error)}\n`);
      process.exit(1);
    }
  }
}
