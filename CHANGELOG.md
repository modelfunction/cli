# Changelog

All notable changes to `modelfunction-cli` are documented here. The suite
and scorecard contracts are versioned in `cli/SCHEMA.md`; v1 only adds fields.

## 0.13.2 — 2026-11-20

- `mf lint` no longer reports error `param-type-missing` for JSON Schema
  properties that carry type information through `anyOf`, `oneOf`, `allOf`,
  `$ref`, `enum`, or `const` without a top-level `type`. Real MCP servers emit
  nullable `anyOf` for optional parameters; probing the official playwright-mcp
  and memory servers produced 5 such false errors, now 0. Regression test
  added; golden corpus unchanged.

## 0.13.1 — 2026-11-20

- `mf scan --probe` now works with `npx` / `npm` / `uvx` MCP configs on
  Windows. Node cannot execute `.cmd`/`.bat` shims directly (`ENOENT` for
  `npx`, `EINVAL` for `npx.cmd`), so stdio probes launch through
  `cmd.exe /d /s /c` on Windows. Verified against
  `@modelcontextprotocol/server-filesystem` (16 tools listed) and covered by a
  Windows-only regression test.

## 0.13.0 — 2026-11-20

- The npm tarball now ships `docs/local-gate.md`. README has pointed to it
  since 0.5.5, but only `templates/` was added to the package in 0.11.4, so
  installed and `npx` users hit a dead link. `prepack` now copies both from
  the repository root, and the release checklist verifies it.
- `mf scan <path>` accepts the positional path as an alias for `--root`;
  passing both is an error. Previously the positional was silently ignored
  and the scan fell back to the current directory, producing a full tool list
  for the wrong repository.
- Local-gate templates: new `MF_MODEL` env var pins the model under test with
  an explicit `--models <id>` (a `--models-file` registry alone does not decide
  which model runs). Defaults for `MF_VERSION` in `templates/local/` moved from
  `0.7.0` to the current release.
- `docs/local-gate.md` gains a "network failure is not a behavior regression"
  section: pin the model explicitly and classify `errorsByKind` network/timeout
  as infrastructure before trusting the exit code. README documents running
  `npm run calibrate` against the old pack before upgrading.

## 0.12.0 — 2026-11-18

- `mf scan` now extracts decorator-registered Python tools from pydantic-ai
  (`@agent.tool`, `@agent.tool_plain`), OpenAI Agents (`@function_tool`, and
  `@tool(name_override=…, description_override=…)`), and FastMCP
  (`@mcp.tool()` / `@server.tool()`). Namespaced decorators require a matching
  framework import in the same file; injected parameters (`RunContext`,
  `RunContextWrapper`, `ToolContext`, or an unannotated `ctx`) are excluded
  from the schema.
- Parameter types that cannot be resolved statically (Pydantic models,
  TypedDict, dataclasses) no longer fall back to `string`. They emit an empty
  schema plus a tool-level `schemaNote: "unresolved-types: …"`, and `mf lint`
  reports them as info `param-type-unresolved` instead of error
  `param-type-missing`.
- Name and description precedence: `name_override` → `name` → function name;
  `description_override` → `description` → positional decorator string →
  docstring. Existing LangChain `@tool` definitions also gain the override and
  positional-string handling.
- Static only: the scanner never imports or executes project code. Tests 232
  (231 pass, 1 Windows symlink skip); golden corpus unchanged.

## 0.11.4 — 2026-11-18

- `mf compare` now warns when **both** scorecards lack an `environment` block
  (single-sided missing already warned; both-sided used to pass silently). The
  comparison stays allowed so pre-0.10 cards remain usable, but the warning
  says version and registry attribution are unavailable and deltas are
  descriptive only.
- `environment.sampling` uses `retry` / `minIntervalMs`, aligning with the
  `--retry` / `--min-interval` flags and the environment sidecar. Cards written
  by 0.10–0.11.3 (`retries` / `minInterval`) are normalized during comparison,
  so existing baselines stay comparable and do not need re-recording.
- The npm tarball now ships `templates/` (CI and local-gate templates). A
  `prepack` step copies them from the repository root; installed and `npx`
  users can finally use the template paths referenced by the docs.
- Documented that `retention: true` is a process marker excluded from the suite
  fingerprint: adding it to an already-scored suite neither invalidates
  baselines nor triggers fingerprint-based change gates.

## 0.11.3 — 2026-11-15

- Retention set and rotation for Goodhart protection: cases accept
  `retention: true`, and scorecards report `caseSplit` with separate tuning and
  retention selection accuracy. `mf eval --rotate <label> [--rotate-size <n>]`
  deterministically picks a subset of reviewed cases (`sha256(label:caseId)`),
  so the same label reproduces the same subset, and the scorecard records
  `rotation: { label, size, total, selected[] }`.
- `mf compare` treats different rotation labels or sizes as not comparable
  (`reason: "轮换集不同"`) and the regression gate skips instead of comparing
  across rotations. Reports without `--rotate` remain comparable with older
  cards.

## 0.11.2 — 2026-11-15

