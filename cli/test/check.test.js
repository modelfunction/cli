import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkMany, formatCheck, formatCheckMany } from "../lib/check.js";

const HERE = dirname(fileURLToPath(import.meta.url));
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

test("check flags a new skill that duplicates an installed one", () => {
  const result = check({
    manifest: {
      name: "tag-duplicate-prs-issues",
      description: "Search duplicate PRs/issues, group related work, sync duplicate state to GitHub."
    },
    installed: [
      {
        name: "gitcrawl",
        description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, PR status, repo work."
      },
      {
        name: "feishu-doc",
        description: "Feishu document read/write operations. Activate when user mentions Feishu docs or docx links."
      }
    ]
  });
  assert.equal(result.verdict, "warn");
  const finding = result.findings.find((item) => item.code === "skill-pair-no-boundary");
  assert.ok(finding, "expected the overlapping skill pair");
  assert.equal(finding.with, "gitcrawl");
  assert.deepEqual(result.family, ["gitcrawl", "tag-duplicate-prs-issues"]);
  assert.match(formatCheck(result), /verdict: warn/);
});

test("check keeps description-quality rules advisory so mature tools pass", () => {
  const result = check({
    manifest: {
      name: "read",
      description: "Read the contents of a file. Supports text files and images.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    },
    installed: []
  });
  assert.equal(result.verdict, "pass");
  const finding = result.findings.find((item) => item.code === "desc-no-when");
  assert.ok(finding, "expected the missing-trigger finding to still be reported");
  assert.equal(finding.severity, "info");
  assert.equal(result.summary.warn, 0);
});

test("check treats runtime-assembled descriptions as advisory, not missing", () => {
  const result = check({
    manifest: {
      name: "mcp",
      description: "",
      descriptionSource: "runtime",
      parameters: { type: "object", properties: {} }
    },
    installed: []
  });
  assert.equal(result.verdict, "pass");
  assert.ok(result.findings.some((item) => item.code === "desc-runtime" && item.severity === "info"));
  assert.equal(result.findings.some((item) => item.code === "desc-missing"), false);
});

test("check flags a required identifier the model cannot source", () => {
  const result = check({
    manifest: {
      name: "score_resume",
      description: "当用户需要给简历与岗位描述打分时使用，返回 0-100。",
      parameters: {
        type: "object",
        properties: {
          resume: { type: "string", description: "简历文本" },
          session_id: { type: "string", description: "会话 ID" }
        },
        required: ["resume", "session_id"]
      }
    },
    installed: { tools: [], skills: [] }
  });
  assert.equal(result.verdict, "warn");
  const finding = result.findings.find((item) => item.code === "required-unsourced");
  assert.ok(finding);
  assert.equal(finding.param, "session_id");
});

test("checkMany checks a pack against installed and against each other", () => {
  const result = checkMany({
    manifests: [
      {
        name: "gitcrawl",
        description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, PR status, repo work."
      },
      {
        name: "tag-duplicate-prs-issues",
        description: "Search duplicate PRs/issues, group related work, sync duplicate state to GitHub."
      }
    ],
    installed: [
      {
        name: "feishu-doc",
        description: "Feishu document read/write operations. Activate when user mentions Feishu docs or docx links."
      }
    ]
  });
  assert.equal(result.items, 2);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.some((item) => Array.isArray(item.family) && item.family.length >= 2));
  assert.match(formatCheckMany(result), /2 个新能力/);
  assert.ok(["pass", "warn"].includes(result.verdict));
});

test("check accepts a scan report and rejects unrecognized installed shapes", () => {
  const manifest = {
    name: "tag-duplicate-prs-issues",
    description: "Search duplicate PRs/issues, group related work, sync duplicate state to GitHub."
  };
  const result = check({
    manifest,
    installed: {
      report: {
        tools: [],
        skills: [
          {
            name: "gitcrawl",
            description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, PR status, repo work."
          }
        ]
      }
    }
  });
  assert.equal(result.verdict, "warn");
  assert.ok(result.findings.some((item) => item.code === "skill-pair-no-boundary"));
  assert.doesNotThrow(() => check({ manifest, installed: {} }));
  assert.throws(() => check({ manifest, installed: { capabilities: [] } }), /installed/);
  assert.throws(() => check({ manifest, installed: "nope" }), /installed/);
});

test("checkMany rejects empty packs, nameless items and duplicate names", () => {
  assert.throws(() => checkMany({ manifests: [] }), /non-empty|非空/);
  assert.throws(() => checkMany({ manifests: [{ description: "x" }] }), /name/);
  assert.throws(
    () => checkMany({ manifests: [{ name: "a" }, { name: "a" }] }),
    /duplicate/
  );
});

test("mf check --manifests checks a pack and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-check-"));
  const pack = join(dir, "pack.json");
  await writeFile(
    pack,
    JSON.stringify([
      { name: "feishu-doc", description: "Read and write Feishu documents." },
      { name: "feishu-wiki", description: "Read and write Feishu wiki pages." }
    ]),
    "utf8"
  );
  try {
    const result = await runCli(["check", "--manifests", pack, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.items, 2);
    assert.equal(payload.results.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check passes a clean capability and rejects a nameless manifest", () => {
  const clean = check({
    manifest: {
      name: "score_resume",
      description: "当用户需要给简历与岗位描述打分时使用，返回 0-100 分和缺失关键词。",
      parameters: {
        type: "object",
        properties: {
          resume: { type: "string", description: "简历文本" },
          jd: { type: "string", description: "岗位描述" }
        },
        required: ["resume", "jd"]
      }
    },
    installed: []
  });
  assert.equal(clean.verdict, "pass");
  assert.equal(clean.findings.length, 0);
  assert.throws(() => check({ manifest: {} }), /name/);
});
