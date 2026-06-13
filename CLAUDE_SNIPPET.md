# Dispatch MCP — Team Coordination

This project uses a shared dispatch-mcp server for coordinating work between teammates.

## Always-on rules

- **Identity is automatic.** The server binds your handle from the bearer token in `.claude/claude.json`. **Never** pass `user`, `from_user`, or `handle` to any dispatch tool — those arguments don't exist. If you want to know who you are, call `whoami`.
- **Check for work at session start.** Call `my_tasks` as one of your first actions when a session begins. If there's anything waiting, surface it to the user before asking what to do next.
- **One task, one worktree.** For any `review` or `work` task you claim, you operate inside a dedicated git worktree — **never** in the user's main checkout. The server tells you the exact commands in its tool responses.

## Dispatching and executing tasks

Task creation, claiming, pushing, and completing are multi-step procedures with exact git commands that depend on the task kind. These live in the **`dispatch-worktree` skill**, which triggers automatically when you call any dispatch tool or the user mentions task-related work ("check my tasks", "review my branch", "ask Alex to…"). Follow that skill's protocol verbatim; do not improvise the git commands.

If the skill is not installed on this machine, ask the user to run:

```bash
cp -r skills/dispatch-worktree ~/.claude/skills/
```

from the dispatch-mcp checkout.
