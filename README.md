# dispatch-mcp

A shared MCP server for dispatching work between Claude Code instances. Built for small teams (2-3 people) who work on the same repo and want their AI coding agents to coordinate.

## What It Does

- **Task dispatch** — Send code reviews, bug fixes, feature requests to your teammate's Claude Code
- **Conflict detection** — Announces what files each person is editing, warns on overlap
- **Presence** — See who's online and what they're working on
- **Async by design** — Leave tasks for your teammate to pick up later
- **Web dashboard** — Visual task board at `http://your-server:7900/`

## Setup

### 1. Install on your shared server

```bash
git clone <this-repo> ~/dispatch-mcp
cd ~/dispatch-mcp
npm install
```

### 2. Run it

```bash
# Direct
node src/server.js

# Or with a specific port
PORT=7900 node src/server.js

# Background (with pm2, systemd, or tmux)
pm2 start src/server.js --name dispatch
```

### 3. Register each teammate

Every teammate needs **two** credentials, with separate purposes:

- A **bearer token** — used by their Claude Code instance to talk to the MCP endpoint
- A **dashboard password** — used by them in a browser to view the task board

Create the user (which mints the bearer token), then set their password:

```bash
node src/admin.js add alex                  # creates user, prints bearer token
node src/admin.js set-password alex         # prompts for the password (hidden input)
```

`set-password` reads the password from a TTY without echoing, and asks you to confirm it. You can also pipe it for automation:

```bash
echo 'correcthorsebattery' | node src/admin.js set-password alex
```

Other admin commands:

```bash
node src/admin.js list                     # show all users and last-seen info
node src/admin.js rotate alex              # issue alex a fresh bearer token
node src/admin.js clear-password alex      # disable dashboard login for alex (MCP still works)
node src/admin.js remove alex              # delete alex entirely
```

Passwords are bcrypt-hashed (cost 12). The admin CLI writes directly to `data/dispatch.db`, so it doesn't need the server to be running.

### 4. Connect from Claude Code

Each team member adds this to their project's `.claude/claude.json`, using **their own** token:

```json
{
  "mcpServers": {
    "dispatch": {
      "type": "sse",
      "url": "http://YOUR_SERVER_IP:7900/sse",
      "headers": {
        "Authorization": "Bearer alex-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      }
    }
  }
}
```

The server resolves the token to a handle at connection time and binds that identity to the session. Tool calls no longer take a `user` argument — identity comes from the token, not from what the agent types. Connections without a valid token are rejected with HTTP 401.

### 5. Add CLAUDE.md instructions

Copy the contents of `CLAUDE_SNIPPET.md` into your project's `CLAUDE.md` so Claude Code knows how to use the dispatch tools.

## MCP Tools

| Tool | Description |
|------|-------------|
| `dispatch_task` | Create a task for your teammate |
| `my_tasks` | Check tasks assigned to you |
| `claim_task` | Start working on a task |
| `complete_task` | Mark a task done with summary |
| `cancel_task` | Cancel a task |
| `comment_on_task` | Add a note to a task |
| `list_all_tasks` | See full task history |
| `get_task` | Get task details + comments |
| `announce_work` | Broadcast what files you're touching |
| `check_conflicts` | See if anyone else is on your files |
| `who_is_online` | See active team members |
| `whoami` | Confirm which handle this session is authenticated as |

## Dashboard

Open `http://YOUR_SERVER_IP:7900/` in a browser. The dashboard is gated by a JWT cookie:

1. First visit redirects you to `/login`.
2. Enter your **handle** and **dashboard password** (set by the admin via `node src/admin.js set-password <handle>`).
3. The server bcrypt-verifies your password against the `users` table, mints a 24h JWT, and sets it as an `HttpOnly` `SameSite=Lax` cookie. You're redirected to the task board.
4. Click "sign out" in the footer to clear the cookie.

Dashboard login is intentionally a different credential from the MCP bearer token. Losing the bearer token from `.claude/claude.json` doesn't grant dashboard access, and learning someone's dashboard password doesn't grant MCP access.

