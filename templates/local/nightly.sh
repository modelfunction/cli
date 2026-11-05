#!/usr/bin/env bash
# Change-gated nightly eval: wakes up on schedule, spends money only when the
# suite or the model registry changed since the last successful run.
#
# Requires a models registry that maps model ids to apiKeyEnv names (never keys).
# The API key itself comes from the environment, e.g. MODEL_API_KEY=...
set -uo pipefail

VERSION="${MF_VERSION:-0.5.5}"
SUITE="${MF_SUITE:-mf.suite.json}"
MODELS="${MF_MODELS:-mf.models.json}"
OUT_DIR="${MF_NIGHTLY_DIR:-.mf/nightly}"
BASELINE="${MF_BASELINE:-.mf/baseline.json}"
MAX_COST="${MF_MAX_COST:-1}"
REPEAT="${MF_REPEAT:-3}"
RETRY="${MF_RETRY:-4}"
MIN_INTERVAL="${MF_MIN_INTERVAL:-1200}"
PROFILE="${MF_PROFILE:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$OUT_DIR"

decision="$(node "$HERE/change-detect.mjs")" || {
  echo "[mf] change detection failed" >&2
  exit 2
}
if [ "$decision" = "skip" ]; then
  echo "[mf] inventory unchanged; skipping eval (0 model calls)"
  exit 0
fi

stamp="$(date +%Y%m%d-%H%M%S)"
out="$OUT_DIR/scorecard.$stamp.json"
args=(eval --suite "$SUITE" --models-file "$MODELS" --repeat "$REPEAT"
  --max-cost "$MAX_COST" --retry "$RETRY" --min-interval "$MIN_INTERVAL"
  --out "$out")
if [ -n "$PROFILE" ]; then
  args+=(--profile "$PROFILE")
fi
if [ -f "$BASELINE" ]; then
  args+=(--baseline "$BASELINE" --fail-on-regression)
else
  echo "[mf] no baseline at $BASELINE yet; running without the regression gate"
fi

npx -y "modelfunction-cli@${VERSION}" "${args[@]}"
code=$?

# Only mark the inventory as evaluated when a scorecard was actually written,
# so an early crash does not make tomorrow's run skip silently.
if [ -f "$out" ]; then
  node "$HERE/change-detect.mjs" --mark >/dev/null
fi
exit "$code"
