# Troubleshooting

## "Worktree already exists at path"

A previous task's cleanup was skipped. Force-remove and retry:

```bash
git worktree remove --force ~/.dispatch-worktrees/<task_id>
git worktree prune
```

Then re-run the `setup` commands. If `git worktree remove` still fails (e.g. the directory is corrupted), fall back to:

```bash
rm -rf ~/.dispatch-worktrees/<task_id>
git worktree prune
```

## Orphaned worktrees from past sessions

Use the emergency cleanup script:

```bash
bash ~/.claude/skills/dispatch-worktree/scripts/prune-worktrees.sh
```

(Or wherever the skill is installed. The script nukes everything under `~/.dispatch-worktrees/`, so don't run it if you have an active task.)

## `push_work` rejected: "commit was not found"

The server checked its bare clone (even after a fetch) and couldn't find the commit you sent. Almost always means your `git push` didn't reach origin:

1. Read the output of your last `git push` — was there an error you missed?
2. `git log origin/<head_branch>..<head_branch>` — if this shows commits, they're local only.
3. Retry the push. Then retry `push_work`.

**Never fudge the commit SHA** to get past this. The server is right; origin doesn't have it.

## Push rejected: non-fast-forward

Origin has moved since you branched from `base_commit`. Rebase inside the worktree:

```bash
git fetch origin
git rebase origin/<base_branch>
# resolve any conflicts
git push -u origin <head_branch>
```

If the branch was already pushed and you had to rewrite it, use `--force-with-lease` (never plain `--force`):

```bash
git push --force-with-lease origin <head_branch>
```

Then re-record the new head with `push_work`.

## Push rejected: auth failure

Not a dispatch-mcp problem. Fix your git credentials (SSH key, HTTPS token, GCM config, etc.), then push, then `push_work`.

## User says "stop, cancel that"

```
cancel_task({id: "<task_id>"})
```

Then run the `cleanup` commands from the response. **Do not leave orphaned worktrees** — even on cancel.

## `claim_task` says "already in_progress"

Someone else claimed it first (or you claimed it in a different session and forgot). Call `get_task({id})` to see who owns it. If it's you, just use the existing worktree. If it's someone else, pick a different task.

## The worktree path has special characters or spaces

It shouldn't — `task_id` is always 8 hex chars from `randomUUID().slice(0,8)`. If you see anything else in the path, something is wrong with the task response — report it and abort.

## You need to look at the user's main checkout mid-task

`cd` out of the worktree, look, `cd` back. Worktrees preserve their state independently. That's the whole point.

## Multiple tasks running in parallel

Supported and expected. Each task has its own directory. Just pay attention to which `cwd` you're in before running destructive commands — a `rm -rf .` in the wrong worktree is no less destructive for being inside a worktree.

## The requester's branch doesn't exist anymore (review task)

They deleted it after dispatching. The pinned `head_commit` should still exist in the bare clone as long as the server fetched before you claimed — `git worktree add <commit>` works on any commit the clone has seen, even if no branch still points at it. If the worktree add fails with "bad revision," run `node src/admin.js fetch-repo <repo>` on the server (or ask the admin to), then retry.

## The dispatch-mcp server is down

You lose all task operations, but your worktrees are just git state on your disk — they keep working. Finish what you're in the middle of, and sync state back to the server once it's up.
