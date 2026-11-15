import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCalibration } from "../scripts/calibrate.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/calibrate.js");

function descMissingRule() {
  return {
    rule: "desc-missing",
    positiveAnchor: {
      suite: {
        tools: [
          {
            name: "sample_tool",
            parameters: { type: "object", properties: {}, required: [] }
          }
        ]
      }
    },
    falsePositiveGuard: {
      suite: {
        tools: [
          {
            name: "sample_tool",
            description: "当用户要求处理文本时调用。输入一段文本，返回处理后的结果。",
            parameters: {
              type: "object",
              properties: { text: { type: "string", description: "要处理的文本内容，由用户在对话中直接给出" } },
              required: ["text"]
            }
          }
        ]
      }
    }
  };
}

test("calibration runner passes an anchor+guard pair and reports a broken guard", () => {
  const ok = runCalibration({ generatedAgainst: "0.10.0", rules: [descMissingRule()] });
  assert.equal(ok.total, 1);
  assert.equal(ok.passed, 1);
  assert.deepEqual(ok.failures, []);

  const broken = descMissingRule();
  broken.falsePositiveGuard.suite.tools = broken.positiveAnchor.suite.tools;
  const failed = runCalibration({ rules: [broken] });
  assert.equal(failed.passed, 0);
  assert.equal(failed.failures[0].rule, "desc-missing");
  assert.equal(failed.failures[0].guardOk, false);
});

test("calibration CLI exits non-zero when an anchor does not fire", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-calibration-"));
  try {
    const good = join(dir, "good.json");
    const bad = join(dir, "bad.json");
    await writeFile(good, JSON.stringify({ generatedAgainst: "0.10.0", rules: [descMissingRule()] }), "utf8");
    const broken = descMissingRule();
    broken.positiveAnchor.suite.tools = [];
    await writeFile(bad, JSON.stringify({ rules: [broken] }), "utf8");

    const pass = spawnSync(process.execPath, [SCRIPT, good], { encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /1\/1 rules pass \(generatedAgainst: 0\.10\.0\)/);

    const fail = spawnSync(process.execPath, [SCRIPT, bad], { encoding: "utf8" });
    assert.equal(fail.status, 1);
    assert.match(fail.stderr, /desc-missing: anchor=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
