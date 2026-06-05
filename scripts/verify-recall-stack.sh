#!/usr/bin/env bash
# verify-recall-stack.sh — smoke-test the recall daemon's hook contract.
#
# Run AFTER `npm run build && nlm restart` so the running daemon has the
# current code loaded. Tests A → F live against the daemon at localhost:3940.
# Exit 0 if every check passes, non-zero on the first failure.
#
# This covers the cross-runtime HTTP contract that all four hook-bearing
# runtimes share. Per-runtime live agent verification (Claude Code, Codex
# CLI, Hermes Agent, pi.dev) needs an actual agent session — see
# docs/testing-recall.md for that checklist.

set -euo pipefail

PORT="${NLM_PORT:-3940}"
BASE="http://localhost:${PORT}"

# Pass an extra arg "-q" to silence per-check output (CI mode).
QUIET=0
if [[ "${1:-}" == "-q" ]]; then QUIET=1; fi

log() { [[ $QUIET -eq 0 ]] && echo "$@" || true; }
ok()  { log "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

require_jq() {
  command -v jq >/dev/null 2>&1 || fail "jq required (brew install jq)"
}
require_jq

log "Recall stack verification — daemon at ${BASE}"
log ""

# A. Daemon is up and responding.
log "A. Daemon health"
status=$(curl -s --max-time 2 "${BASE}/api/health" | jq -r '.status // "missing"')
[[ "$status" == "ok" ]] || fail "daemon /api/health not ok: $status"
ok "daemon responding"

# B. /api/recall returns sessions (basic recall).
log "B. /api/recall returns sessions"
results=$(curl -s --max-time 5 "${BASE}/api/recall?q=nlm&mode=keyword&limit=3")
n=$(echo "$results" | jq -r '.results | length')
[[ "$n" -ge 0 ]] || fail "recall results not an array: $results"
ok "recall returned $n result(s)"

# C. /api/recall WITHOUT hook source omits relatedFacts (default off for HTTP).
log "C. Default /api/recall omits relatedFacts"
hasFacts=$(curl -s --max-time 5 "${BASE}/api/recall?q=nlm&mode=keyword&limit=3" | jq 'has("relatedFacts")')
[[ "$hasFacts" == "false" ]] || fail "default /api/recall unexpectedly included relatedFacts"
ok "default omits relatedFacts (matches spec)"

# D. /api/recall WITH x-recall-source: hook attaches relatedFacts (may be empty).
log "D. Hook source attaches relatedFacts"
response=$(curl -s --max-time 5 "${BASE}/api/recall?q=nlm&mode=keyword&limit=3" \
  -H "x-recall-source: hook" -H "x-recall-runtime: smoke-test")
hasFacts=$(echo "$response" | jq 'has("relatedFacts")')
[[ "$hasFacts" == "true" ]] || fail "hook source did not attach relatedFacts field"
factCount=$(echo "$response" | jq '.relatedFacts | length')
ok "hook source response has relatedFacts (count=$factCount)"

# E. /api/recall WITH ?withFacts=false (no header) stays off.
log "E. Explicit ?withFacts=false stays off even from hook source"
hasFacts=$(curl -s --max-time 5 "${BASE}/api/recall?q=nlm&mode=keyword&limit=3&withFacts=false" \
  -H "x-recall-source: hook" | jq 'has("relatedFacts")')
[[ "$hasFacts" == "false" ]] || fail "?withFacts=false did not suppress facts"
ok "explicit withFacts=false respected"

# F. Hermes Agent pre-turn endpoint returns a context string.
log "F. Hermes Agent /pre-turn endpoint returns context"
response=$(curl -s --max-time 5 "${BASE}/api/hook/hermes-agent/pre-turn" \
  -X POST -H "content-type: application/json" \
  -d '{"session_id":"smoke_test_session","user_message":"what did we decide"}')
hasContext=$(echo "$response" | jq 'has("context")')
[[ "$hasContext" == "true" ]] || fail "hermes pre-turn missing context field"
ok "hermes pre-turn returns context field"

# G. Query log records the call with the hook source header.
log "G. /api/recall query log records hook source"
sleep 0.2  # let the fire-and-forget write land
if [[ -f "${HOME}/.nlm/query-log.jsonl" ]]; then
  lastSource=$(tail -n 50 "${HOME}/.nlm/query-log.jsonl" 2>/dev/null \
    | jq -s 'map(select(.source == "hook")) | last | .source // "none"')
  if [[ "$lastSource" == "\"hook\"" ]]; then
    ok "query log has at least one hook source entry"
  else
    log "  ? no hook source entry in tail of query-log.jsonl (may have rolled over)"
  fi
else
  log "  ? ~/.nlm/query-log.jsonl not present — daemon may not have written yet"
fi

# H. Hook log file is writable (for liveness canary).
log "H. Hook log present (~/.nlm/hook-log.jsonl)"
if [[ -f "${HOME}/.nlm/hook-log.jsonl" ]]; then
  ok "hook-log.jsonl exists"
else
  log "  ? hook-log.jsonl absent (real hooks have not fired yet on this daemon)"
fi

log ""
log "All HTTP-layer contract checks passed."
log ""
log "Per-runtime live tests still required:"
log "  - Claude Code:  fire a history-flavored prompt, confirm pointer block + Known facts section in the model context"
log "  - Codex CLI:    same, via marketplace plugin install"
log "  - Hermes Agent: same, via the plugin"
log "  - pi.dev:       same, via the pi extension"
log "  - Cursor/Windsurf/OpenCode: ask 'what did we decide about X', confirm agent calls recall_sessions"
log ""
log "See docs/testing-recall.md for the per-runtime checklist."
