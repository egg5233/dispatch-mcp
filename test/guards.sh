#!/usr/bin/env bash
# Live tmux test for the dead-pane guard (T-20260903-16). Creates a throwaway
# tmux session whose pane process exits with remain-on-exit, so the pane is
# dead but #{pane_current_command} still shows the last command. Both the
# watcher guard (--selftest) and dispatch-fleet check must call it dead.
#   bash test/guards.sh        (needs tmux; uses the session's own server)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S=dispatch-guard-test-$$
tmux new-session -d -s "$S" -x 80 -y 20 'sleep 1; exit 7'
tmux set-option -t "$S" remain-on-exit on
sleep 2
PANE=$(tmux list-panes -t "$S" -F '#{pane_id}')
INFO=$(tmux display -p -t "$PANE" '#{pane_dead} #{pane_dead_status} #{pane_current_command}')
echo "pane $PANE: dead/status/cmd = $INFO"
fail=0
# 1. watcher guard: expected cmd deliberately matches the stale one → must still BLOCK
OUT=$(DISPATCH_URL=http://127.0.0.1:1/events DISPATCH_TOKEN=x TMUX_TARGET="$PANE" DISPATCH_EXPECT_CMD="${INFO##* }" node "$ROOT/skills/dispatch-worktree/scripts/dispatch-watch.js" --selftest 2>&1 || true)
echo "watcher: $OUT"
grep -q "BLOCKED — pane dead" <<<"$OUT" || { echo "FAIL: watcher did not block on dead pane"; fail=1; }
# 2. dispatch-fleet check with a temp fleet.json pointing a handle at the dead pane
T=$(mktemp -d); printf '{"version":1,"handles":{"ghost":{"token":"x","runtime":"claude","pane":"%s"}},"retired":[]}\n' "$PANE" > "$T/fleet.json"; echo '{}' > "$T/registry.json"
OUT2=$(DISPATCH_HOME="$T" DISPATCH_URL=http://127.0.0.1:1 DISPATCH_REPO="$ROOT" python3 "$ROOT/cli/dispatch-fleet" check 2>&1 || true)
echo "$OUT2" | grep -E "ghost|problem" | head -3
grep -q "PANE DEAD" <<<"$OUT2" || { echo "FAIL: fleet check did not flag dead pane"; fail=1; }
tmux kill-session -t "$S"; rm -rf "$T"
[ $fail -eq 0 ] && echo "guards.sh: PASS" || { echo "guards.sh: FAIL"; exit 1; }
