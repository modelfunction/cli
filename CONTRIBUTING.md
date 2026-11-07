# Contributing

## Setup

- Node.js >= 20
- `cd cli && npm ci && npm test`
- `npm run verify` runs the test suite and a `npm pack --dry-run`.

## Rules

- Keep changes small and focused; one concern per pull request.
- Never commit API keys, customer data, or code with unclear provenance. Fixtures must come from public repositories with a clear license.
- By contributing you agree that your contribution is licensed under the MIT license.

## Adding a lint rule

1. Implement it in `cli/lib/lint.js` and keep it advisory unless it is a hard schema error.
2. Add cases to `cli/test/lint.test.js` (positive, negative, and a low-false-positive case).
3. If the JSON contract changes, update `cli/SCHEMA.md`.
4. Run `npm test`. If the rule intentionally changes lint/cluster/check output, run `npm run golden:update` and review the diff before committing.

## Adding a model adapter

- Put it under `cli/lib/adapters/`, key it from the environment (never inline), and reuse the `usage` shape (`input`, `cached`, `output`).
- Add a test that uses a local HTTP server; do not call real endpoints in tests.

## Pull requests

- Run `cd cli && npm test` and include a short test plan.
- Describe the user symptom, not only the code change.
- Do not include generated fixtures from private or unlicensed code.
