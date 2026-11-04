import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mfPath = fileURLToPath(new URL("../mf.js", import.meta.url));

test("cli runs when invoked through a symlink (pnpm layout)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mf-link-"));
  try {
    const link = join(root, "mf.js");
    try {
      await symlink(mfPath, link, "file");
    } catch {
      t.skip("symlink not permitted on this platform");
      return;
    }
    const result = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^mf \d+\.\d+\.\d+/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
