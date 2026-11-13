# Changelog

All notable changes to `modelfunction-cli` are documented here. The suite
and scorecard contracts are versioned in `cli/SCHEMA.md`; v1 only adds fields.

## 0.9.1 — 2026-11-13

- `mf eval` / `mf ablate` no longer fall back to the mock adapter when no
  model can be resolved and `--models` was not given. The run exits 1 with the
  expected credential names and a pointer to `--models mock`, instead of
  producing a valid-looking mock scorecard that an unattended nightly job could
  mistake for a real measurement. Explicit `--models mock` is unchanged.

## 0.9.0 — 2026-11-12

- `desc-or-contradiction` now recognises the two wording families that dominate
  real tool descriptions: imperative negatives ("do NOT call file_read first")
  and self-contained claims ("this tool does the reading and writing itself").
  0.8.0 only recognised "call this tool directly", so it missed its own anchor
  family. Chinese equivalents are covered too.
- `singleIntent` is split by case polarity: `buckets.singleIntent.positives` /
  `negatives` and the top-level `selectionAccuracySingleIntentPositives` /
  `abstentionRateSingleIntent` report selection and abstention separately.
  `selectionAccuracySingleIntent` keeps its 0.8 meaning (both mixed) for gate
  compatibility, and both SCHEMA and the report now disclose that it is mixed.
  `scored` excludes transport-error rows from both sub-rates.
- Multi-step transport failures no longer hide inside behavioural misses:
  `firstCallErrors`, `firstCallBehaviorMisses` and
  `legalFirstStepRateExcludingErrors` separate "the model chose wrong" from
  "the request never completed" (429/timeout/network).
- Human-readable reports show the canonical `selectionAccuracySingleIntent` in
  the select column and print the positive/negative breakdown when negatives
  exist.

## 0.8.0 — 2026-11-11

- Three-bucket case schema: `bucket` (`singleIntent` | `multiStep` |
  `ambiguous`, default `singleIntent`) and optional `acceptableFirstCalls`.
  A multiStep/ambiguous opening move inside that set is a legal first step,
  not a misroute; first-call misses are reported separately and stay out of
  the headline. `selectionAccuracy` keeps its v1 all-cases meaning;
  `selectionAccuracySingleIntent` is the external/gate headline. Bucket tags
  persist into scorecard rows and `mf compare`, which now keeps legal first
  steps out of persistent interference and never merges buckets.
- New `desc-or-contradiction` warning: a tool that claims "call this tool
  directly" while one of its parameters accepts both inline content and a
  locator ("file contents or file paths"). The model reads that as permission
  to fetch first; first-call scoring then records a legal two-step plan as a
  misroute.
- `MODEL_API_KEY` works as a provider-neutral fallback when a selected
  model's own key variable is unset; the CI template and public README use it
  instead of hard-coding a vendor secret name.
- `mf compare` adds `stabilityCaptured` per model and prints an explicit note
  when either report lacks `--repeat` data. `stable` still means
  "no drift observed", but the output no longer lets that read as confirmed
  stability.

## 0.7.0 — 2026-11-09

- `mf compare` reports persistent interference: the same expected → actual
  mis-selection pair recurring at least 3 times across at least 2 cases in the
  two compared reports. Each entry separates stable mis-selection from
  high-entropy drift (`--repeat`).
- `mf scan` no longer reports template-string or unresolved-constant
  descriptions as missing; they are marked `descriptionSource: "runtime"`.
- New `pair-family-sibling` info rule: same-family tools with distinct actions
  (`filesystem-copy-file` × `filesystem-move-file`) are no longer boundary
  warnings. Families that share an action verb (`search_docs` × `search_wiki`)
  still warn.
- anything-llm plugin scan: pair warnings 146 → 37 (remaining are cross-vendor
  gmail × outlook pairs).
- Python scans read Google-style docstring `Args:` sections and fill parameter
  descriptions when the type annotations do not carry them.

## 0.6.2 — 2026-11-08

- `param-optional-imperative` no longer treats noun phrases ("Include tool
  messages") or a tool's own action ("Send message ... by sessionKey") as
  imperative guidance. It scans every occurrence of the parameter name and
  requires an explicit parameter link.
- `mf compare` now honours `excludeFromBase` in regression and metric
  comparisons, with an `excluded` count in the report; excluded rows no longer
  count as regressions.
- `mf compare --fail-on-regression` exits 2 on a comparable regression, so a
  standalone compare step can fail CI. Default exit-code semantics (suite
  changes only) are unchanged.

## 0.6.1 — 2026-11-06

- New advisory lint rules, both `info` and non-blocking:
  - `param-optional-imperative`: imperative wording for an optional parameter
    can suppress the call entirely when the input omits that parameter.
  - `desc-dangling-tool`: descriptions that reference a tool name absent from
    the suite, usually left behind by a rename.
- Authoring guidance in `skills/mf-cases/SKILL.md` now covers named vs generic
  negation, optional-parameter imperatives, rename references, and phrasing
  that commits a scope.

## 0.6.0 — 2026-11-06

- Tokens are the primary usage metric: scorecards add `totalTokens` next to
  `inputTokens` / `cachedTokens` / `outputTokens`.
- Model registry entries accept `currency` (CNY/USD, default CNY). Scorecards
  report `totalCost` / `avgCost` with `costCurrency`; `totalCostCny` /
  `avgCostCny` remain as CNY-only compatibility aliases.
- `mf eval --max-tokens <n>` stops a run after cumulative input+output tokens
  cross the limit (exit 2, no partial scorecard). `--max-cost` keeps working
  and now follows the registry currency.
- MCP `run_eval` accepts `maxTokens`; the composite action exposes
  `max-tokens`.
- `--fail-on-regression` now exits 2 instead of skipping when a baseline model
  is missing from the new scorecard, or when every reviewed call failed:
  "cannot determine" is not the same as "no regression".
- Auto-selected models are reported on stderr with the environment variable
  that selected them, so a stray key cannot silently route calls elsewhere.
- Local gate templates use exit-code change detection, update the inventory
  state only after a successful eval, and ship `.cmd` with CRLF line endings.

## 0.5.5 — 2026-11-05

- `mf eval --retry <n>` controls retries for HTTP 429/5xx and network errors
  (default 2, i.e. 3 attempts total) with exponential backoff; a server
  `Retry-After` header takes precedence (capped at 30 s).
- `mf eval --min-interval <ms>` enforces a minimum gap between model requests,
  so RPM-limited endpoints can run without throttling noise.
- Scorecards add `models[].retries` and per-row `retries` (when > 0), keeping
  retry activity visible without counting it as a model failure.
- The CI template's static layer now runs `cluster --json`, matching
  `action.yml`; the stale `continue-on-error` comment is corrected.
- New `templates/local/` and `docs/local-gate.md`: pre-push static gate,
  inventory-hash change gate, and change-triggered nightly regression for
  internal / non-GitHub environments.

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
