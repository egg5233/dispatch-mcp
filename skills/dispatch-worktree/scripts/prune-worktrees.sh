#!/usr/bin/env bash
# Emergency cleanup: remove every worktree under ~/.dispatch-worktrees/
# and prune the main repo's worktree registry.
#
# Safe to run whenever you suspect orphaned worktrees are hanging around.
# Must be run from inside a git repository (the user's main checkout).

set -e

ROOT="${DISPATCH_WORKTREE_ROOT:-$HOME/.dispatch-worktrees}"

if [ ! -d "$ROOT" ]; then
  echo "No worktree root at $ROOT — nothing to do."
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "Error: must be run from inside a git repository" >&2
  exit 1
fi

shopt -s nullglob
found=0
for wt in "$ROOT"/*/; do
  found=1
  id=$(basename "$wt")
  echo "Removing dispatch-worktree: $id"
  # Try graceful removal first, fall back to force + manual rm
  if ! git worktree remove "$wt" 2>/dev/null; then
    if ! git worktree remove --force "$wt" 2>/dev/null; then
      echo "  (not a git worktree or already detached — removing directory directly)"
      rm -rf "$wt"
    fi
  fi
done

if [ $found -eq 0 ]; then
  echo "No dispatch worktrees under $ROOT."
fi

# Prune stale entries from .git/worktrees/ even if the directories are gone
git worktree prune
echo "done"
