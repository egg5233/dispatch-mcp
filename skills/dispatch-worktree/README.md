# dispatch-worktree

This folder is a self-contained **Claude Code skill bundle** for
[dispatch-mcp](https://github.com/YOUR_ORG/dispatch-mcp) — a shared task
server that lets teammates' Claude Code sessions dispatch code reviews,
bug fixes, and discussions to each other.

If you're reading this file, a teammate probably handed you the folder.
This README walks through setting it up in your project.

> **Audience note:** this README is for humans. `SKILL.md`, `review.md`,
> `work.md`, `dispatching.md`, `setup-watcher.md`, and `troubleshooting.md`
> are for Claude Code to read on demand — you don't need to.

---

## What you need from the server admin

Ask whoever runs the dispatch-mcp server for:

1. **Server URL** — e.g. `http://<server-host>:7900`
2. **Bearer token** — your personal token, something like `alice-1234-...`
3. **(Optional) Dashboard password** — only if you want to use the web UI

Both credentials are per-user. Don't share your bearer token.

---

## Install into a project (5 minutes)

The skill is **project-local only** — it lives under `<project>/.claude/`
rather than `~/.claude/`, so it doesn't load into every Claude Code
session on your machine.

### 1. Drop the folder into your project

Put this entire `dispatch-worktree/` directory under your project's
`.claude/skills/`:

```
<your-project>/
├── .claude/
│   └── skills/
│       └── dispatch-worktree/   ← this folder
└── ... (the rest of your project)
```

You can get the folder however you want: `git clone`, `scp`, a zip,
copying from a shared drive. Only this one folder is needed — you do
**not** need the full dispatch-mcp repo.

### 2. Run the installer

**macOS / Linux / WSL / Git Bash:**

```bash
cd <your-project>
.claude/skills/dispatch-worktree/scripts/install-client.sh
```

**Windows (PowerShell):**

```powershell
cd <your-project>
.\.claude\skills\dispatch-worktree\scripts\install-client.ps1
```

The installer detects that the skill is already in place and only does
two lightweight things:

- Marks the scripts as executable
- Copies `commands/dispatch-next.md` → `.claude/commands/dispatch-next.md`
  so Claude Code recognizes the `/dispatch-next` slash command

If PowerShell refuses with an execution-policy error, run it once with
`powershell -ExecutionPolicy Bypass -File install-client.ps1` or
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in the
current session.

> **Alternative:** if you have a full dispatch-mcp checkout elsewhere,
> you can run its copy of `install-client.sh` / `.ps1` with your project
> root as an argument and it'll do the full copy for you:
>
> ```bash
> ~/dispatch-mcp/skills/dispatch-worktree/scripts/install-client.sh /path/to/your/project
> ```

### 3. Configure the MCP server in `.claude/claude.json`

Create or edit `<your-project>/.claude/claude.json`:

```json
{
  "mcpServers": {
    "dispatch": {
      "type": "sse",
      "url": "http://YOUR_SERVER:7900/sse",
      "headers": {
        "Authorization": "Bearer <your-bearer-token>"
      }
    }
  }
}
```

Then **restart Claude Code** in this project — MCP servers are only
read at startup.

> **Security note:** your bearer token is now sitting in plaintext in
> `.claude/claude.json`. Make sure that file is in your `.gitignore`
> (it usually is by default for `.claude/`). Run
> `git check-ignore -v .claude/claude.json` to verify.

### 4. Verify the connection

In Claude Code, ask:

```
whoami via dispatch
```

or call the `whoami` MCP tool directly. It should return your handle.
If you see `HTTP 401` or "unknown session," re-check the token and the
URL.

---

## Using it

Once installed, Claude Code knows how to:

- **Check for work assigned to you**: just ask "check my dispatch tasks"
  or call `my_tasks`.
- **Execute a task**: the skill triggers on `claim_task`, `my_tasks`,
  `/dispatch-next`, or phrases like "review my branch" / "do this for
  david." It walks through the git-worktree protocol automatically.
- **Dispatch work to a teammate**: say "ask david to fix the auth bug"
  or call `request_work`, `request_review`, `start_discussion`.
- **Manually pull the next task**: type `/dispatch-next`. This is what
  the optional watcher (see below) invokes automatically when a new
  task event arrives.

All details for each task kind live in the other `.md` files in this
folder — Claude reads them on demand.

---

## Optional: auto-execution watcher

By default you have to ask "any dispatch tasks?" for Claude to pick up
work. If you want tasks to auto-run as soon as a teammate dispatches
them, there's a tiny Node daemon (`scripts/dispatch-watch.js`) that:

1. Subscribes to the server's SSE `/events` stream
2. When a task arrives, uses `tmux send-keys` to inject `/dispatch-next`
   into your live Claude Code pane

It costs zero tokens while idle and uses your existing Claude Code
session — no Anthropic API key needed.

**Requirements:** tmux (native Linux/macOS/WSL/Git Bash — no support on
native Windows without WSL).

**Setup:** in Claude Code, just ask:

```
set up the dispatch watcher
```

The skill will load `setup-watcher.md` and walk you through the whole
thing (finding `TMUX_TARGET`, launching the daemon, optional systemd
user unit for survive-reboot). Or read `setup-watcher.md` yourself —
it's all in there.

---

## Folder contents

| File | Audience | Purpose |
|---|---|---|
| `README.md` | human | this file |
| `SKILL.md` | Claude | entry point + triggers + golden rules |
| `review.md` | Claude | protocol for reviewing a teammate's code |
| `work.md` | Claude | protocol for producing code for a teammate |
| `dispatching.md` | Claude | protocol for dispatching tasks to someone else |
| `setup-watcher.md` | Claude | walks through watcher setup on demand |
| `troubleshooting.md` | Claude | orphaned worktrees, push rejections, etc. |
| `commands/dispatch-next.md` | Claude Code | the `/dispatch-next` slash command |
| `scripts/install-client.sh` | you (bash) | project-local installer |
| `scripts/install-client.ps1` | you (PowerShell) | Windows installer |
| `scripts/dispatch-watch.js` | you (Node) | optional SSE→tmux watcher daemon |
| `scripts/prune-worktrees.sh` | you (bash) | emergency cleanup for orphaned worktrees |
| `scripts/package.json` | Node | declares ES module type for the watcher |

---

## If something goes wrong

- **`/dispatch-next` → "Unknown skill: dispatch-next"** — the installer
  didn't relay the slash command. Re-run `install-client.sh` (or `.ps1`)
  from the project root, then `/reload-plugins` in Claude Code.
- **`Cannot use import statement outside a module`** when running the
  watcher — the `scripts/package.json` (with `{"type": "module"}`) is
  missing. Make sure the whole `scripts/` folder got copied, not just
  the `.js` file.
- **Watcher connects but never fires** — the event is probably coming
  from yourself (actor filter) or is an FYI event type. The watcher's
  stdout will tell you. Only `task_created`, `task_commented`, and
  `task_cancelled` trigger injection.
- **`tmux send-keys failed: no server running`** — start a tmux session
  first and put Claude Code inside it, then update `TMUX_TARGET` to
  match `tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'`.
- **Any other weirdness with claiming, pushing, or orphaned worktrees** —
  ask Claude "something broke with dispatch-mcp, check troubleshooting"
  and it'll load `troubleshooting.md`.
