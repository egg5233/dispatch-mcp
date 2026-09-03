---
title: "Onboard a new project onto dispatch"
type: runbook
task: T-20260903-19
agent: docs-migrate
date: 2026-09-03
git:
status: active
supersedes:
---
# Onboard a new project onto dispatch

One host, one operator, several projects, one dispatch server. Each project gets its own coordinator session, its own agents, its own `coordination/` directory and its own tmux session; the server, CLI, hooks and dashboard are shared. This runbook takes a project from "a directory on disk" to "coordinator and agents exchanging tasks", and back out again.

Vocabulary (spec: `coordination/docs/designs/dispatch-multiproject-spec-20260903.md` in Pearl's coordination):

| thing | rule |
|---|---|
| project name | lowercase, `[a-z0-9-]`, unique on the server; also the tmux session name |
| coordinator handle | `coord-<project>` (Pearl keeps the literal `coord`) |
| agent handles | `<project>-<role>`, globally unique across all projects |
| `coord` | every agent addresses its own coordinator as `coord`; the server resolves it by the sender's project |
| coordination dir | `<workspace>/coordination`, created from `templates/coordination/` |
| task mirror | `<workspace>/coordination/tasks/T-YYYYMMDD-NN-<slug>.md`, written by the server |

> **Version note.** Steps that call `dispatch-fleet project …` and `dispatch-fleet add … --project` need the multi-project CLI (dispatch-mcp Task A of the spec above). If `~/.dispatch/dispatch-fleet project list` prints a usage error, pull the repo and run `deploy/install-cli.sh` first. The exact flag names are those printed by `dispatch-fleet --help`; when this file and `--help` disagree, `--help` wins and this file gets fixed.

## 0. Prerequisites (once per host)

Check, do not assume:

```bash
pm2 describe dispatch | grep -E 'status|script path'      # server online, :7900
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7900/login   # 200
~/.dispatch/dispatch-fleet check                          # existing fleet: "0 problem(s)"
deploy/install-cli.sh --check                             # from the dispatch-mcp checkout: "~/.dispatch is up to date"
python3 - <<'PY'
import json; h=json.load(open('/home/solana/.claude/settings.json'))['hooks']
print('dispatch hooks:', all(any('dispatch/hook.sh' in x.get('command','') for g in h.get(ev,[]) for x in g['hooks']) for ev in ('SessionStart','Stop','PreToolUse')))
PY
which tmux claude git
```

What each line proves: the server is up; the CLI in `~/.dispatch` matches the repo (the hooks and CLI run from `~/.dispatch`, not from the checkout); the global Claude Code hooks that deliver messages are installed (`deploy/enable-hooks.py` if not); the runtimes exist. The `~/.claude/CLAUDE.md` standing rule ("report to `coord` on idle") is global and needs no change per project.

The dashboard login `user` is one global identity; nothing per project.

## 1. Initialize the project

```bash
~/.dispatch/dispatch-init-project <name> --workspace <dir> [--coordinator coord-<name>]
```

What it does, in order (each step is skipped if already done, so the command is safe to re-run):

1. Validates the name and that `<dir>` exists.
2. Copies `templates/coordination/` to `<dir>/coordination`, substituting `{{PROJECT}}`, `{{WORKSPACE}}`, `{{COORDINATOR}}`, `{{DATE}}` in the copied files. Existing files are never overwritten.
3. `git init` in `<dir>/coordination` (if not a repo) and a first commit.
4. `dispatch-fleet project add <name> --dir <dir>/coordination --session <name> --coordinator <handle>` — registers the project so task mirrors land in this directory and `coord` resolves to this coordinator.
5. Creates the tmux session `<name>` if it does not exist (`tmux new-session -d -s <name> -c <dir>`).
6. `dispatch-fleet add <handle> --project <name> --cwd <dir>/coordination --runtime claude --session <name> --window coord` — opens a window in the project session, launches Claude in the coordination dir, mints the token, registers pane + token in `fleet.json`, starts the watcher, waits for the `❯` prompt (the trust dialog is answered by the tool).

`--dry-run` prints the plan without doing anything. `--no-launch` stops after step 4 (use it when the coordinator will run somewhere unusual).

Manual equivalent (only if the script is unavailable): the six steps above, in that order, with the same commands.

After it returns:

```bash
~/.dispatch/dispatch-fleet project list          # shows <name>, dir, session, coordinator
~/.dispatch/dispatch-fleet check                 # new coordinator row: pane_cmd=claude, watcher online, project=<name>
tmux attach -t <name>                            # the coordinator is on window "coord", ❯ prompt
```

Then tell the coordinator what the project is: the first message in its window should be the project brief (what the code is, who the agents are, what the user wants first). `CLAUDE.md` in the coordination dir already carries the coordinator role and the dispatch commands.

## 2. Add agents

For each agent the project needs:

```bash
~/.dispatch/dispatch-fleet add <name>-<role> --project <name> --cwd <repo-or-worktree> \
    --runtime claude|codex [--session <name>] [--window <role>]
```

This creates the window, launches the runtime in `--cwd`, registers the pane and token, starts the `watch-<handle>` pm2 watcher, and for Claude waits until the prompt is ready. Handles are global: `<name>-<role>` avoids collisions with other projects' agents.

**Registering a pane that already exists** (an agent the user started by hand):

1. Look before typing: `tmux display -p -t %N '#{session_name}:#{window_index} #{pane_current_command} #{pane_current_path}'`. The foreground command must be the runtime (`claude`, or `node` for Codex). If it is a shell (`bash`), the pane is idle at a prompt: check nobody is typing there (`#{session_activity}` older than a minute), then start the runtime the way the rest of the fleet runs it, from the directory the agent should work in:

   ```bash
   tmux send-keys -t %N 'cd <repo> && claude --dangerously-skip-permissions' Enter
   ```

   Wait for the `❯` prompt (a first launch in a new directory shows the trust dialog; answer it). The guards refuse to type into a shell pane on purpose, and `check` reports `pane_cmd=bash` until the runtime is up.
2. Register the pane instead of creating a window: the `add` form that takes an existing pane (`--pane %N`; see `dispatch-fleet --help`).
3. `dispatch-fleet check` must show the handle with `match=yes` and its watcher `online`.

Each agent's own `CLAUDE.md` (in its repo, not in coordination/) needs only: the project name, the path of the coordination dir, and "read `~/.dispatch/PROTOCOL.md`". The report-to-coord rule is global. If the repo is not yours to commit to, put those lines in `CLAUDE.local.md` next to it (Claude Code reads it, git ignores it).

Codex agents: no `Stop` hook and no async rewake exist in Codex, so their idle wake is the guarded keystroke watcher only (README, "Codex sessions"). Everything else is the same.

## 3. Verify

Three checks, in this order; stop at the first that fails and go to §6.

**a. Fleet check across all projects**

```bash
~/.dispatch/dispatch-fleet check
```

Expect: every handle of the new project listed with its project, `pane_cmd` matching the runtime, watcher `online`, `0 problem(s)`; the other projects' rows unchanged.

**b. One end-to-end task**

From the new coordinator's window (or with its token via `DISPATCH_TOKEN`):

```bash
~/.dispatch/dispatch-send <name>-<role> --type task --priority high --ack auto \
    --title "onboarding smoke test" "Reply with an ack, then a report with --state done. No other work."
```

Expect, within about a minute:

1. `dispatch-send` prints `task T-YYYYMMDD-NN (ack required)`.
2. The agent's session wakes (hook digest at its next turn boundary, or the watcher keystroke for Codex), sends `--type ack --re <msg id>`, then `--type report --state done --re <msg id>`.
3. `~/.dispatch/dispatch-recv` in the coordinator's window shows both.
4. `ls <dir>/coordination/tasks/` shows `T-YYYYMMDD-NN-onboarding-smoke-test.md`, and the file contains the task, the ack and the report.
5. `dispatch-fleet check` shows the task closed (`open_` column back to 0 for the agent).

**c. Dashboard**

Open `http://<server>:7900/` (login `user`). The project switcher lists the new project; selecting it scopes the inbox cards, task board, threads and fleet to that project's handles; the smoke-test task is on the board as closed. Switch back to the previous project: its view is unchanged.

Record the evidence (the task id, the mirror path, a dashboard screenshot or the fleet check output) in the new project's `STATUS.md` as its first real entry.

## 4. Remote hosts (i5-style)

An agent on another machine can be part of a project without a local pane:

1. On the server host: `node src/admin.js add <name>-<role>` (in the dispatch-mcp checkout) mints the bearer token. The handle is a server user; it is **not** added to the local `fleet.json`, so `dispatch-fleet check` does not audit it and no local watcher is started.
2. On the remote host: install the CLI (`deploy/install-cli.sh` with `DISPATCH_HOME=~/.dispatch` from a checkout, or copy `cli/*`), write the token into its `~/.dispatch/fleet.json` handle entry, and point `~/.dispatch/url` at a port that reaches the server: an SSH tunnel kept alive from either side (`ssh -N -L 7900:127.0.0.1:7900 <server>` on the remote, or `ssh -N -R 7900:127.0.0.1:7900 <remote>` from the server; autossh or a systemd unit to keep it up). The server then sees the agent from `127.0.0.1`.
3. If the remote runs Claude Code, install the hooks there too (`deploy/enable-hooks.py`) so it gets the same digest/block/wake behaviour; without hooks it must poll `dispatch-recv` itself.
4. It shows up in the dashboard's **remote** section (handles on the server that are not in the local fleet), with last-seen time and IP, and in the project it was added to.

The worked example on this host is Pearl's i5 agent: `pearl_workspace/coordination/docs/runbooks/pearl-i5-agent-setup.md` (ControlMaster socket, mirror rsync, fallback outbox).

## 5. Offboard a project

Order matters: agents first, project last, the directory never.

```bash
~/.dispatch/dispatch-fleet remove <name>-<role> --watcher      # each agent: fleet.json + registry + pm2 watcher; server user and history stay
~/.dispatch/dispatch-fleet remove coord-<name> --watcher        # the coordinator
~/.dispatch/dispatch-fleet project remove <name>               # unregister; task mirrors already written stay on disk
tmux kill-session -t <name>                                    # optional; the user decides
~/.dispatch/dispatch-fleet check                               # 0 problems, no rows for <name>
```

`<dir>/coordination` and its git history are left in place. Messages and tasks stay in the server database (the dashboard still shows the project's history under its name). To retire the handles' server users as well: `node src/admin.js remove <handle>` — only when the history is no longer needed.

## 6. Troubleshooting

| symptom | cause | fix |
|---|---|---|
| `dispatch-fleet project add` → usage error | CLI predates multi-project support | pull dispatch-mcp, `deploy/install-cli.sh`, retry |
| `check` shows `pane_cmd=bash`, `match=no` | the runtime is not in the foreground of that pane (session ended, or never started) | start `claude` / `codex` in the pane; the guards refuse to type into a shell on purpose |
| `check` shows watcher `stopped` / missing | pm2 process not started or crashed | `dispatch-fleet watchers --only <handle> --restart`; `pm2 logs watch-<handle>` |
| coordinator launched but stuck on the trust dialog | `dispatch-fleet add` did not get the prompt in time | attach, answer the dialog, run `dispatch-fleet sync --write` so the session name is recorded |
| agent never wakes on a `high` task | hooks not installed in that Claude session, or the message went to a handle in another project | `python3` prerequisite check above; `dispatch-recv --peek` as the agent; confirm the handle's project |
| `coord` from the agent reaches Pearl's coordinator | the agent's handle has no project (or the wrong one) in `fleet.json` | `dispatch-fleet add … --project <name>` again, or edit the project field and `dispatch-fleet sync --write` |
| mirror file does not appear in `<dir>/coordination/tasks/` | project registered with the wrong dir, or dir not writable by the server user | `dispatch-fleet project list`; fix with `project add` (idempotent) |
| handle already exists (another project) | handles are global | pick `<name>-<role>`; never reuse a retired name without `dispatch-fleet remove` first |
| `install-cli.sh --check` reports STALE after a pull | `~/.dispatch` was not refreshed | run `deploy/install-cli.sh` (no `--check`) |
| server down: agents keep working, nothing delivered | hooks fail silent by design (2 s budget) | `pm2 restart dispatch`; unread messages are still on the server after restart |
| `dispatch-init-project` re-run complains about an existing file | template copy never overwrites | that is the intended behaviour; delete the file if you want the template version |

## Checklist (copy into the onboarding task)

- [ ] §0 all four checks green
- [ ] §1 `dispatch-init-project` ran; `project list` shows the project; coordinator at `❯`
- [ ] §2 agents added (or existing panes registered); each `pane_cmd` matches its runtime
- [ ] §3a `dispatch-fleet check` 0 problems across all projects
- [ ] §3b smoke-test task: ack + done report received, mirror file present, task closed
- [ ] §3c dashboard shows the project; other projects unchanged
- [ ] evidence written to the new project's `STATUS.md`
- [ ] every gap hit on the way fixed in this runbook before reporting done
