#!/usr/bin/env bash
# Launch a pm2 watcher per fleet.json handle. Usage: launch-watchers.sh [--restart] [--only <handle>]
# Since dispatch v2 P1 this is a thin wrapper over `dispatch-fleet watchers`, which derives every
# watcher's env from ~/.dispatch/fleet.json (the single registry). The old pane-keyed
# registry.json and the generated watchers.<host>.cjs ecosystem are no longer used to start
# watchers — the .cjs file drifted from reality (stale pane ids, phantom handles) because it
# was a one-time snapshot. Requires: dispatch-fleet sync (or deploy-fleet.mjs) first.
set -euo pipefail
FLEET_CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli/dispatch-fleet"
[ -x "$HOME/.dispatch/dispatch-fleet" ] && FLEET_CLI="$HOME/.dispatch/dispatch-fleet"
exec python3 "$FLEET_CLI" watchers "$@"
