# dispatch-mcp

A message bus for a fleet of coding agents (Claude Code and Codex sessions in tmux) plus a small task tracker and a web dashboard. One Node/Express/SQLite process on `:7900`. Agents talk to it through a bearer-authed HTTP API, a three-command shell CLI, and Claude Code hooks that surface unread messages at the right moment of a turn. The original MCP task tools are still there, one layer down.

**Message-first, since dispatch v2 (2026-09-03).** Everything below `## Server setup` is the older task/MCP material and still applies.

## What It Does

- **Typed messages** — `task | question | request_permission | report | ack | info`, four priorities `low | medium | high | immediate`, threading with `--re`, optional ack, file attachments by path.
- **Tasks from messages** — a `type=task` message creates a `T-YYYYMMDD-NN` task; acks and reports move it through `open → acked → in_progress → waiting/blocked → closed`.
- **Delivery that matches priority** — hooks inject `immediate` at the next tool boundary, block a session from stopping while `medium+` is unread, and force a report before an agent with an open task goes idle. `low` never wakes anyone.
- **Partial drains that never lose anything** — `GET /msg/recv?limit=N` marks only what it returned as read; the rest stays unread on the server.
- **Fleet registry + health** — `~/.dispatch/fleet.json` and `dispatch-fleet check`.
- **Dashboard** — task board at `http://your-server:7900/` (cookie auth, separate from bearer tokens).

> **Body limit: 1,500 characters** (code points, so CJK counts one per character). Longer bodies are rejected with HTTP 400 and a hint to put the detail in a file and pass `--attach <path>`.

## Quick start (agent side)

```bash
~/.dispatch/dispatch-recv                                         # unread, one line each
~/.dispatch/dispatch-recv --full 27b8b9f0                         # full text of one message
~/.dispatch/dispatch-send coord "short note"                      # info / medium
~/.dispatch/dispatch-send pearl-infra --type task --priority high --ack auto \
    --attach /abs/path/spec.md "Title line\nDetails…"             # creates T-YYYYMMDD-NN
~/.dispatch/dispatch-send coord --type ack --re 27b8b9f0 "on it"
~/.dispatch/dispatch-send coord --type report --state done --re T-20260903-02 "[DONE] shipped"
~/.dispatch/dispatch-fleet check
```

Identity is resolved from the tmux pane the command runs in: `$DISPATCH_TOKEN` (+ `$DISPATCH_HANDLE`) if set, else `~/.dispatch/fleet.json` (`handles.<h>.pane == $TMUX_PANE`), else `~/.dispatch/registry.json[$TMUX_PANE]`. Server URL: `$DISPATCH_URL`, else `~/.dispatch/url`, else `http://127.0.0.1:7900`.

## HTTP message API

All endpoints take `Authorization: Bearer <token>` (or `?token=`), return JSON, and derive identity from the token. Timestamps are stored in UTC and rendered in the display zone with an explicit suffix (`2026-09-03 13:19:19+08`).

### `POST /msg/send`

```bash
curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"to":"pearl-infra","body":"Title\nDetails","type":"task","priority":"high","ack":"auto",
       "attachments":["/abs/path/spec.md"]}' http://127.0.0.1:7900/msg/send
# → {"delivered":true,"id":"756dbb0c","to":"pearl-infra","type":"task","priority":"high",
#    "ack_required":true,"task_id":"T-20260903-01","task":{"id":"T-20260903-01","ack_required":true,"status":"open"}}
```

| field | values | notes |
|---|---|---|
| `to` | handle, `"all"`, or omitted | omitted/`all` = broadcast; unknown handle → 404 with the known list |
| `body` | string ≤ 1,500 chars | required; over the limit → 400 `{error, limit, chars}` |
| `type` | `task` `question` `request_permission` `report` `ack` `info` | default `info` |
| `priority` | `low` `medium` `high` `immediate` | default `medium`; legacy `normal`→`medium`, `urgent`→`immediate` |
| `ack` | `yes` `no` `auto` | default `no`; `auto` = required when priority is high/immediate |
| `re` | message id or task id | must exist (404 otherwise); required for `type=ack` |
| `task_id` | task id | explicit task for a report |
| `state` | `done` `continuing` `waiting` `blocked` | only with `type=report`; a report without `state` is `continuing` |
| `attachments` | `["/abs/path", …]` or `[{path,size,sha256,name}, …]` | paths only, nothing is uploaded |
| `force` | boolean | only with `priority=immediate`; makes the recipient's hook deny its next tool call once |

