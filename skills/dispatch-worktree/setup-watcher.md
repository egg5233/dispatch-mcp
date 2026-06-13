# Setting up the dispatch-watch daemon

This is the **one-time setup** for auto-execution: a small Node daemon that listens to the dispatch-mcp `/events` SSE stream and, when a task arrives, injects `/dispatch-next` into your live Claude Code session via `tmux send-keys`. With it running, you never have to ask "any dispatch tasks?" — the session wakes itself up.

Skip this entirely if you're happy triggering tasks manually with `/dispatch-next`. The rest of the skill works without the watcher.

> **Windows note:** native Windows has no `tmux`, so the watcher can't deliver keystrokes to a PowerShell-hosted Claude Code session. Use it from **WSL** or **Git Bash + tmux** — run Claude Code inside a tmux pane in WSL/Git Bash and launch the watcher from that same environment. If you're on native Windows without tmux, skip the watcher and trigger tasks manually with `/dispatch-next`.

## Prerequisites

- The skill folder is under `<project-root>/.claude/skills/dispatch-worktree/` (project-local install). This is usually the case if you're reading this file.
- Your Claude Code session is running **inside tmux**. The watcher talks to tmux, not to Claude Code directly.
- You have the **bearer token** for your dispatch-mcp user (the same one that goes into `.mcp.json` / `.claude/claude.json`).
- `node` is on `$PATH`. Any Node 14+ works — the watcher is pure stdlib (no dependencies, no native modules).

## Step 0 — Pre-flight status check (do this FIRST)

Before launching anything, run this one-shot status dump to see what's already in place. It replaces half a dozen exploratory commands:

```bash
cd <your-project-root>
bash -c '
  echo "=== skill ===";         ls .claude/skills/dispatch-worktree/scripts/dispatch-watch.js 2>&1
  echo "=== scripts/package.json ===";  cat .claude/skills/dispatch-worktree/scripts/package.json 2>&1
  echo "=== slash command ===";  ls .claude/commands/dispatch-next.md 2>&1
  echo "=== tmux ===";           echo "TMUX=$TMUX"; tmux display-message -p "#{session_name}:#{window_index}.#{pane_index}" 2>&1
  echo "=== node ===";           node --version 2>&1; which node
  echo "=== mcp config ===";     ls .mcp.json .claude/claude.json 2>/dev/null || echo "(neither present)"
  echo "=== systemd unit ===";   ls ~/.config/systemd/user/dispatch-watch.service 2>&1
  echo "=== watcher status ==="; systemctl --user is-active dispatch-watch 2>&1
'
```

Interpret the output:

| Check | Green | Red |
|---|---|---|
| `skill` | lists the file | missing → user hasn't copied the skill in. Stop, point at README.md. |
| `scripts/package.json` | shows `{"type": "module", ...}` | missing or wrong → old skill version, see Step 1. |
| `slash command` | lists the file | missing → **run Step 1** (install-client.sh) — without this `/dispatch-next` won't work. |
| `tmux` | non-empty TMUX + a target like `work:0.0` | `TMUX=` and "no server" → Claude Code isn't in tmux; ask the user to restart inside tmux. |
| `node` | v14+ | missing → `apt/brew install nodejs` or use nvm. |
| `mcp config` | `.mcp.json` or `.claude/claude.json` exists and references dispatch | nothing → ask the user for DISPATCH_URL and DISPATCH_TOKEN. |
| `systemd unit` | file listed | missing → Step 3 will create it. |
| `watcher status` | `active` | `inactive`/`failed`/`unknown` → check logs and proceed. |

## Step 1 — Run `install-client.sh` (idempotent, always safe)

**Always run this first, even if the skill looks installed.** It's the authoritative way to make sure:

