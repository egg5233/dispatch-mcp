#!/usr/bin/env bash
# Launch a pm2 watcher per registered pane. Usage: launch-watchers.sh <base_url> <tmux_tmpdir> [handle-filter]
set -euo pipefail
BASE="${1:?base url e.g. http://127.0.0.1:7900}"
TTD="${2:?tmux tmpdir e.g. /var/solana/data/tmp}"
ONLY="${3:-}"
REG="$HOME/.dispatch/registry.json"
WATCHER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills/dispatch-worktree/scripts/dispatch-watch.js"
PROMPT='Run ~/.dispatch/dispatch-recv to read new dispatch message(s), act on them, then reply with ~/.dispatch/dispatch-send <who> ...'
mapfile -t ROWS < <(python3 -c "import json;[print(p,d['handle'],d['token']) for p,d in json.load(open('$REG')).items()]")
for row in "${ROWS[@]}"; do
  read -r pane handle token <<<"$row"
  [ -n "$ONLY" ] && [ "$handle" != "$ONLY" ] && continue
  DISPATCH_URL="$BASE/events" DISPATCH_TOKEN="$token" TMUX_TARGET="$pane" TMUX_TMPDIR="$TTD" \
    DISPATCH_PROMPT="$PROMPT" DISPATCH_IDLE_POLL_MS=1500 \
    pm2 start "$WATCHER" --name "watch-$handle" --interpreter node --update-env -f >/dev/null 2>&1 \
    && echo "started watch-$handle ($pane)"
done
