# Review task protocol

You've been assigned or have claimed a `review` task. The requester already pushed their code. Your job: look at the exact commit they pinned, form an opinion, return a verdict.

## 1. Claim

```
claim_task({id: "<task_id>"})
```

The response includes `worktree.setup` and `worktree.cleanup` command arrays. Save the `task_id` and the cleanup commands somewhere you can find them later.

## 2. Set up the worktree

Run the `setup` array verbatim. For a review it looks like:

```bash
# From inside the user's local checkout of the repo
git fetch origin
git worktree add ~/.dispatch-worktrees/<task_id> <head_commit>
cd ~/.dispatch-worktrees/<task_id>
```

You're now in a detached-HEAD checkout at the exact commit the requester pinned. This guarantees you're looking at the same code they meant, not your stale `main`.

## 3. Read the code

- The task's `files` field lists what the requester wants attention on — start there.
- If `base_commit` is set, see the diff: `git log -p <base_commit>..<head_commit>`.
- Use `git show <commit>` for individual commits in the range.

## 4. Form an opinion and complete with a verdict

```
complete_task({
  id: "<task_id>",
  result: "<written review — what you looked at, what you found, suggestions>",
  verdict: "approved"          // or "changes_requested"
})
```

**Always set `verdict`.** A review without a verdict is just prose — the requester has no clear signal.

## 5. Cleanup

Run the `cleanup` array from any of the tool responses:

```bash
cd -    # leave the worktree
git worktree remove ~/.dispatch-worktrees/<task_id>
git worktree prune
```

Do this even if the review failed, was cancelled, or something went sideways. Orphaned worktrees accumulate.

## Notes

- You never commit or push anything during a review. Read-only.
- The worktree is at a detached HEAD on purpose — don't try to create a branch in it.
- If you want to try a fix yourself, that's a **separate work task** — don't blur the two.
- After you `complete_task`, the requester doesn't need an explicit ping — the next time they pull `my_tasks` (or refresh the dashboard) they'll see a "finished since your last check" section showing your verdict and the review prose. Write the `result` text as if they're reading it cold.
