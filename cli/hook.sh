#!/usr/bin/env bash
# Claude Code hook entry point for the dispatch bus.
#   ~/.dispatch/hook.sh <SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop|Notification|SessionEnd|Wait>
# Reads the hook JSON on stdin, talks to :7900 with a 2s budget, and prints
# the hook's JSON decision on stdout. MUST never block or fail the agent:
# dispatch-hook.py swallows every exception and exits 0. The only non-zero
# exits are deliberate: Stop/Wait exit 2 with the reason on stderr, which is
# the documented "block / continue the conversation" signal.
exec python3 "$(dirname "$(readlink -f "$0")")/dispatch-hook.py" "$@" || exit 0
