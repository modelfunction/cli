import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSuite, formatAudit } from "../lib/audit.js";
import { loadSuite } from "../lib/suite.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = resolve(HERE, "../fixtures/suite.json");
const MF = resolve(HERE, "../mf.js");

function runCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MF, ...args], {
      env: { ...process.env, MF_NO_USAGE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
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
  });
}

test("audit composes lint, clusters, coverage and actions for the fixture suite", async () => {
  const suite = await loadSuite(SUITE);
  const report = auditSuite(suite);
  assert.equal(report.suite.name, "recruiting-agent");
  assert.equal(report.suite.tools, 4);
  assert.equal(report.suite.cases, 13);
  assert.equal(report.lint.tools, 4);
  assert.ok(Number.isInteger(report.lint.counts.error));
  assert.ok(Array.isArray(report.clusters.clusters));
  assert.equal(report.coverage.total, 13);
  assert.ok(report.profiles);
  assert.equal(report.profiles.groups.length, 2);
  assert.ok(Array.isArray(report.actions));

  const text = formatAudit(report);
  assert.match(text, /工具集审计/);
  assert.match(text, /建议动作/);
  assert.match(text, /用例覆盖/);
  assert.match(text, /挂载分组/);
});

test("audit reports unmounted tools and gaps for a suite with profiles", () => {
  const suite = {
    name: "t",
    path: "mem.json",
    tools: [
      {
        name: "search_web",
        description: "Search the web for pages.",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
      },
      {
        name: "search_news",
        description: "Search the web for news articles.",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] }
      },
      {
        name: "send_email",
        description: "Send an email message.",
        parameters: { type: "object", properties: { to: { type: "string" } }, required: ["to"] }
      }
    ],
    skills: [],
    cases: [
      { id: "c1", input: "find pages", expectedTool: "search_web", reviewed: true },
      { id: "c2", input: "find news", expectedTool: "search_news", reviewed: false }
    ],
    profiles: { main: ["search_web", "search_news"] }
  };
  const report = auditSuite(suite);
  assert.deepEqual(report.profiles.unmounted, ["send_email"]);
  const mountAction = report.actions.find((item) => item.kind === "mount");
  assert.ok(mountAction);
  assert.match(mountAction.detail, /send_email/);
  assert.ok(report.actions.some((item) => item.kind === "cases"));
  assert.ok(report.actions.some((item) => item.kind === "review"));

  const text = formatAudit(report);
  assert.match(text, /未挂载工具：send_email/);
  assert.match(text, /建议动作/);
});

test("mf audit writes markdown or json and always exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-audit-"));
  try {
    const markdownPath = join(dir, "audit.md");
    const markdown = await runCli(["audit", "--suite", SUITE, "--out", markdownPath]);
    assert.equal(markdown.code, 0, markdown.stderr);
    const text = await readFile(markdownPath, "utf8");
    assert.match(text, /工具集审计/);
    assert.match(text, /建议动作/);

    const json = await runCli(["audit", "--suite", SUITE, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.suite.tools, 4);
    assert.ok(Array.isArray(report.actions));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audit tolerates a skills-only suite", () => {
  const report = auditSuite({
    name: "skills-only",
    tools: [],
    skills: [{ name: "feishu-doc", description: "Read and write Feishu documents." }],
    cases: []
  });
  assert.equal(report.suite.tools, 0);
  assert.equal(report.suite.skills, 1);
  assert.equal(report.clusters.total, 0);
  assert.equal(report.profiles, null);
  assert.match(formatAudit(report), /未定义 profiles/);
});
