# Changelog

All notable changes to `modelfunction-cli` are documented here. The suite
and scorecard contracts are versioned in `cli/SCHEMA.md`; v1 only adds fields.

## 0.5.4 — 2026-11-04

- Cases can opt out of a scoring scope with `excludeFromBase` /
  `excludeFromProfiles`. Excluded cases still run; they just do not enter that
  scope's official metrics.
- Scorecards separate provider failures from selection failures:
  `errorKind`, `errorsByKind`, `scoredTotal`, and
  `selectionAccuracyExcludingErrors`. Mount comparisons no longer report
  timeouts as `jammed`; each group lists `errors`.
- `mf audit` shows a per-group negative-case ratio (`neg%`) while keeping the
  suite-wide warning unchanged.
- Group token usage is aggregated under `profiles.models[].profiles[].usage`
  and `totals.usage` (input, cached, output, cost).
- CI template split into a keyless static layer (runs on every PR, including
  forks) and a model eval layer (same-repo only, `--max-cost`, advisory gate).

## 0.5.3 — 2026-11-02

- Static rules are faster: prepared tokenization and allocation-free Jaccard.
  Real 100-capability `checkMany`: 471 ms → 40 ms; 550 capabilities:
  9.6 s → 2.1 s.
- `check()` rejects malformed `installed` shapes instead of returning a false
  pass; accepts capability arrays, `{tools,skills}`, and scan output.
- `profiles` accepts platform-style object and array registries
  (`{agentType, tools, skills}`).
- Fixed pure-skill suite exit code and `descriptionSource` false positives in
  install gates.

## 0.5.2 — 2026-11-01

- MCP exposes static `lint` / `check` / `cluster` / `compare` tools.
- `checkMany()` checks a whole package in one call; `mf check --manifests`.
- Install-gate severities narrowed: only missing descriptions, missing
  parameter types, unsourced required parameters, and no-boundary pairs
  remain error/warn.

## 0.5.1 — 2026-10-31

- User-level credentials: `mf config set-key|remove-key|list|path`.
- Local usage counters and `mf stats` / `mf feedback` (aggregates only,
  never uploaded, `MF_NO_USAGE=1` to opt out).
- `mf eval --progress`, `mf eval --max-cost`, `mf audit`, and streamable
  HTTP MCP probing in `mf scan --probe`.
