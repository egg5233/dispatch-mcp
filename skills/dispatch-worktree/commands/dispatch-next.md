---
description: Check dispatch-mcp for work and execute exactly one task via the dispatch-worktree skill. Invoked automatically by dispatch-watch.
---

You are being invoked by the **dispatch-watch** daemon because dispatch-mcp fired a task event that needs your attention. Execute exactly **one** task, then stop — do not loop. The watcher will fire me again for the next event.

## What to do

1. **Check what's waiting.** Call `my_tasks`. If it returns nothing, say "no actionable tasks" and stop.

2. **Pick one task**, in this priority order:
   - A task addressed to me (or unassigned, `to_user` is null) in status `open` → this is a new dispatch, claim and execute it.
   - An existing `in_progress` or `pushed` task I already own, with a new comment from someone other than me → read the comment and act on it (fix the reported issue, answer the question, re-submit if changes were requested).
   - A task I had claimed that is now `cancelled` → run the worktree cleanup commands so nothing is orphaned.

3. **Execute via the dispatch-worktree skill.** That skill is installed and will trigger automatically — follow its protocol for the task kind:
   - `review` → `review.md` protocol (set up detached-HEAD worktree, read, verdict, cleanup)
   - `work` → `work.md` protocol (branching worktree, do the work, push, `push_work`, complete, cleanup)
   - `discussion` → no worktree, respond via `comment_on_task`, then `complete_task` when resolved

4. **Run every git command verbatim** from the `worktree.setup` / `push` / `cleanup` arrays in the tool responses. Do not improvise.

5. **Complete the task fully** — including cleanup — before returning control. A half-finished task with an orphaned worktree is worse than no progress at all.

6. **Stop after one task.** Even if `my_tasks` shows multiple, only do the top-priority one. The watcher will invoke me again for the next one.

## What NOT to do

- Don't loop or repeatedly call `my_tasks` — one call, one task, done.
- Don't modify files outside the worktree directory.
- Don't skip the worktree protocol "to save time." The isolation is the whole point.
- Don't make assumptions about task scope — read `description` carefully before acting.
- Don't push to shared branches (`main`, `master`, etc.) unless the task explicitly says to.
- Don't pass `user` / `from_user` / `handle` to any dispatch tool. Identity is bound by the server.

## If something looks wrong

- If a tool response has an `Error:` message, read it — it usually says exactly what to fix (e.g., "commit not found: did git push succeed?").
- If the worktree path already exists, the previous run left orphans — use `~/.claude/skills/dispatch-worktree/scripts/prune-worktrees.sh` or `git worktree remove --force` before retrying.
- If you genuinely cannot proceed (ambiguous description, missing repo registration, etc.), `comment_on_task` explaining the blocker and stop. Do **not** complete a task you couldn't actually do.
