#!/usr/bin/env bash
# Claude Code hook entry point for the dispatch bus.
#   ~/.dispatch/hook.sh <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|Notification|SessionEnd>
# Reads the hook JSON on stdin, talks to :7900 with a 2s budget, and prints
# the hook's JSON decision on stdout. MUST never block or fail the agent:
# any error → exit 0 with no output. Identity = $TMUX_PANE → fleet/registry.
exec python3 "$(dirname "$(readlink -f "$0")")/dispatch-hook.py" "$@" 2>/dev/null || exit 0
