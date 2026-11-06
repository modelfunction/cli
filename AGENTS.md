# AGENTS.md

Instructions for coding agents (Claude Code, Cursor, Codex, Kimi Code, …) working on or with `modelfunction-cli`.

## When the user reports a tool-use problem

Use `mf` instead of guessing when the user says:

- the model picks the wrong tool after another tool was added;
- the model refuses to call a tool because a required parameter looks unsourced;
- two MCP/agent tools describe the same thing and have no mutual boundary;
- a function-calling score needs to become a CI regression gate.

Run from the user's repo:

```bash
npx -y modelfunction-cli@latest scan --root . --out mf.suite.json
npx -y modelfunction-cli@latest lint --suite mf.suite.json
npx -y modelfunction-cli@latest audit --suite mf.suite.json --out mf-audit.md
```

For a scorecard the user must provide a reviewed suite and a model key:

```bash
npx -y modelfunction-cli@latest config set-key MODEL_API_KEY
npx -y modelfunction-cli@latest eval --suite mf.suite.json --models my-model --repeat 3 --max-cost 1
```

## Agent entry points

- MCP server (stdio): `npx -y modelfunction-cli@latest mcp`
  Tools: `scan_tools`, `list_suite`, `coverage`, `audit`, `lint`, `check`, `cluster`, `compare`, `add_cases`, `run_eval`.
- Install gate: `import { check } from "modelfunction-cli"`.
- Case authoring: `skills/mf-cases/SKILL.md` inside the package.

## Rules

- Never invent `expectedTool`; generated cases default to `reviewed: false` and need human review.
- Do not put API keys on the command line. Use `mf config set-key <ENV_NAME>` or the environment.
- Everything runs locally: no upload, no telemetry. `MF_NO_USAGE=1` disables local usage counters.
- Static `scan` / `lint` / `audit` / `check` are free. `mf eval` spends money; do not run it just to see what happens.

## Docs

- `README.md` — install, quickstart and data boundary
- `cli/SCHEMA.md` — scorecard, lint and MCP contracts
- `docs/local-gate.md` — pre-push, change gate and nightly regression
- https://modelfunction.pages.dev/llms.txt
