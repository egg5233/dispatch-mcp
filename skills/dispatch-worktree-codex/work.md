# Work task protocol

You've been assigned or have claimed a `work` task. The requester pinned a `base_commit` and wants you to produce code starting from it.

## 1. Claim

```
claim_task({id: "<task_id>"})
```

The response includes `worktree.setup`, `worktree.push`, and `worktree.cleanup` arrays. The `head_branch` may already be set on the task (requester's suggestion); if not, default to `dispatch/<task_id>`.

## 2. Set up the worktree

Run the `setup` array verbatim:

```bash
# From inside the user's local checkout of the repo
git fetch origin
git worktree add -b <head_branch> ~/.dispatch-worktrees/<task_id> <base_commit>
cd ~/.dispatch-worktrees/<task_id>
```

You're now on a fresh branch based off the pinned commit, isolated from the user's main checkout.

## 3. Do the work

- Edit files **inside the worktree directory only**.
- Commit as you go — small, logical commits are better than one giant one.
- Run tests before pushing.
- Do not `cd` out to the main repo to edit anything related to this task.

If the user wants to look at something in their main checkout, tell them to open a second terminal. Your worktree stays intact.

## 4. Push

When your work is ready:

```bash
git push -u origin <head_branch>
```

Then record the push with dispatch-mcp — this is a **required** step before completing a work task:

```
push_work({
  id: "<task_id>",
  head_branch: "<head_branch>",
  head_commit: "<output of: git rev-parse HEAD>"
})
```

The server verifies that commit exists on origin before accepting. If it rejects you with "commit was not found":
- Your `git push` didn't actually succeed. Read the push output, fix the underlying issue (auth, non-fast-forward, etc.), push again, then retry `push_work`.
- **Never fudge the commit SHA to make the call succeed.** The server is right; origin doesn't have it.

## 5. Complete

```
complete_task({
  id: "<task_id>",
  result: "<summary of what you did, key decisions, any caveats, PR link if you opened one>"
})
```

## 6. Cleanup

```bash
cd -
git worktree remove ~/.dispatch-worktrees/<task_id>
git worktree prune
```

The branch stays on origin. The requester can pull it, review it, or merge it through their normal workflow.

## Notes

- The `pushed` state exists between `in_progress` and `closed`. It means "head commit recorded, work not yet formally complete" — useful for WIP pushes or when you want a review pass before finalizing.
- You can `push_work` multiple times if you add more commits after the first push — it just updates the recorded head.
- Never merge the branch yourself unless the task explicitly asks for that. Merging is the requester's call.
- After you `complete_task`, the requester doesn't need an explicit ping — the next time they pull `my_tasks` (or refresh the dashboard) they'll see a "finished since your last check" section with your summary. Your `result` text is what they'll read there, so write it clearly.
