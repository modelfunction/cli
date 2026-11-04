import test from "node:test";
import assert from "node:assert/strict";
import { checkSandbox, formatSandboxReport } from "../lib/sandbox-check.js";

test("sandbox check reports engines and a recommendation", () => {
  const report = checkSandbox();
  assert.equal(report.platform, process.platform);
  assert.equal(report.node.version, process.versions.node);
  assert.ok(Array.isArray(report.engines));
  assert.ok(report.engines.length >= 6);
  const nodeEngine = report.engines.find((engine) => engine.name === "node-permission");
  assert.ok(nodeEngine);
  assert.equal(nodeEngine.available, true);
  assert.equal(typeof report.recommendation.nodeTools, "string");
  assert.ok(report.recommendation.note.length > 0);

  const text = formatSandboxReport(report);
  assert.match(text, /sandbox check/);
  assert.match(text, /recommendation:/);
  assert.match(text, /Node 工具/);
});
