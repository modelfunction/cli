# mf — function-calling quality gate for agent tools

`mf` checks the tool layer of an agent, not the prompt. It scans tool and skill
definitions, runs static checks for descriptions, parameters and confusable
families, and optionally scores real models on a reviewed selection suite.

- **Static, zero-key**: `scan` / `lint` / `audit` / `check` do not call a model.
- **Model eval, opt-in**: `eval` measures tool selection and arguments, with
  `--profile` for “same agent, different mounted toolset”.
- **Durable asset**: a reviewed suite is the thing worth keeping; scorecards
  carry content fingerprints so two runs are comparable.
- **Local by default**: no telemetry, no server; the only outbound traffic is
  the model endpoint you configure.

## Install

```bash
npx -y modelfunction-cli@0.5.4 --version
```

## Quickstart

```bash
# 1. Draft a suite from an MCP config, OpenAPI, function.json, or code
npx -y modelfunction-cli@0.5.4 scan --root ./agent --out mf.suite.json

# 2. Static checks (no model, no cost)
npx -y modelfunction-cli@0.5.4 lint --suite mf.suite.json
npx -y modelfunction-cli@0.5.4 audit --suite mf.suite.json --out mf-audit.md

# 3. Add reviewed cases, then evaluate a real model
npx -y modelfunction-cli@0.5.4 config set-key SILICONFLOW_API_KEY
npx -y modelfunction-cli@0.5.4 eval --suite mf.suite.json \
  --models dsv4-flash --repeat 3 --max-cost 1 --out scorecard.md
```

`--repeat 3` uses majority scoring because temperature 0 can still flip a tool
call; treat a single run as a smoke test, not a gate.

## CI / GitHub Action

Static checks are free and safe on every PR, including forks. Model eval needs
a key and should only run where secrets exist.

```yaml
name: tool-quality
on: [pull_request, push]
permissions:
  contents: read
jobs:
  mf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: modelfunction/cli@v0.5.4
        with:
          mode: both
          suite: mf.suite.json
          models: dsv4-flash
          advisory: true
        env:
          SILICONFLOW_API_KEY: ${{ secrets.SILICONFLOW_API_KEY }}
```

For a fork-PR split (static on forks, eval only on same-repo branches), see
`templates/ci/github-actions.yml`.

## Commands

| Command | Purpose |
| --- | --- |
| `scan` | Extract tools/skills from code, MCP config, OpenAPI, `function.json` |
| `lint` | Description, parameter, required-source and confusable-pair rules |
| `audit` | One static report: lint + families + coverage + mounts |
| `check` | Static install gate for a tool/skill package |
| `eval` | Function-calling scorecard (`--profile` for mount comparison) |
| `cluster` | Suggest mounted groups and confusable families |
| `compare` | Compare two scorecards when content fingerprints match |
| `ablate` | Leave-one-tool-out interference check |
| `exec` | Run one tool with capability limits and collect metrics |
| `config` / `stats` / `feedback` | Local credentials and opt-in usage summary |
| `mcp` | Expose the static checks as an MCP server |

Details: [cli/README.md](cli/README.md) · [SCHEMA.md](cli/SCHEMA.md) ·
[getting started](docs/getting-started.md) · [CHANGELOG.md](CHANGELOG.md).

## Data boundaries

- Suites, tool definitions and scorecards stay local unless you forward them.
- Model eval sends the case input and tool descriptions to your configured
  provider; choose a provider that meets your data policy.
- Keys come from environment variables or `~/.modelfunction/credentials.json`
  (0600). The model registry stores `apiKeyEnv` names, never key values.
- Usage counters are local aggregates only; `MF_NO_USAGE=1` disables them.

## License

MIT. See [LICENSE](LICENSE).