The JWT signing secret is read from `JWT_SECRET` if set, otherwise generated once on first boot and persisted in `data/dispatch.db` (so restarts don't invalidate sessions). If you put the server behind TLS, set `JWT_COOKIE_SECURE=1` to mark the cookie `Secure`.

The `/sse` and `/messages` MCP endpoints are unaffected — they keep using bearer-token auth, since Claude Code talks to them directly without cookies.

## Auto-execution (hybrid watcher)

By default, a teammate's Claude Code only knows it has a task waiting if they ask it to check. That's fine for async work, but means dispatched tasks can sit untouched until someone thinks to poll `my_tasks`.

dispatch-mcp ships an optional **hybrid watcher** that closes the loop: a tiny Node daemon subscribes to the server's SSE `/events` feed and, when an actionable event arrives, uses `tmux send-keys` to inject `/dispatch-next` into the teammate's live Claude Code pane. That wakes Claude up, it runs exactly one task via the `dispatch-worktree` skill, and goes idle again.

Why this design:

- **Zero token cost when idle.** The watcher is pure Node and costs nothing while there's no work. Claude Code only spends tokens when a real event arrives.
- **Subscription-friendly.** Uses your existing Claude Code session — no Anthropic API key, no per-call billing.
- **Ordinary Claude Code.** The session you're already running handles the task; there's no separate headless agent to babysit.

### Install the client-side pieces

The entire client bundle — skill, slash command, watcher, prune helper — lives under `skills/dispatch-worktree/`. Teammates only need that one directory. The installer is **project-local only** — dispatch-worktree is scoped to the project that actually uses it, not loaded into every Claude Code session on the machine.

From the project you want dispatch-mcp wired into:

**macOS / Linux / WSL:**

```bash
cd <your-project>
<path-to-dispatch-worktree>/scripts/install-client.sh
# or pass the project root explicitly:
<path-to-dispatch-worktree>/scripts/install-client.sh /path/to/your/project
```

**Windows (PowerShell):**

```powershell
cd <your-project>
<path-to-dispatch-worktree>\scripts\install-client.ps1
# or:
<path-to-dispatch-worktree>\scripts\install-client.ps1 C:\path\to\your\project
```

If PowerShell blocks execution, run it once with
`powershell -ExecutionPolicy Bypass -File install-client.ps1` or
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` in the
current session.

This drops two things inside that project's `.claude/`:

- `.claude/skills/dispatch-worktree/` — protocol docs, watcher script, prune helper
- `.claude/commands/dispatch-next.md` — the `/dispatch-next` slash command that tells Claude "pick one task and run it"

### Launch the watcher

In a separate terminal on the teammate's laptop:

```bash
cd <your-project>
export DISPATCH_URL=http://YOUR_SERVER:7900/events
export DISPATCH_TOKEN='<the same bearer token from .claude/claude.json>'
# Run this next line from *inside* the tmux pane where Claude Code is running:
export TMUX_TARGET="$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')"
node .claude/skills/dispatch-worktree/scripts/dispatch-watch.js
```

The watcher connects to `/events` with the bearer token, filters events down to the ones that need action (`task_created`, `task_commented`, `task_cancelled` — FYI events like `task_pushed` are dropped), and runs `tmux send-keys -t $TMUX_TARGET /dispatch-next Enter` when one arrives. A 2-second rate-limit prevents a burst of events on the same task from spamming prompts.

To sanity-check without touching a live pane, set `DISPATCH_DRY_RUN=1` — the watcher prints what it would send instead of actually firing the tmux command.

### End-to-end flow

```
alex dispatches a task
        │
        ▼
  server emits task_created event on /events SSE
        │
        ▼
  david's dispatch-watch.js receives the event
        │
        ▼
  tmux send-keys "/dispatch-next" into david's Claude Code pane
        │
        ▼
  Claude runs /dispatch-next → my_tasks → picks one task
        │
        ▼
  dispatch-worktree skill triggers, follows review/work/discussion protocol
        │
        ▼
  task completed + worktree cleaned up, Claude goes idle
```

Server-side events are filtered per recipient: the `/events` stream only sends you events that are either broadcast (no `to_user`) or specifically addressed to you, and never echoes back events you triggered yourself.

## Using dispatch-mcp with Codex CLI

Codex CLI supports the same `SKILL.md` frontmatter + lazy-loaded companion-file system as Claude Code ([docs](https://developers.openai.com/codex/skills)) — it just discovers skills from `.agents/skills/` instead of `.claude/skills/`. dispatch-mcp ships a dedicated Codex copy of the skill at:

```
skills/dispatch-worktree-codex/
├── SKILL.md          # frontmatter: name=dispatch-worktree-codex
├── review.md
├── work.md
├── dispatching.md
└── troubleshooting.md
```

It's a trimmed mirror of the Claude Code skill — same protocol, same `SKILL.md` frontmatter format, but without the Claude-only pieces (`commands/dispatch-next.md`, `scripts/install-client.sh`, `scripts/dispatch-watch.js`, `setup-watcher.md`). Codex has no slash commands and the watcher is a Claude-Code-specific auto-wake mechanism, so those would be noise.

### 1. Install the Codex skill

Drop the folder into your project's `.agents/skills/`:

```bash
cd <your-project>
mkdir -p .agents/skills
cp -r <dispatch-mcp-checkout>/skills/dispatch-worktree-codex .agents/skills/
```

Or for a user-global install:

```bash
mkdir -p ~/.agents/skills
cp -r <dispatch-mcp-checkout>/skills/dispatch-worktree-codex ~/.agents/skills/
```

Codex discovers skills in priority order: `.agents/skills/` in the project, `~/.agents/skills/` globally, `/etc/codex/skills/`, and bundled-with-Codex. Project-local is usually what you want — keeps dispatch-mcp scoped to the repo that uses it.

### 2. Wire dispatch-mcp into `~/.codex/config.toml`

Add an MCP server entry:

```toml
[mcp_servers.dispatch]
transport = "sse"
url = "https://dispatch.your-domain.com/sse"

[mcp_servers.dispatch.headers]
Authorization = "Bearer <your-bearer-token>"
```

The same bearer token you use in Claude Code's `.mcp.json` works here. If your Codex version's MCP client only supports stdio transport, you'll need an SSE-to-stdio adapter (e.g. `mcp-proxy`). Check your Codex version's MCP docs for the exact `transport` key name — it has varied across versions.

After editing the config, restart your Codex session so it re-reads the MCP list.

### 3. Verify

In Codex, ask:

```
whoami via dispatch
```

or call `whoami` directly. It should return your handle. If you see `HTTP 401`, re-check the token and the config format.

### 4. You're done

Codex now handles dispatch-mcp tasks identically to Claude Code. The skill's `SKILL.md` frontmatter triggers on the same phrases ("claim this task", "review my branch", "dispatch a task", etc.) and Codex lazy-loads `review.md` / `work.md` / `dispatching.md` / `troubleshooting.md` on demand, same as Claude Code does with its copy.

### Running both runtimes side-by-side

Since the server is runtime-agnostic and `claim_task` is atomic, you can keep both Claude Code and Codex open with the same bearer token and freely pick which one you use per task. The server's first-caller-wins semantics handle any race at the protocol level — there's no need for routing logic, separate handles, or per-runtime task tagging.

If you want Codex to be auto-woken by the existing `dispatch-watch.js` daemon (the way Claude Code is via the `/dispatch-next` slash command injection), that's a separate feature that isn't wired yet. For now, Codex auto-execution is **manual** — open your Codex session and ask "any dispatch tasks?" when you're ready.

## Example Workflow

**David's Claude Code** (authenticated as `david` via his bearer token):
```
> Check my tasks and see if Alex left anything for me

(Claude calls my_tasks — no user arg, the server knows it's david)
→ Task #a1b2: "Review the new WebSocket handler in ws.ts" from alex, priority: high

> Claim that task and start reviewing

(Claude calls claim_task with id="a1b2", then reads ws.ts and provides review)
(Claude calls complete_task with result="Reviewed. Looks good, suggested extracting reconnect logic into a helper. See comment.")
```

**Alex's Claude Code** (authenticated as `alex`):
```
> Send David a task to refactor the auth middleware, it's getting too complex

(Claude calls dispatch_task with title="Refactor auth middleware", to_user="david", files=["src/auth.ts"])
```

## Data

All data is stored in `data/dispatch.db` (SQLite). Delete it to start fresh — note that this also wipes registered users, so you'll need to re-run `node src/admin.js add …` for each teammate and hand out new tokens.

## Security notes

- **Two credentials per user, by design.** The bearer token is for the machine (Claude Code → MCP); the password is for the human (browser → dashboard). Compromise of one doesn't grant the other.
- **MCP endpoints (`/sse`, `/messages`)** require an `Authorization: Bearer <token>` header. Connections without one get 401.
- **Dashboard endpoints (`/`, `/api/*`)** require a JWT cookie obtained via `POST /api/login` (handle + password). Browser visits to `/` without a cookie redirect to `/login`; XHR requests to `/api/*` get a JSON 401.
- **Passwords are bcrypt-hashed (cost 12)** and stored in `users.password_hash`. The server runs a dummy bcrypt compare against a fixed hash when login is attempted for an unknown handle, so attackers can't enumerate handles via timing.
- **Rotation.** `node src/admin.js rotate <handle>` issues a new bearer token (old one stops working). `node src/admin.js set-password <handle>` overwrites the password hash. Already-issued JWTs remain valid until they expire (24h max) — to invalidate them all immediately, change `JWT_SECRET` and restart.
- **TLS.** Tokens and cookies travel in clear unless you put the server behind TLS (nginx / caddy / a tunnel). Once TLS is in place, set `JWT_COOKIE_SECURE=1` so the cookie refuses to ride over plain HTTP.
- **JWT secret.** Set `JWT_SECRET` in the environment for control over rotation. Otherwise the server generates one on first boot and stores it in the `settings` table — restarts won't invalidate sessions, but wiping `data/dispatch.db` will.
