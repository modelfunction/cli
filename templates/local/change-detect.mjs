#!/usr/bin/env node
// Change gate for the local nightly eval: skip model calls when neither the
// suite nor the model registry changed since the last successful run.
//
//   node change-detect.mjs              -> prints "run" or "skip"
//   node change-detect.mjs --exit-code  -> exit 1 = run, 0 = skip
//   node change-detect.mjs --mark       -> records the current hashes
//   FORCE_EVAL=1                        -> always run
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const suitePath = resolve(process.env.MF_SUITE ?? "mf.suite.json");
const modelsPath = resolve(process.env.MF_MODELS ?? "mf.models.json");
const statePath = resolve(process.env.MF_STATE ?? ".mf/eval-state.json");

async function digest(path) {
  try {
    const content = await readFile(path);
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  } catch {
    return "missing";
  }
}

const current = {
  suite: await digest(suitePath),
  models: await digest(modelsPath)
};

if (process.argv[2] === "--mark") {
  await mkdir(dirname(statePath), { recursive: true });
  const state = { ...current, updatedAt: new Date().toISOString() };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log("marked");
  process.exit(0);
}

let previous = null;
try {
  previous = JSON.parse(await readFile(statePath, "utf8"));
} catch {
  previous = null;
}

const forced = process.env.FORCE_EVAL === "1";
const unchanged =
  !forced &&
  previous !== null &&
  previous.suite === current.suite &&
  previous.models === current.models;

if (process.argv.includes("--exit-code")) {
  process.exit(unchanged ? 0 : 1);
}

console.log(unchanged ? "skip" : "run");
