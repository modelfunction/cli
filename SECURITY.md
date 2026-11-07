# Security

## Data boundary

- `mf` runs locally. There is no telemetry, no upload, and no server.
- The only outbound request is the model endpoint you configure. `mf scan --probe` also connects only to the MCP server you name.
- Local usage counters live in `~/.modelfunction/usage/*.jsonl`: command name, counts, ratios, versions, whether CI. They do not contain prompts, tool descriptions, file paths, or keys. Set `MF_NO_USAGE=1` to disable them. `mf feedback` is opt-in and exports aggregates only.
- Static commands (`scan`, `lint`, `audit`, `check`, `cluster`, `compare`, `coverage`) never call a model and never execute scanned code.
- Execution (`mf exec`, `eval --execute`) is opt-in. The Node permission model and Python audit hook are capability limits, not a security boundary; do not run untrusted third-party tools locally. Prefer static analysis or a remote sandbox.

## Keys

- Do not put API keys on the command line; logs and shell history retain them.
- Use environment variables or `mf config set-key <ENV_NAME>`.
- The credentials file is `~/.modelfunction/credentials.json` (permissions 0600 where supported).
- `mf scan --probe` strips environment values, URL userinfo, query strings, and headers from its report.

## Reporting a vulnerability

Email `hi@yunzerui.com` with the version (`mf --version`), reproduction steps, and impact. Do not open a public issue for a vulnerability. There is no bug bounty program.
