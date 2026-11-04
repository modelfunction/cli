import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./credentials.js";

// Events are redacted by construction: only counts, ids and ratios leave the
// process. Never add free-form text (inputs, descriptions, paths, errors).
const OPT_OUT_ENV = "MF_NO_USAGE";
const CI_ENV_KEYS = [
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "CNB_BUILD_ID"
];

let pendingDetails = null;

export function usageDir() {
  return join(configDir(), "usage");
}

export function usageFile(date = new Date()) {
  const month = date.toISOString().slice(0, 7);
  return join(usageDir(), `${month}.jsonl`);
}

export function feedbackDir() {
  return join(configDir(), "feedback");
}

export function defaultFeedbackPath(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return join(feedbackDir(), `mf-feedback-${stamp}.json`);
}

export function noteUsage(details) {
  pendingDetails = { ...(pendingDetails ?? {}), ...sanitizeDetails(details) };
}

export async function recordRun({ command, exitCode = 0, durationMs = 0, version }) {
  if (process.env[OPT_OUT_ENV] === "1") {
    pendingDetails = null;
    return;
  }
  const record = buildRecord({ command, exitCode, durationMs, version });
  try {
    await mkdir(usageDir(), { recursive: true, mode: 0o700 });
    await appendFile(usageFile(), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Usage logging must never fail a command.
  } finally {
    pendingDetails = null;
  }
}

// The process "exit" hook is synchronous, so the CLI uses this variant.
export function recordRunSync({ command, exitCode = 0, durationMs = 0, version }) {
  if (process.env[OPT_OUT_ENV] === "1") {
    pendingDetails = null;
    return;
  }
  const record = buildRecord({ command, exitCode, durationMs, version });
  try {
    mkdirSync(usageDir(), { recursive: true, mode: 0o700 });
    appendFileSync(usageFile(), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore
  } finally {
    pendingDetails = null;
  }
}

export function buildRecord({ command, exitCode, durationMs, version }) {
  return {
    schema: 1,
    ts: new Date().toISOString(),
    command: typeof command === "string" ? command.slice(0, 32) : "unknown",
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    mf: typeof version === "string" ? version : "unknown",
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    ci: detectCi(),
    ...(pendingDetails ?? {})
  };
}

function detectCi() {
  if (process.env.CI === "true" || process.env.CI === "1") return true;
  return CI_ENV_KEYS.some((key) => Boolean(process.env[key]));
}

export async function readUsageEvents() {
  let files = [];
  try {
    files = (await readdir(usageDir())).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return { events: [], files: [], skipped: 0 };
    throw error;
  }
  const events = [];
  let skipped = 0;
  for (const file of files) {
    const text = await readFile(join(usageDir(), file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && typeof parsed.ts === "string") events.push(parsed);
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, files, skipped };
}

export function summarizeUsage(events) {
  const summary = {
    runs: events.length,
    firstRun: events[0]?.ts ?? null,
    lastRun: events.at(-1)?.ts ?? null,
    activeDays: new Set(events.map((event) => event.ts.slice(0, 10))).size,
    ciRuns: 0,
    localRuns: 0,
    exitCodes: {},
    commands: {},
    platforms: {},
    nodeVersions: {},
    mfVersions: {},
    models: {},
    eval: { runs: 0, executed: 0, meanSelection: null, meanPass: null, meanArgs: null, unstableCases: 0 },
    lint: { runs: 0, errors: 0, warns: 0, infos: 0, rules: {} },
    check: { runs: 0, verdicts: {} },
    scan: { runs: 0, tools: 0, skills: 0 }
  };
  const selection = [];
  const pass = [];
  const args = [];

  for (const event of events) {
    if (event.ci) summary.ciRuns += 1;
    else summary.localRuns += 1;
    bump(summary.exitCodes, String(event.exitCode ?? 0));
    bump(summary.commands, event.command ?? "unknown");
    if (event.platform) bump(summary.platforms, event.platform);
    if (event.node) bump(summary.nodeVersions, event.node);
    if (event.mf) bump(summary.mfVersions, event.mf);
    for (const model of event.models ?? []) bump(summary.models, model);

    if (event.command === "eval") {
      summary.eval.runs += 1;
      if (event.execEngine) summary.eval.executed += 1;
      if (event.unstableCases) summary.eval.unstableCases += event.unstableCases;
      if (typeof event.selectionAccuracy === "number") selection.push(event.selectionAccuracy);
      if (typeof event.passRate === "number") pass.push(event.passRate);
      if (typeof event.argAccuracy === "number") args.push(event.argAccuracy);
    }
    if (event.command === "lint") {
      summary.lint.runs += 1;
      summary.lint.errors += event.lintErrors ?? 0;
      summary.lint.warns += event.lintWarns ?? 0;
      summary.lint.infos += event.lintInfos ?? 0;
      for (const [rule, count] of Object.entries(event.lintRules ?? {})) {
        summary.lint.rules[rule] = (summary.lint.rules[rule] ?? 0) + count;
      }
    }
    if (event.command === "check") {
      summary.check.runs += 1;
      bump(summary.check.verdicts, event.checkVerdict ?? "unknown");
    }
    if (event.command === "scan") {
      summary.scan.runs += 1;
      summary.scan.tools += event.scanTools ?? 0;
      summary.scan.skills += event.scanSkills ?? 0;
    }
  }

  summary.eval.meanSelection = mean(selection);
  summary.eval.meanPass = mean(pass);
  summary.eval.meanArgs = mean(args);
  return summary;
}

export function buildFeedbackBundle({ events, version, generatedAt = new Date() }) {
  return {
    schema: 1,
    kind: "modelfunction-feedback",
    generatedAt: generatedAt.toISOString(),
    mf: {
      version,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch
    },
    usage: summarizeUsage(events),
    privacy:
      "仅包含命令名、次数、模型 id、计数与比率。不含用例原文、工具描述、源码、文件路径或密钥。",
    request:
      "我们想了解：哪些命令被真实使用、在哪些平台上跑、评测通过率大概什么水平、lint/check 主要命中哪些规则。用于决定下一步做什么，不需要你的项目细节。"
  };
}

export function formatStats(summary, { events = 0, files = 0, skipped = 0, path = usageDir() } = {}) {
  if (summary.runs === 0) {
    return [
      `local usage: ${path}`,
      "还没有本地记录。运行任意 mf 命令后会自动记录（仅计数，不上传）。",
      "opt out: set MF_NO_USAGE=1"
    ].join("\n");
  }
  const lines = [
    `local usage: ${path} (${events} events, ${files} file(s)${skipped > 0 ? `, ${skipped} unreadable line(s)` : ""})`,
    `runs: ${summary.runs} (local ${summary.localRuns}, ci ${summary.ciRuns})   first: ${summary.firstRun}   last: ${summary.lastRun}   active days: ${summary.activeDays}`,
    `exit codes: ${pairs(summary.exitCodes)}`,
    `commands:   ${pairs(summary.commands)}`
  ];
  if (Object.keys(summary.models).length > 0) lines.push(`models:     ${pairs(summary.models)}`);
  if (summary.eval.runs > 0) {
    const parts = [`${summary.eval.runs} run(s)`];
    if (summary.eval.meanSelection !== null) parts.push(`select ${percent(summary.eval.meanSelection)}`);
    if (summary.eval.meanPass !== null) parts.push(`pass ${percent(summary.eval.meanPass)}`);
    if (summary.eval.executed > 0) parts.push(`${summary.eval.executed} with execution`);
    if (summary.eval.unstableCases > 0) parts.push(`${summary.eval.unstableCases} unstable case(s)`);
    lines.push(`eval:       ${parts.join(", ")}`);
  }
  if (summary.lint.runs > 0) {
    const top = Object.entries(summary.lint.rules)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([rule, count]) => `${rule} ${count}`);
    lines.push(
      `lint:       ${summary.lint.runs} run(s), error ${summary.lint.errors} / warn ${summary.lint.warns} / info ${summary.lint.infos}` +
        (top.length > 0 ? `; top: ${top.join(", ")}` : "")
    );
  }
  if (summary.check.runs > 0) lines.push(`check:      ${summary.check.runs} run(s), ${pairs(summary.check.verdicts)}`);
  if (summary.scan.runs > 0) lines.push(`scan:       ${summary.scan.runs} run(s), ${summary.scan.tools} tools, ${summary.scan.skills} skills`);
  lines.push(`versions:   mf ${keys(summary.mfVersions)}   node ${keys(summary.nodeVersions)}   os ${keys(summary.platforms)}`);
  lines.push(`no network, no telemetry. opt out: set MF_NO_USAGE=1. clear: delete ${path}`);
  return lines.join("\n");
}

function bump(target, key) {
  target[key] = (target[key] ?? 0) + 1;
}

function mean(values) {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10000) / 10000;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function keys(counts) {
  return Object.keys(counts).sort().slice(0, 5).join(", ") || "-";
}

function pairs(counts) {
  return (
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `${key} ${value}`)
      .join(", ") || "-"
  );
}

const INT_FIELDS = new Set([
  "caseCount",
  "toolCount",
  "reviewedCount",
  "profileGroups",
  "repeat",
  "unstableCases",
  "execExecuted",
  "execPassed",
  "execBlocked",
  "execSkipped",
  "scanTools",
  "scanSkills",
  "scanMcpServers",
  "scanProbes",
  "lintErrors",
  "lintWarns",
  "lintInfos",
  "checkFindings",
  "clusters"
]);
const RATIO_FIELDS = new Set(["selectionAccuracy", "argAccuracy", "passRate"]);
const BOOL_FIELDS = new Set(["failedThreshold", "regressions"]);
const STRING_FIELDS = new Set(["execEngine", "checkVerdict"]);
const STRING_ARRAY_FIELDS = new Set(["models"]);
const COUNT_OBJECT_FIELDS = new Set(["lintRules"]);

export function sanitizeDetails(details) {
  if (!details || typeof details !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(details)) {
    if (INT_FIELDS.has(key)) {
      if (Number.isInteger(value) && value >= 0) out[key] = value;
      continue;
    }
    if (RATIO_FIELDS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 10000) / 10000;
      continue;
    }
    if (BOOL_FIELDS.has(key)) {
      if (typeof value === "boolean") out[key] = value;
      continue;
    }
    if (STRING_FIELDS.has(key)) {
      if (typeof value === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(value)) out[key] = value;
      continue;
    }
    if (STRING_ARRAY_FIELDS.has(key)) {
      if (Array.isArray(value)) {
        out[key] = value.filter((item) => typeof item === "string" && item.length <= 64).slice(0, 20);
      }
      continue;
    }
    if (COUNT_OBJECT_FIELDS.has(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value)
            .filter(([rule, count]) => /^[a-z0-9-]{1,40}$/.test(rule) && Number.isInteger(count) && count >= 0)
            .slice(0, 40)
        );
      }
    }
  }
  return out;
}
