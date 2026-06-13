---
name: dispatch-worktree-codex
description: Use when claiming, working on, or completing dispatch-mcp tasks from Codex CLI. Handles the git-worktree protocol so parallel tasks don't collide with the user's main checkout. Trigger when calling any dispatch-mcp tool (my_tasks, claim_task, request_review, request_work, push_work, complete_task, cancel_task, comment_on_task, start_discussion), or when the user says "check my tasks", "claim this task", "review my branch", "ask <name> to fix/build/review", or "dispatch a task".
---

# dispatch-worktree-codex

Protocol for working with dispatch-mcp tasks from Codex CLI. The dispatch-mcp server coordinates task state and verifies git refs, but **never runs commands on your machine**. This skill tells you which git commands to run locally for each kind of task.

This is the Codex-flavored copy of the `dispatch-worktree` skill that ships for Claude Code. The protocol is identical — dispatch-mcp is runtime-agnostic — but this copy lives under `.agents/skills/` where Codex discovers skills, and drops the Claude-Code-specific pieces (slash command, watcher daemon, `install-client.sh`) because Codex doesn't use them.

## Golden rule

**One task, one worktree, at `~/.dispatch-worktrees/<task_id>`.** Run the `setup` / `push` / `cleanup` command arrays in the dispatch-mcp tool response **verbatim**. Do not improvise equivalents.

## Task kinds

| Kind | What it is | States | Git |
|---|---|---|---|
| `review` | Look at someone's pushed code | open → in_progress → closed (+verdict) | Detached HEAD at a pinned commit |
| `work` | Produce code for someone | open → in_progress → pushed → closed | New branch from a pinned base_commit |
| `discussion` | Talk, no code | open → in_progress → closed | None |

## Which file to read next

These files sit beside this SKILL.md. Read the one that matches what you're doing:

- **Reviewing someone's code** (claimed a `review` task) → `review.md`
- **Doing work for someone** (claimed a `work` task) → `work.md`
- **Asking someone else** to review or build → `dispatching.md`
- **Something broke** (worktree conflict, push rejected, orphans) → `troubleshooting.md`

For a `discussion` task, the entire protocol is: `claim_task` → `comment_on_task` (as many rounds as needed) → `complete_task`. No worktree, no git. Nothing more to read.

## Hard rules

1. Worktree path is **always** `~/.dispatch-worktrees/<task_id>`. No exceptions.
2. Run the `setup` / `push` / `cleanup` arrays from tool responses verbatim.
3. Never call `push_work` with a commit that isn't on origin — the server will reject it.
4. Always run cleanup, even on `cancel_task`. Orphans accumulate.
5. Never pass `user` / `from_user` / `handle` to dispatch tools. Identity is bound by the bearer token.

## Quick reference

| Intent | Tool | Worktree action |
|---|---|---|
| See my queue | `my_tasks` | — |
| Inspect a task | `get_task` | — |
| Start working | `claim_task` | run `setup` |
| Record a push (work only) | `push_work` | — |
| Finish | `complete_task` | run `cleanup` |
| Drop it | `cancel_task` | run `cleanup` |
| Ask for review | `request_review` | push your code **first** |
| Ask for new code | `request_work` | pin a `base_commit` |
| Start a thread | `start_discussion` | — |

## Runtime note

dispatch-mcp is runtime-agnostic — the same user handle, same bearer token, and same task IDs work from Codex CLI and Claude Code interchangeably. You can claim a task here, complete it from Codex; or complete one a teammate's Claude Code session dispatched to you. `claim_task` is atomic on the server, so if your Claude Code session claims a task first, your Codex session's attempt will get an "already claimed" error and should move on — no coordination needed beyond that.
