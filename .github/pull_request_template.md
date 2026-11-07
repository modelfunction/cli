## Summary

What user symptom does this change address?

## Test plan

- [ ] `cd cli && npm test`
- [ ] `cd cli && npm pack --dry-run`
- [ ] If lint/cluster/check output changed intentionally: `npm run golden:update` and reviewed the diff

## Data boundary

- [ ] No API keys, customer data, or private tool descriptions
- [ ] Fixtures come from public repositories with a clear license
- [ ] No model calls in tests (local mock or local HTTP server only)

## Contract

- [ ] No JSON/exit-code change, or `cli/SCHEMA.md` updated
