import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliRoot = resolve(here, "..");

function copyDir(name) {
  const target = resolve(cliRoot, name);
  rmSync(target, { recursive: true, force: true });
  cpSync(resolve(repoRoot, name), target, { recursive: true });
}

function copyDoc(name) {
  const targetDir = resolve(cliRoot, "docs");
  mkdirSync(targetDir, { recursive: true });
  cpSync(resolve(repoRoot, "docs", name), resolve(targetDir, name));
}

copyDir("templates");
rmSync(resolve(cliRoot, "docs"), { recursive: true, force: true });
copyDoc("local-gate.md");
copyDoc("mcp-audit.md");