Effects: `type=task` creates a task (title = first non-empty line, ≤ 80 chars; `documents` = attachments; `thread_id` = message id). `type=ack` sets the referenced message `acked` and its task `acked`. `type=report` applies `state` to the task resolved from `task_id` → `re` (task id) → `re` (message with `task_id`) → the sender's single open task; `done` closes it with the body as `result`; a referenced message becomes `closed` (done) or `answered`. Any non-ack, non-report reply to a `question`/`request_permission` marks it `answered`. Acking a `report` (or an `ack`) is refused with 400.

### `GET /msg/recv`

```bash
curl -s -H "Authorization: Bearer $TOK" 'http://127.0.0.1:7900/msg/recv?limit=30&priority=medium%2B'
# → {"handle":"coord","count":2,"remaining":3,"remaining_by_priority":{"low":1,"medium":2,"high":0,"immediate":0},"messages":[…]}
```

`limit` (0 = all) and `priority` (`high` or `high+`, both mean "this level and above") bound the drain; only the returned rows are marked read (`status` → `delivered`), everything else stays unread and is counted in `remaining`. `peek=1` returns the same view without marking anything. A drain that returns the whole backlog advances the per-user cursor and prunes old read rows.

### `GET /msg/:id`

Full message; only the sender, the recipient, or anyone for a broadcast may read it (403 otherwise). Includes `task` when the message carries a `task_id`.

```bash
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:7900/msg/756dbb0c
```

### `GET /msg/history?since=<id>&limit=100`

Everything involving you after message `<id>`, oldest first, non-destructive. `limit` 1–500.

### `GET /msg/wait?priority=medium%2B&timeout=60`

