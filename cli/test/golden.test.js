import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGolden } from "../scripts/golden.js";

const expectedDir = fileURLToPath(new URL("./golden/expected/", import.meta.url));

test("golden corpus: lint/cluster/check output matches snapshots", async () => {
  const actual = await buildGolden();
  for (const report of actual.suites) {
    const expected = JSON.parse(await readFile(join(expectedDir, `${report.suite}.json`), "utf8"));
    assert.deepEqual(
      report,
      expected,
      `${report.suite}: 静态检查输出变了。确认是有意调整后运行 npm run golden:update`
    );
  }
  const checks = JSON.parse(await readFile(join(expectedDir, "checks.json"), "utf8"));
  assert.deepEqual(actual.checks, checks, "check() 输出变了。确认是有意调整后运行 npm run golden:update");
});
