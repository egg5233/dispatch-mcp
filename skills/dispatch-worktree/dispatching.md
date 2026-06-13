# Dispatching tasks (requester side)

You're asking someone else to review your code or produce work for you.

**Hard prerequisite for code tasks: your code must be on origin before you dispatch.** The server verifies every commit against its bare clone of the repo — there's no way to request a review on code that exists only locally.

## Requesting a review

1. Make sure your changes are committed and pushed to origin.
2. Capture the commit and branch:

   ```bash
   HEAD_COMMIT=$(git rev-parse HEAD)
   HEAD_BRANCH=$(git symbolic-ref --short HEAD)
   ```

3. Call:

   ```
   request_review({
     repo: "<registered repo name>",
     head_branch: HEAD_BRANCH,
     head_commit: HEAD_COMMIT,
     title: "<short summary>",
     description: "<what you want reviewed, what to focus on>",
     to_user: "<reviewer handle>",   // optional
     files: ["src/auth.ts", ...],     // optional focus hint
     base_branch: "main",             // optional, enables diff display
     base_commit: "<commit>"          // optional, enables diff display
   })
   ```

If you don't know the registered repo name, ask the user or check the dashboard's repos list.

**Include `base_commit` when you can.** It lets the reviewer (and the dashboard) show an actual diff instead of reviewing the whole commit in isolation.

## Requesting work

1. Decide the starting point. Usually `origin/main`:

   ```bash
   git fetch origin
   BASE_COMMIT=$(git rev-parse origin/main)
   ```

2. Call:

   ```
   request_work({
     repo: "<registered repo name>",
     base_branch: "main",
     base_commit: BASE_COMMIT,
     title: "<short summary>",
     description: "<detailed spec and acceptance criteria>",
     to_user: "<assignee handle>",     // optional
     head_branch: "feature/xyz"        // optional — suggested branch name
   })
   ```

The `description` should be actually useful — acceptance criteria, constraints, anything non-obvious. The assignee will be working from this alone.

If you omit `head_branch`, the assignee's worktree defaults to `dispatch/<task_id>`.

## Starting a discussion

No git, no base. Just:

```
start_discussion({
  title: "<question or topic>",
  description: "<context, what you want to talk about>",
  to_user: "<handle>"   // optional
})
```

## Dirty-WIP handling

If the user wants a review but has uncommitted changes, **do not silently lose them** by using `HEAD` as-is. Two clean options:

### Option A — commit and push explicitly

```bash
git add -A
git commit -m "wip: <task title>"
git push -u origin <current-branch>
```

Then dispatch using the new commit. Note the WIP-ness in the description so the reviewer knows it's not polished.

### Option B — scratch branch

```bash
git stash
git checkout -b wip/<topic>
git stash pop
git add -A && git commit -m "wip"
git push -u origin wip/<topic>
```

Use the scratch branch's commit in the request. Clean up the scratch branch after the review closes.

**Never dispatch a review against `HEAD` if `git status` shows uncommitted changes.** The reviewer will see stale code and you'll both be confused.

## Finding the registered repo name

The dispatch-mcp server only accepts commits for repos that have been registered server-side (`node src/admin.js add-repo`). If `request_review` / `request_work` rejects you with "repo X is not registered":

- Ask the user for the registered name.
- Or check the dashboard — the repos list is visible there.
- Or ask the admin to run `node src/admin.js add-repo <name> <url>` for this repo.

Don't silently fall back to `start_discussion` as a workaround — that loses all the git verification value.
