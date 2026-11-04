import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildFeedbackBundle,
  formatStats,
  noteUsage,
  readUsageEvents,
  recordRun,
  recordRunSync,
  sanitizeDetails,
  summarizeUsage
} from "../lib/usage.js";

const MF = fileURLToPath(new URL("../mf.js", import.meta.url));

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "mf-usage-"));
  process.env.MF_CONFIG_DIR = dir;
  return dir;
}

const CI_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "CNB_BUILD_ID"
];

function clearCiEnv() {
  const saved = {};
  for (const key of CI_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return () => {
    for (const key of CI_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MF_NO_USAGE;
  for (const key of CI_KEYS) delete env[key];
  return env;
}

function runCli(args, { env = {}, input = "" } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MF, ...args], {
      env: cleanEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => resolvePromise({ code, stdout, stderr }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

test("sanitizeDetails keeps only whitelisted fields", () => {
  const cleaned = sanitizeDetails({
    caseCount: 3,
    selectionAccuracy: 0.92345,
    models: ["mock"],
    lintRules: { "pair-no-boundary": 2, "Bad Rule": 1 },
    toolInput: "secret input",
    path: "C:/project/secret",
    execEngine: "node-permission"
  });
  assert.deepEqual(cleaned, {
    caseCount: 3,
    selectionAccuracy: 0.9235,
    models: ["mock"],
    lintRules: { "pair-no-boundary": 2 },
    execEngine: "node-permission"
  });
});

test("recordRun writes a monthly jsonl and summarizeUsage aggregates it", async () => {
  const dir = await tempDir();
  const restoreCi = clearCiEnv();
  try {
    noteUsage({
      caseCount: 13,
      toolCount: 4,
      selectionAccuracy: 0.9,
      passRate: 0.8,
      models: ["mock"]
    });
    await recordRun({ command: "eval", exitCode: 0, durationMs: 20, version: "0.5.0" });

    noteUsage({ lintErrors: 1, lintWarns: 2, lintInfos: 0, lintRules: { "pair-no-boundary": 2 } });
    await recordRun({ command: "lint", exitCode: 1, durationMs: 10, version: "0.5.0" });

    const { events, files, skipped } = await readUsageEvents();
    assert.equal(events.length, 2);
    assert.equal(files.length, 1);
    assert.equal(skipped, 0);
    assert.equal(events[0].command, "eval");
    assert.equal(events[0].caseCount, 13);
    assert.equal(events[0].ci, false);
    assert.equal(events[0].toolInput, undefined);

    const summary = summarizeUsage(events);
    assert.equal(summary.runs, 2);
    assert.equal(summary.localRuns, 2);
    assert.equal(summary.ciRuns, 0);
    assert.equal(summary.commands.eval, 1);
    assert.equal(summary.commands.lint, 1);
    assert.equal(summary.exitCodes["1"], 1);
    assert.equal(summary.models.mock, 1);
    assert.equal(summary.eval.meanSelection, 0.9);
    assert.equal(summary.lint.warns, 2);
    assert.equal(summary.lint.rules["pair-no-boundary"], 2);
    assert.match(formatStats(summary, { events: 2, files: 1, path: join(dir, "usage") }), /commands:/);
    assert.match(formatStats(summary, { events: 2, files: 1, path: join(dir, "usage") }), /local 2, ci 0/);
  } finally {
    restoreCi();
    await rm(dir, { recursive: true, force: true });
  }
});

test("CI runs are marked so stats can separate them from local runs", async () => {
  const dir = await tempDir();
  const restoreCi = clearCiEnv();
  try {
    process.env.GITHUB_ACTIONS = "true";
    await recordRun({ command: "lint", exitCode: 0, durationMs: 5, version: "0.5.1" });
    delete process.env.GITHUB_ACTIONS;

    await recordRun({ command: "eval", exitCode: 0, durationMs: 5, version: "0.5.1" });

    const { events } = await readUsageEvents();
    assert.equal(events[0].ci, true);
    assert.equal(events[1].ci, false);
    const summary = summarizeUsage(events);
    assert.equal(summary.ciRuns, 1);
    assert.equal(summary.localRuns, 1);
  } finally {
    restoreCi();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readUsageEvents skips malformed lines and summarizes an empty log", async () => {
  const dir = await tempDir();
  try {
    const empty = await readUsageEvents();
    assert.equal(empty.events.length, 0);
    assert.match(formatStats(summarizeUsage([])), /还没有本地记录/);

    await mkdir(join(dir, "usage"), { recursive: true });
    await writeFile(
      join(dir, "usage", "2026-11.jsonl"),
      '{"ts":"2026-11-01T00:00:00.000Z","command":"lint","exitCode":0}\nnot json\n',
      "utf8"
    );
    const { events, skipped } = await readUsageEvents();
    assert.equal(events.length, 1);
    assert.equal(skipped, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("feedback bundles contain aggregates only, no paths or raw events", async () => {
  const dir = await tempDir();
  try {
    noteUsage({ caseCount: 2, models: ["mock"], selectionAccuracy: 1 });
    await recordRun({ command: "eval", exitCode: 0, durationMs: 5, version: "0.5.0" });
    const { events } = await readUsageEvents();

    const bundle = buildFeedbackBundle({
      events,
      version: "0.5.0",
      generatedAt: new Date("2026-11-01T00:00:00.000Z")
    });
    const text = JSON.stringify(bundle);
    assert.equal(bundle.kind, "modelfunction-feedback");
    assert.equal(bundle.generatedAt, "2026-11-01T00:00:00.000Z");
    assert.equal(bundle.usage.runs, 1);
    assert.ok(!text.includes(dir));
    assert.ok(!text.includes("records"));
    assert.match(bundle.privacy, /不含/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MF_NO_USAGE=1 disables writing", async () => {
  const dir = await tempDir();
  try {
    process.env.MF_NO_USAGE = "1";
    noteUsage({ caseCount: 1 });
    recordRunSync({ command: "eval", exitCode: 0, durationMs: 1, version: "0.5.0" });
    const { events } = await readUsageEvents();
    assert.equal(events.length, 0);
  } finally {
    delete process.env.MF_NO_USAGE;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI records an eval run and can report and export it", async () => {
  const dir = await tempDir();
  try {
    const evalRun = await runCli(["eval", "--models", "mock", "--json"], {
      env: { MF_CONFIG_DIR: dir }
    });
    assert.equal(evalRun.code, 0, evalRun.stderr);

    const { events } = await readUsageEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "eval");
    assert.deepEqual(events[0].models, ["mock"]);
    assert.equal(events[0].caseCount, 13);
    assert.equal(events[0].toolCount, 4);
    assert.equal(events[0].ci, false);
    assert.ok(!JSON.stringify(events[0]).includes(dir));

    const stats = await runCli(["stats", "--json"], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(stats.code, 0, stats.stderr);
    const statsPayload = JSON.parse(stats.stdout);
    assert.equal(statsPayload.runs, 1);
    assert.equal(statsPayload.commands.eval, 1);

    const outPath = join(dir, "feedback.json");
    const feedback = await runCli(["feedback", "--out", outPath], { env: { MF_CONFIG_DIR: dir } });
    assert.equal(feedback.code, 0, feedback.stderr);
    const bundle = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(bundle.kind, "modelfunction-feedback");
    assert.equal(bundle.usage.runs, 1);
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes(dir));
    assert.ok(!text.includes('"input"'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
