#!/usr/bin/env bash
# Install dispatch-mcp client-side assets into a project:
#   - the dispatch-worktree skill (includes watcher + prune scripts)
#   - the /dispatch-next custom slash command
#
# Project-local only. The dispatch-worktree skill is intentionally scoped
# to projects that actually use dispatch-mcp — it doesn't need to load
# into every Claude Code session on your machine.
#
# Self-contained: this script lives inside the skill it installs, so you
# can run it from anywhere.
#
# Usage:
#   skills/dispatch-worktree/scripts/install-client.sh                   # into ./.claude
#   skills/dispatch-worktree/scripts/install-client.sh /path/to/project  # into /path/to/project/.claude
#
# The argument is a PROJECT ROOT (not a .claude directory) — the script
# creates/uses the .claude/ subdirectory under it.

set -e

PROJECT_ROOT="${1:-$PWD}"
TARGET="$PROJECT_ROOT/.claude"
SKILL_SRC="$(cd "$(dirname "$0")/.." && pwd)"
CMD_SRC="$SKILL_SRC/commands/dispatch-next.md"

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Error: project root does not exist: $PROJECT_ROOT" >&2
  exit 1
fi
if [ ! -f "$SKILL_SRC/SKILL.md" ]; then
  echo "Error: skill source missing at $SKILL_SRC (no SKILL.md)" >&2
  exit 1
fi
if [ ! -f "$CMD_SRC" ]; then
  echo "Error: slash command source missing at $CMD_SRC" >&2
  exit 1
fi

# Resolve to absolute path so the echoed instructions aren't relative to cwd
TARGET="$(cd "$PROJECT_ROOT" && pwd)/.claude"
INSTALLED_SKILL="$TARGET/skills/dispatch-worktree"

mkdir -p "$TARGET/skills" "$TARGET/commands"

# Normalize both paths (portable; no readlink -f / realpath dependency).
# If the skill source already lives at the install target, we are in
# the "user copied the skill into .claude/skills/ and is now running
# the installer in place" flow. Do NOT rm -rf the source — that would
# delete the skill. Just finalize the slash command.
_norm() { (cd "$1" 2>/dev/null && pwd) || echo "$1"; }
SKILL_SRC_NORM="$(_norm "$SKILL_SRC")"
INSTALLED_SKILL_NORM="$(_norm "$INSTALLED_SKILL" 2>/dev/null || echo "$INSTALLED_SKILL")"

if [ "$SKILL_SRC_NORM" = "$INSTALLED_SKILL_NORM" ]; then
  echo "  skill already in place at $INSTALLED_SKILL"
  echo "  (skipping copy — just finalizing slash command + permissions)"
  chmod +x "$INSTALLED_SKILL/scripts/"*.sh 2>/dev/null || true
else
  # Skill — copy the whole folder (includes commands/, scripts/, *.md)
  if [ -d "$INSTALLED_SKILL" ]; then
    echo "  (replacing existing $INSTALLED_SKILL)"
    rm -rf "$INSTALLED_SKILL"
  fi
  cp -r "$SKILL_SRC" "$TARGET/skills/"
  chmod +x "$INSTALLED_SKILL/scripts/"*.sh 2>/dev/null || true
fi

# Slash command — always refresh from the skill source
cp "$CMD_SRC" "$TARGET/commands/"

echo ""
echo "Installed (project-local):"
echo "  skill:    $INSTALLED_SKILL"
echo "  command:  $TARGET/commands/dispatch-next.md"
echo "  watcher:  $INSTALLED_SKILL/scripts/dispatch-watch.js"
echo
echo "Next: add dispatch-mcp to this project's .claude/claude.json with"
echo "your bearer token, then restart Claude Code in this project."
echo
echo "To start the event-driven watcher, in a separate terminal:"
echo
echo "  export DISPATCH_URL=http://YOUR_SERVER:7900/events"
echo "  export DISPATCH_TOKEN='<your bearer token>'"
echo "  export TMUX_TARGET=\"\$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')\""
echo "  node $INSTALLED_SKILL/scripts/dispatch-watch.js"
echo
echo "(Run the TMUX_TARGET line from inside the tmux pane where your"
echo " Claude Code session lives. The watcher injects /dispatch-next into"
echo " that pane whenever a task event arrives.)"