- `mf compare` now diffs failure kinds: when both scorecards carry
  `failureKinds`, each model result includes before/after counts, the kinds
  that changed with their delta, and per-case flips (`id`, before, after).
  Text output prints a failure breakdown change and the changed cases; the
  field is `null` when either card predates 0.11.0. Gates and exit codes are
  unchanged.
- New `templates/local/stability-watch.mjs` for nightly runs: compares the
  first and second half of the observation window per case and exits 1 only
  when a case's majority direction changes. Chronic misses are listed once
  instead of escalated every night.

## 0.11.1 — 2026-11-15

- Confusion space: scorecards now carry `confusionSpace` — mounted tool count,
  selection accuracy split by whether the expected tool has any static family
  neighbors in the mounted set, and misroutes attributed to a neighbor, to
  anything else, or to a hallucinated tool. Neighbors use the same boundary
  edges as `mf cluster` (lexical similarity ≥ .35 or family score ≥ .6) and are
  computed inside the current mounted set, so profile and ablation runs measure
  their own confusion space.
- Rows carry `confusableNeighbors` (only when > 0) and `pickedNeighbor` (only
  for `wrongTool`), and text/Markdown reports print the conditioning line.

## 0.11.0 — 2026-11-15

- Failure taxonomy: every scored row carries `failureKind` (`pass` /
  `legalFirstStep` / `args` / `wrongTool` / `hallucinatedTool` / `noCall` /
  `unexpectedCall` / `transport`), and scorecards aggregate `failureKinds` at
  the model and bucket level with all eight keys always present. A tool name
  that is not in the mounted set is reported as `hallucinatedTool` instead of
  being folded into ordinary misroutes; CLI paths pass the suite, profile and
  ablation tool sets, and library callers that omit `mountedTools` fall back to
  `wrongTool`. Existing metrics, gates and exit codes are unchanged.
- Text reports print a failure breakdown when any failure exists, and the
  Markdown case table appends the failure kind to failing rows.

## 0.10.1 — 2026-11-15

- The 0.10.0 tarball shipped the `calibrate` npm script but omitted
  `scripts/calibrate.js`, so `npm run calibrate -- <calibration.json>` failed
  with MODULE_NOT_FOUND on installed copies. The script is now part of the
  published files, and the release checklist requires confirming it in
  `npm pack --dry-run`.

## 0.10.0 — 2026-11-14

- Scorecards now embed an `environment` block: `mfVersion`, `node`, `os`,
  `generatedAt`, `modelsFileHash` (sha256 of the registry bytes actually
  loaded, including the built-in registry), `sampling` (`repeat` / `retries` /
  `minIntervalMs`) and `unknown[]`. Fields that cannot be captured are listed
  in `unknown` instead of guessed.
- `mf compare` refuses to compare scorecards whose known environment fields
  differ (exit 1, differences named in the output). `--cross-env` explicitly
  forces the comparison and labels it. Scorecards without an environment block
  (0.9.1 and older) remain comparable with a warning; fields declared in
  `unknown[]` are excluded from the consistency check and listed.
- `regressionGate` skips with an environment-specific message when the
  environments differ, instead of reporting a false regression or a silent ok.
- `mf compare` now validates its flags: unknown options print one warning line
  to stderr and are ignored, instead of being silently dropped by the inline
  argument filter. Exit codes are unchanged.
- Every comparable model comparison now reports `stats`: paired selection
  flips with an exact McNemar p-value (`b+c` discordant pairs; six one-way
  flips with no reverse flips is the p<.05 threshold) and the independent
  two-sample MDE for the current reviewed count (worst case p=.5, alpha=.05,
  power=.8; about 51pp at n=15 and 47pp at n=18). Stats are omitted when the
  definitions or environments are not comparable.
- New `mf replay <scorecard.json...> --suite <suite.json>` restates historical
  scorecards under the current expectations: selection accuracy before/after,
  per-case changes (old/new expected tool and bucket), and multiStep legal
  first steps. Args and pass are not recomputed because historical scorecards
  do not store actual arguments; the limitation is printed. Supports `--json`
  and `--out`.
- `npm run calibrate -- <calibration.json>` runs every lint rule's positive
  anchor and over-reporting guard (target-rule-only) and exits non-zero on any
  failure. `docs/release-checklist.md` makes it a mandatory release gate and
  requires append-only `generatedAgainst` / `verifiedAgainst` history.
- Suite cases accept an optional append-only `judgments[]` history
  (`from` / `to` / `changedAt` / `reason` / `evidencePointer`). Scorecards
  snapshot it as `suite.judgments[]`, and `mf compare` prints
  `judgmentChanges[]` when a case expectation moves: the before/after expected
  tool plus every recorded judgment and its evidence pointer.
- Flips of cases listed in `stability.unstable` on either side become
  `unstableFlips` warnings instead of regressions. They still count toward the
  metrics but no longer make `--fail-on-regression` exit 2; the gate lists
  them as warnings. This stops known high-entropy cases from repeatedly
  interrupting unattended nightly runs.

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