- `.claude/commands/dispatch-next.md` is relayed from the skill (otherwise `/dispatch-next` reports "Unknown skill: dispatch-next")
- `scripts/*.sh` are executable
- The in-place scenario is handled (the script detects when source == target and skips the destructive copy, so it's safe to run from inside the already-installed skill)

```bash
cd <your-project-root>
.claude/skills/dispatch-worktree/scripts/install-client.sh
# Windows: .\.claude\skills\dispatch-worktree\scripts\install-client.ps1
```

You should see either `replacing existing ...` (full copy) or `skill already in place ... skipping copy — just finalizing slash command + permissions` (idempotent path). Both are success.

If `/dispatch-next` was already tried and returned "Unknown skill: dispatch-next", now run `/reload-plugins` in Claude Code — it re-scans `.claude/commands/` and will pick up the new slash command.

## Step 2 — Find your tmux target

In the tmux pane where Claude Code is running, run:

```bash
tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
```

This prints something like `work:0.0`. That's the address the watcher will send keystrokes to. If Claude Code is not running in tmux yet, start a tmux session first (`tmux new -s work`) and run Claude Code inside it.

## Step 3 — Launch the watcher in a separate terminal

Open a **different** terminal window (not the one running Claude Code) and run:

```bash
cd <your-project-root>
export DISPATCH_URL=http://YOUR_SERVER:7900/events
export DISPATCH_TOKEN='<your bearer token>'
export TMUX_TARGET='work:0.0'       # whatever step 1 printed
node .claude/skills/dispatch-worktree/scripts/dispatch-watch.js
```

(If you run multiple projects with dispatch-mcp, each has its own copy of the watcher. Pick whichever one you're actively using — they all talk to the same server.)

You should see:

```
dispatch-watch
  events URL:   http://YOUR_SERVER:7900/events
  tmux target:  work:0.0
  prompt:       /dispatch-next
  min interval: 2000ms
  reconnect:    5000ms
  dry run:      false

[YYYY-MM-DD hh:mm:ss] connected to http://YOUR_SERVER:7900/events
```

Leave this terminal running. The watcher is idle most of the time and costs nothing.

## Step 4 — Verify end-to-end

Ask a teammate (or another terminal authenticated as a different user) to dispatch a small task to you — a `start_discussion` is the cheapest option because it needs no git setup.

Within a couple of seconds you should see:

- In the **watcher terminal**: `fired "/dispatch-next" → work:0.0  (task_created #N from <them>)`
- In the **Claude Code pane**: the text `/dispatch-next` appears, Enter is pressed for you, and Claude starts running the task via this skill.

If the watcher prints a `fyi:` line instead of `fired`, the event type isn't in its actionable set (only `task_created`, `task_commented`, `task_cancelled` trigger execution). That's correct — `task_pushed` and friends are informational.

## Running it in the background

Once you trust it, put the watcher under a process supervisor so it survives reboots. A minimal systemd user unit:

```ini
# ~/.config/systemd/user/dispatch-watch.service
[Unit]
Description=dispatch-mcp watcher
After=network-online.target

[Service]
WorkingDirectory=/absolute/path/to/your/project
Environment=DISPATCH_URL=http://YOUR_SERVER:7900/events
Environment=DISPATCH_TOKEN=your-bearer-token
Environment=TMUX_TARGET=work:0.0
ExecStart=/usr/bin/node /absolute/path/to/your/project/.claude/skills/dispatch-worktree/scripts/dispatch-watch.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Fill in the absolute path to the project you want the watcher bound to. Because the skill is project-local, the watcher is also project-local — point the unit at whichever project you want `/dispatch-next` delivered into.

**Find your `node` binary with `which node` and use that absolute path in `ExecStart=`** — nvm-installed nodes live somewhere like `/home/you/.nvm/versions/node/v20.18.0/bin/node`, not `/usr/bin/node`, and systemd does not inherit your shell's `PATH`. The unit will fail silently if the binary doesn't exist at the hard-coded path.

Enable it with:

```bash
systemctl --user daemon-reload
systemctl --user enable --now dispatch-watch
systemctl --user status dispatch-watch --no-pager      # should say "active (running)"
journalctl --user -u dispatch-watch -f                  # follow the log
```

A few operational things nobody tells you until you hit them:

### Tighten the unit file — it contains your bearer token

```bash
chmod 600 ~/.config/systemd/user/dispatch-watch.service
```

systemd creates it `644` by default, which means any local user on the box can read your token. `600` makes it owner-only.

### Enable linger so the watcher survives logout

By default, systemd user services stop when you fully log out. If you SSH in, run tmux + the watcher, then log out, the watcher dies with your session. To keep it running forever:

```bash
sudo loginctl enable-linger "$USER"
```

Check with `loginctl show-user "$USER" | grep Linger`. You only need this once per user per machine.

### Rebind when tmux moves

**`TMUX_TARGET` must exist when the watcher fires.** If you kill your tmux session, reboot, or attach Claude Code to a different pane, the old target is dead and the watcher's `tmux send-keys` calls will fail silently forever. To rebind:

```bash
# Inside the new Claude Code pane:
tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
# Edit the unit file with the new target:
nano ~/.config/systemd/user/dispatch-watch.service
# Apply:
systemctl --user daemon-reload
systemctl --user restart dispatch-watch
```

If you want the watcher to always target the same tmux session regardless of what else happens, create a long-lived detached session at boot: `tmux new -d -s dispatch` and use `dispatch:0.0` as `TMUX_TARGET`. Then keep Claude Code running inside that session.

### The ES-module / `package.json` detail

`dispatch-watch.js` uses ES module syntax (`import http from "http"`). When run from a random cwd (as systemd does), Node walks up from the script looking for a `package.json` with `"type": "module"` — and falls back to CommonJS if it doesn't find one, which then fails with `SyntaxError: Cannot use import statement outside a module`.

The skill ships `scripts/package.json` with `{"type": "module"}` precisely to fix this — if you see that SyntaxError, verify the file still exists next to `dispatch-watch.js`:

```bash
ls -la ~/your-project/.claude/skills/dispatch-worktree/scripts/package.json
```

## Tuning

The watcher reads these optional env vars:

| Var | Default | Use |
|---|---|---|
| `DISPATCH_PROMPT` | `/dispatch-next` | What to inject. Change if you renamed the slash command. |
| `DISPATCH_MIN_INTERVAL` | `2000` | Minimum ms between injections. Raise to suppress bursts harder. |
| `DISPATCH_RECONNECT_MS` | `5000` | Backoff on disconnect. |
| `DISPATCH_DRY_RUN` | unset | Set to `1` to print-only instead of touching tmux. Good for debugging. |

## Common problems

- **`HTTP 401`** — token wrong, or not registered. Verify with `node src/admin.js list` on the server.
- **`tmux send-keys failed: no server running`** — no tmux session exists. Start one and update `TMUX_TARGET`.
- **Watcher connects but nothing fires** — check that events really have you as a recipient. Tasks with `to_user: someone_else` won't hit your stream (the server filters per-user), and the watcher also suppresses events you triggered yourself.
- **Bursts spamming your pane** — raise `DISPATCH_MIN_INTERVAL`. The default 2s is usually enough.
- **`/dispatch-next` is typed but Claude responds with "Unknown skill: dispatch-next"** — the slash command file is missing from `<project>/.claude/commands/dispatch-next.md`. This happens when the skill folder was copied in but `install-client.sh` was never run (or failed to run). Fix:
  ```bash
  cd <your-project>
  .claude/skills/dispatch-worktree/scripts/install-client.sh
  ```
  Then `/reload-plugins` in Claude Code. The installer is safe to run in-place — it detects that the skill is already installed and only relays the slash command.
- **`SyntaxError: Cannot use import statement outside a module`** in the watcher logs — `scripts/package.json` is missing or got stripped. Make sure it sits next to `dispatch-watch.js` with `{"type": "module"}`.
- **systemd unit shows "activating (auto-restart)" in a loop** — `journalctl --user -u dispatch-watch -n 30` will show the real error. Most common causes: wrong `ExecStart` node path (see "Find your node binary" above), missing `scripts/package.json`, or a bad `TMUX_TARGET`.

## When to turn it off

Kill the watcher (`Ctrl-C` or `systemctl --user stop dispatch-watch`) if you want dispatch-mcp to go back to being strictly pull-only. Nothing on the server side changes — tasks keep queueing, you'll just have to ask Claude to check them manually.