Long-poll (peek semantics): returns as soon as an unread message at/above `priority` exists, or after `timeout` seconds (`timed_out: true`). Capped at `DISPATCH_WAIT_MAX_S` (280, under Node's 300 s request timeout). Used by the experimental async Stop hook.

### `GET /hook/digest?since=<UTC ts>`

One call for the hooks: `unread` (total, by_priority, one summary item per message with `force`/`task_id`/`chars`), `immediate` (full text of immediate messages), `open_tasks`, `unacked_required`, `last_report_at`, and `reported_since` (did this handle send a `report` at/after `since`). Never consumes anything.

### `POST /presence`

```bash
curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{"state":"busy","session":"dispatch-mcp-72"}' http://127.0.0.1:7900/presence
```

`state` ∈ `busy | turn_end | idle | offline`; `session` is free text (the Claude session name).

### `GET /fleet`

Per registered handle: `last_seen_at`, `mcp_connected`, hook-reported `state`/`state_at`/`session`, `unread`, `unread_high_plus`, `oldest_unread_at`, `open_tasks`, `unacked_tasks`. Any valid token may call it.

### `GET /events`

SSE feed of `task_*` and `message_created` events, filtered to the caller (directed or broadcast, never your own). The watcher subscribes here.

## CLI (`cli/`, installed to `~/.dispatch/`)

Python 3 stdlib only (they also run inside hooks on a 2 s budget). `dispatchlib.py` is shared.

```
dispatch-send <to|all> [--type T] [--priority P] [--ack yes|no|auto]
              [--re <id>] [--task <T-id>] [--state S] [--attach <path>]...
              [--force] [--json] "<body>"
    -t/-p/-a short forms; --flag=value accepted; -- ends flags. $PRIORITY=high still honoured.
    Prints "sent -> <to> (id …)" plus task id / ack required / acked / answered, and a
    "hint: <to> is idle (Claude session "<name>") — … SendMessage(to="<name>")" line when the
    recipient is a Claude session whose ~/.claude/sessions/<pid>.json says idle.

dispatch-recv [--limit N] [--priority high+] [--all] [--since <id>]
              [--full [<id>[,<id>...]]] [--peek] [--json]
    Default: drain ≤30, one line each:  id  time  from→to  type  priority  [flags]  first 120 chars
    Flags: [FORCE] [ACK!] [T-…] [re …] [DONE|CONTINUING|WAITING|BLOCKED] [n attach].
    Long bodies get "(--full <id>, N chars)". Output capped at 64 KB ($DISPATCH_RECV_MAXBYTES).
    Everything drained is appended to ~/.dispatch/spool-<handle>.jsonl. --since uses the server,
    falls back to the spool when the server is down.

dispatch-fleet check [--json] | sync [--write] | show
    check: per handle — pane, runtime, pane_current_command vs expected (claude→claude, codex→node),
    watcher pm2 status + pane drift, Claude session name/status, server state/unread/open tasks;
    exit 1 on any problem. sync: (re)build fleet.json; --write also regenerates registry.json.
```

### `~/.dispatch/fleet.json`

```json
{
  "version": 1,
  "generated_at": "2026-09-03 13:25:10+0800",
  "url": "http://127.0.0.1:7900",
  "tmux_tmpdir": "/var/solana/data/tmp",
  "handles": {
    "coord": { "token": "coord-…", "runtime": "claude", "pane": "%0",
               "watcher": "watch-coord", "watcher_pane": "%0",
               "session_name": "coordination-6d", "cwd": "/…/coordination", "session_id": "…" }
  }
}
```

Single source of truth for handle → token / runtime / pane / session_name / cwd / watcher. `registry.json` (pane → handle/token/runtime) is kept as a derived file for `dispatch-common.sh` and the watcher's expected-command lookup. `session_name` is whatever `~/.claude/sessions/<pid>.json` reported at sync time — it changes on every session restart, so treat it as a cache.

## Claude Code hooks (`cli/hook.sh` → `dispatch-hook.py`)

| event | what the hook does |
|---|---|
| `SessionStart` | digest (unread + open tasks + unacked) → `additionalContext` |
| `UserPromptSubmit` | `POST /presence busy`; digest → `additionalContext`; records the turn start |
| `PreToolUse` | immediate unread → `additionalContext` with the full text; if the sender passed `--force`, **deny** that tool call once (never `dispatch-recv` itself) |
| `PostToolUse` | immediate unread → full text the first time, a one-line reminder afterwards |
| `Stop` | `POST /presence turn_end`; medium+ unread → block with the digest; open task and no report this turn → block; `stop_hook_active` → allow. One block per turn. |
| `Notification` (`idle_prompt`) | `POST /presence idle` |
| `SessionEnd` | `POST /presence offline` |
| `Wait` (B′, verified 2026-09-03) | run as an `async` + `asyncRewake` Stop hook: long-polls `/msg/wait` and exits 2 when a medium+ message lands; Claude Code then wakes the idle session within ~3 s and shows the digest as "Stop hook feedback". One waiter per session (pid file, replaced at every Stop), lifetime `DISPATCH_WAIT_TOTAL_S` (default 600 s), then it exits 0 quietly. `low` never triggers it. |

Every server call has a ≤ 2 s timeout; if the server is unreachable the hook exits 0 with no output. Panes that are not in the fleet are ignored. Per-session state (which immediate ids were injected/denied, turn start) lives in `~/.dispatch/state/`. The settings block to enable them is in `~/.dispatch/PROTOCOL.md` ("Hooks" and "閒置喚醒路徑"); `hook.sh` is silent for panes that are not in `fleet.json`, so the block is safe in `~/.claude/settings.json` for every session. Hook config changes are picked up live: on the dtest session an edited `.claude/settings.json` was honoured by the very next Stop without a restart (measured 2026-09-03 17:10).

## Schema (SQLite, `data/dispatch.db`, WAL)

`messages`: `id, from_user, to_user (NULL = broadcast), body, priority, created_at, delivered_at, type, ack, re, task_id, state, attachments (JSON), status (queued|delivered|acked|answered|closed), acked_at, closed_at, force`.

`message_reads`: `(handle, message_id, read_at)` — the per-recipient read set. Unread = addressed to me or broadcast, not from me, `created_at >= users.last_message_seen_at`, and not in my read set. The cursor is a lower bound so the read set stays small; it only advances when a drain returned everything.

`tasks`: the original columns plus `ack_required, acked_at, documents (JSON), thread_id`; `status` gains `acked | waiting | blocked`; `claim_task` accepts `open` or `acked`.

`presence`: plus `state, state_at, session`.

**Migration** runs at boot, additively (`ALTER TABLE … ADD COLUMN` via `PRAGMA table_info`), rewrites legacy priorities in place (`normal`→`medium`, `urgent`→`immediate` on both tables), and does a one-time backfill of `messages.status` for rows at or before each recipient's cursor, guarded by the `migr_p1_msg_status` settings key. Back up `data/dispatch.db` first on a live server.

## Environment

| var | default | purpose |
|---|---|---|
| `PORT` | `7900` | listen port |
| `DISPATCH_DATA_DIR` | `<repo>/data` | DB location (tests point this at a temp dir) |
| `DISPATCH_TZ` / `DISPATCH_TZ_SUFFIX` | `Asia/Taipei` / `+08` | display zone for agent-facing timestamps and task-id dates |
| `DISPATCH_BODY_MAX` | `1500` | body limit in code points |
| `DISPATCH_WAIT_MAX_S` | `280` | cap on `/msg/wait` timeout |
| `JWT_SECRET`, `JWT_COOKIE_SECURE` | generated / unset | dashboard cookie (see Dashboard) |

Watcher (`skills/dispatch-worktree/scripts/dispatch-watch.js`, one pm2 `watch-<handle>` per pane): `DISPATCH_URL`, `DISPATCH_TOKEN`, `TMUX_TARGET`, `DISPATCH_PROMPT`, guards `DISPATCH_EXPECT_CMD` / `DISPATCH_HUMAN_IDLE_MS` / `DISPATCH_GUARDS_OFF`, `DISPATCH_MIN_WAKE_PRIORITY` (default `medium`: `low` messages never trigger a keystroke wake; logged as `no wake`), and `DISPATCH_FLEET` (default `~/.dispatch/fleet.json`, consulted before `registry.json` for the expected foreground command). Guard C tells an empty composer from a half-typed one by *styling*: every TUI here renders its hint with SGR 2 (dim) and human input carries no dim attribute, so the capture is taken with `-e` and dim runs are stripped first (a literal hint list loses because Codex rotates its hint).

## Codex sessions (0.148)

Codex CLI 0.148.0 ships lifecycle hooks (`codex features list` → `hooks stable true`; config file `hooks.json`, hooks must be trusted once in the TUI or run with `--dangerously-bypass-hook-trust`). The binary carries Claude-compatible wire types for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`permissionDecision` allow/deny + `additionalContext`), `PostToolUse`, `PermissionRequest`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `SessionEnd` — but **no `Stop` event and no async rewake**. So `hook.sh` could give a Codex handle the same digest-at-prompt and immediate-at-tool-boundary behaviour (same JSON in and out), but not the "block the stop until you read medium+" rule nor the idle wake. Codex idle wake therefore stays on the guarded keystroke watcher (P0). Wiring `hook.sh` into a Codex `hooks.json` has **not** been tested on a live Codex session yet; the exact `hooks.json` shape is not documented in `docs/config.md` (which only covers `allow_managed_hooks_only`).

