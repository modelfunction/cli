import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEval } from "../mf.js";
import { caseFingerprint } from "../lib/fingerprint.js";
import { runExecutionChecks } from "../lib/eval-exec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = resolve(HERE, "../fixtures/models.json");

function capture() {
  const lines = [];
  return { io: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) }, lines };
}

async function makeFixture(root) {
  const entry = join(root, "tool.mjs");
  await writeFile(
    entry,
    "export async function run(request) { return { echo: request.arguments.text }; }\n",
    "utf8"
  );
  const suitePath = join(root, "suite.json");
  await writeFile(
    suitePath,
    JSON.stringify(
      {
        name: "exec-fixture",
        tools: [
          {
            name: "echo",
            description: "处理文本并回声",
            sideEffects: "none",
            parameters: { type: "object", properties: { text: { type: "string" } } }
          }
        ],
        cases: [
          {
            id: "e1",
            input: "处理文本 hello",
            expectedTool: "echo",
            expectedArgs: { text: { $contains: "hello" } },
            toolInput: { text: "hello" },
            expect: { ok: true, contains: "hello" },
            reviewed: true
          },
          {
            id: "e2",
            input: "处理文本 world",
            expectedTool: "echo",
            expectedArgs: { text: { $contains: "world" } },
            toolInput: { text: "world" },
            expect: { ok: true, contains: "MISSING" },
            reviewed: true
          }
        ]
      },
      null,
      2
    ),
    "utf8"
  );
  return { entry, suitePath };
}

test("eval --execute runs toolInput and applies expect assertions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-eval-exec-"));
  try {
    const { entry, suitePath } = await makeFixture(root);
    const { io, lines } = capture();
    const code = await runEval(
      {
        suite: suitePath,
        models: ["mock"],
        modelsFile: MODELS,
        cases: null,
        showCases: false,
        json: true,
        out: null,
        failUnder: null,
        baseline: null,
        failOnRegression: false,
        execute: true,
        execEntry: entry,
        execTimeoutMs: 8000
      },
      io
    );
    assert.equal(code, 0);

    const payload = JSON.parse(lines.join("\n"));
    const summary = payload.models[0];
    assert.equal(summary.exec.executed, 2);
    assert.equal(summary.exec.passed, 1);
    assert.equal(summary.exec.passRate, 0.5);
    assert.equal(payload.suite.execution.runtime, "node");
    assert.equal(payload.suite.execution.engine, "node-permission");
    assert.equal(summary.exec.engine, "node-permission");
    assert.ok(payload.suite.execution.hash);
    const failed = summary.exec.results.find((item) => item.id === "e2");
    assert.equal(failed.passed, false);
    assert.ok(failed.failures[0].includes("contains"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("side-effect tools are blocked unless explicitly allowed", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-eval-exec-"));
  try {
    const entry = join(root, "danger.mjs");
    await writeFile(entry, "export async function run() { return { ok: true }; }\n", "utf8");
    const suite = {
      execution: { entry },
      tools: [{ name: "danger", sideEffects: "write", parameters: { properties: {} } }],
      cases: []
    };
    const cases = [
      { id: "d1", input: "危险操作", expectedTool: "danger", toolInput: {}, reviewed: true }
    ];

    const blockedSummary = { model: "m", rows: [{ id: "d1", reviewed: true, selectionCorrect: true }] };
    await runExecutionChecks({
      suite,
      cases,
      summaries: [blockedSummary],
      options: { execEntry: entry, execTimeoutMs: 5000 }
    });
    assert.equal(blockedSummary.exec.blocked, 1);
    assert.equal(blockedSummary.exec.executed, 0);
    assert.equal(blockedSummary.exec.results[0].reason.includes("--allow-side-effects"), true);

    const allowedSummary = { model: "m", rows: [{ id: "d1", reviewed: true, selectionCorrect: true }] };
    await runExecutionChecks({
      suite,
      cases,
      summaries: [allowedSummary],
      options: { execEntry: entry, execTimeoutMs: 5000, allowSideEffects: true }
    });
    assert.equal(allowedSummary.exec.blocked, 0);
    assert.equal(allowedSummary.exec.executed, 1);
    assert.equal(allowedSummary.exec.passed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("case fingerprint covers toolInput and expect", () => {
  const base = { input: "x", expectedTool: "echo", expectedArgs: {} };
  const withInput = { ...base, toolInput: { text: "hi" } };
  const withExpect = { ...withInput, expect: { ok: true } };
  assert.notEqual(caseFingerprint(base), caseFingerprint(withInput));
  assert.notEqual(caseFingerprint(withInput), caseFingerprint(withExpect));
  assert.equal(caseFingerprint(withExpect), caseFingerprint({ ...withExpect }));
});

test("eval --execute without an entry fails clearly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mf-eval-exec-"));
  try {
    const { suitePath } = await makeFixture(root);
    await assert.rejects(
      () =>
        runEval(
          {
            suite: suitePath,
            models: ["mock"],
            modelsFile: MODELS,
            cases: null,
            showCases: false,
            json: true,
            out: null,
            failUnder: null,
            baseline: null,
            failOnRegression: false,
            execute: true,
            execEntry: null,
            execTimeoutMs: 5000
          },
          capture().io
        ),
      /--execute 需要 --entry/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
