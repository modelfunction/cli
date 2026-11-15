#!/usr/bin/env node
// Watches nightly scorecards for direction changes on individual cases.
// Chronic failures stay quiet; a case that flips from mostly-ok to mostly-miss
// (or the reverse) is the thing worth a human look, which is also why this
// script does not escalate merely for repeating the same outcome.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

function parseArgs(argv) {
  const options = { dir: ".mf/nightly", windows: 5, minRuns: 3, json: false, out: null, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") options.dir = argv[++i];
    else if (arg === "--windows") options.windows = Number(argv[++i]);
    else if (arg === "--min-runs") options.minRuns = Number(argv[++i]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--out") options.out = argv[++i];
    else if (!arg.startsWith("--")) options.files.push(arg);
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function loadCards(options) {
  const files = [...options.files];
  if (files.length === 0) {
    const entries = await readdir(options.dir).catch(() => []);
    for (const name of entries.sort()) {
      if (/^scorecard\..*\.json$/.test(name)) files.push(join(options.dir, name));
    }
  }
  const cards = [];
  for (const file of files) {
    const card = JSON.parse(await readFile(file, "utf8"));
    cards.push({ file, generatedAt: card.environment?.generatedAt ?? null, card });
  }
  cards.sort((a, b) => String(a.generatedAt ?? a.file).localeCompare(String(b.generatedAt ?? b.file)));
  return cards.slice(-options.windows);
}

function direction(rows) {
  let ok = 0;
  let miss = 0;
  for (const row of rows) {
    if (row.error) continue;
    if (row.selectionCorrect) ok += 1;
    else miss += 1;
  }
  if (ok === 0 && miss === 0) return { direction: "unknown", ok, miss };
  if (ok > miss) return { direction: "ok", ok, miss };
  if (miss > ok) return { direction: "miss", ok, miss };
  return { direction: "mixed", ok, miss };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cards = await loadCards(options);
  const models = new Map();

  for (const entry of cards) {
    for (const summary of entry.card.models ?? []) {
      if (!models.has(summary.model)) models.set(summary.model, new Map());
      const cases = models.get(summary.model);
      for (const row of summary.rows ?? []) {
        if (row.reviewed === false || row.excludeFromBase) continue;
        if (!cases.has(row.id)) cases.set(row.id, []);
        cases.get(row.id).push({ file: entry.file, row });
      }
    }
  }

  const report = { cards: cards.map((entry) => entry.file), models: [] };
  let alerts = 0;

  for (const [model, cases] of [...models.entries()].sort()) {
    const modelAlerts = [];
    const chronic = [];
    for (const [id, observations] of [...cases.entries()].sort()) {
      if (observations.length < options.minRuns) continue;
      const split = Math.floor(observations.length / 2);
      const earlier = direction(observations.slice(0, split).map((item) => item.row));
      const later = direction(observations.slice(split).map((item) => item.row));
      if (earlier.direction === "unknown" || later.direction === "unknown") continue;
      if (earlier.direction !== later.direction) {
        modelAlerts.push({
          id,
          before: earlier.direction,
          after: later.direction,
          beforeRuns: `${earlier.ok}/${earlier.ok + earlier.miss}`,
          afterRuns: `${later.ok}/${later.ok + later.miss}`
        });
        alerts += 1;
      } else if (earlier.direction === "miss") {
        chronic.push({ id, direction: "miss", runs: observations.length });
      }
    }
    if (modelAlerts.length > 0 || chronic.length > 0) {
      report.models.push({ model, alerts: modelAlerts, chronic });
    }
  }

  if (options.out) await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(
      `stability-watch: ${cards.length} card(s), ${report.models.length} model(s) with signals, ${alerts} direction change(s)`
    );
    for (const entry of report.models) {
      for (const alert of entry.alerts) {
        console.log(
          `alert: ${entry.model}/${alert.id} ${alert.before} → ${alert.after}（前 ${alert.beforeRuns}，后 ${alert.afterRuns}）`
        );
      }
      for (const item of entry.chronic) {
        console.log(`chronic: ${entry.model}/${item.id} 持续 ${item.direction} ${item.runs} 次（不重复升级）`);
      }
    }
  }
  return alerts > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
);