## Tests

```bash
node --test test/*.mjs
```

`test/p1.test.mjs` boots the server on a free port with a temp DB and covers: defaults and legacy priorities, the body limit, validation, task creation/ack/report lifecycle, partial drains and priority filters, broadcast fan-out, same-second arrivals, question/answer threading and 403s, the hook digest, `/msg/wait`, presence and `/fleet`, and the legacy client shape.

## Server setup

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

## MCP Tools (secondary surface)

The MCP endpoint (`/sse`) still exists for sessions that mount the server as an MCP tool. Nobody in the fleet currently does — the HTTP API + CLI above is the primary surface — but the tools are kept working.

| Tool | Description |
|------|-------------|
| `send_message` | Send a typed message (same fields as `POST /msg/send`) |
| `my_messages` | Drain your unread messages (full drain, like `GET /msg/recv` with no limit) |
| `request_review` | Ask for a review of a pinned commit (server verifies it exists in the registered repo) |
| `request_work` | Ask for code starting from a base commit |
| `start_discussion` | Open a discussion task, no git refs |
| `my_tasks` | Tasks assigned to you + outbound completions since your last check |
| `list_all_tasks` | Full task history |
| `get_task` | Task details + comments + worktree commands |
| `claim_task` | `open`/`acked` → `in_progress` |
| `push_work` | Record the pushed branch/commit (work tasks) |
| `complete_task` | Close a task (review verdict optional) |
| `cancel_task` | Cancel a task |
| `comment_on_task` | Add a note to a task |
| `announce_work` | Broadcast what files you're touching |
| `check_conflicts` | See if anyone else is on your files |
| `who_is_online` | Live MCP connections |
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
