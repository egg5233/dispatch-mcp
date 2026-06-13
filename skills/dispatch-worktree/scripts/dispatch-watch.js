#!/usr/bin/env node
//
// dispatch-watch.js — tiny daemon that watches dispatch-mcp's /events
// SSE stream and injects a prompt into a live Claude Code session via
// `tmux send-keys` whenever a task needs your attention.
//
// The point: zero token cost when nothing is happening. Your Claude
// Code session stays idle. When a teammate dispatches a task, this
// watcher fires exactly one prompt at your live session, which wakes
// Claude up, runs the task via the dispatch-worktree skill, and goes
// back to idle.
//
// Usage:
//   DISPATCH_URL=http://server:7900/events \
//   DISPATCH_TOKEN=<bearer token from .claude/claude.json> \
//   TMUX_TARGET=session:window.pane \
//   node scripts/dispatch-watch.js
//
// Optional env:
//   DISPATCH_PROMPT        prompt to inject (default: "/dispatch-next")
//   DISPATCH_MIN_INTERVAL  minimum ms between injections (default: 2000)
//   DISPATCH_RECONNECT_MS  reconnect delay on disconnect (default: 5000)
//   DISPATCH_DRY_RUN       if "1", print what would be sent instead of running tmux
//
// Finding your TMUX_TARGET: in the tmux pane where Claude Code runs,
//   tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'
//

import http from "http";
import https from "https";
import { URL } from "url";
import { execFile } from "child_process";

const URL_STR = process.env.DISPATCH_URL;
const TOKEN = process.env.DISPATCH_TOKEN;
const TMUX_TARGET = process.env.TMUX_TARGET;
const PROMPT = process.env.DISPATCH_PROMPT || "/dispatch-next";
const MIN_INTERVAL = parseInt(process.env.DISPATCH_MIN_INTERVAL || "2000", 10);
const RECONNECT_MS = parseInt(process.env.DISPATCH_RECONNECT_MS || "5000", 10);
const DRY_RUN = process.env.DISPATCH_DRY_RUN === "1";
// Idle-gate: never poke a pane that's mid-turn (that's what causes the
// "agent interrupted me" problem). We treat the pane as BUSY while its TUI
// shows this marker, and only fire the poke once it's gone. The message is
// safe in the server meanwhile, so deferring loses nothing.
const BUSY_MARKER = process.env.DISPATCH_BUSY_MARKER || "esc to interrupt";
const IDLE_POLL_MS = parseInt(process.env.DISPATCH_IDLE_POLL_MS || "1500", 10);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!URL_STR) die("DISPATCH_URL env var required, e.g. http://server:7900/events");
if (!TOKEN) die("DISPATCH_TOKEN env var required");
if (!TMUX_TARGET && !DRY_RUN) {
  die(
    "TMUX_TARGET env var required (e.g. 'claude:0.0'). To discover it, run this inside the tmux pane where Claude Code is running:\n" +
      "  tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}'\n" +
      "Or set DISPATCH_DRY_RUN=1 to print instead of sending."
  );
}

// Actionable events: ones where our side needs to do something.
// FYI events (task_claimed / task_pushed / task_completed) are dropped
// by default — they indicate the other side is making progress on
// something we dispatched, not that we need to act.
const ACTIONABLE = new Set([
  "task_created",
  "task_commented",
  "task_cancelled",
  "message_created",
]);

// Reconnect bookkeeping: multiple events can fire for a single
// disconnect (error + close, or end + close). We only want to
// schedule one reconnect per disconnect so we don't stack timers.
let reconnectTimer = null;
function scheduleReconnect(reason) {
  if (reconnectTimer) return; // already scheduled, ignore dup
  console.log(`[${ts()}] ${reason}, reconnecting in ${RECONNECT_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Coalescing, idle-gated waker ───────────────────────────────────
//
// Actionable events don't fire a poke directly — they just set
// `wakePending`. A timer (maybeWake) fires the poke only once the pane
// is IDLE and the rate-limit window has passed. Two properties fall out:
//   1. No mid-turn interruption — we never send-keys while the agent is
//      working, so the coordinator stops getting yanked mid-thought.
//   2. Burst coalescing — N messages arriving while busy collapse into a
//      single poke; the agent drains them all via my_messages / the slash
//      command. Nothing is lost because the payload lives in the server.
let lastFiredAt = 0;
let wakePending = false;
let lastLabel = "";

// Capture the target pane and decide if the agent is idle (safe to poke).
// Busy = the TUI is showing its interrupt hint (BUSY_MARKER). On any
// capture error we report "not idle" so we never fire blind.
function checkIdle(cb) {
  // capture-pane is read-only, so we run it even in DRY_RUN (only the
  // send-keys poke is suppressed). With no target at all there's nothing
  // to inspect, so treat as idle.
  if (!TMUX_TARGET) return cb(true);
  execFile("tmux", ["capture-pane", "-p", "-t", TMUX_TARGET], (err, stdout) => {
    if (err) {
      console.error(`[${ts()}] capture-pane failed: ${err.message}`);
      return cb(false);
    }
    cb(!stdout.includes(BUSY_MARKER));
  });
}

function pokeTmux() {
  const label = lastLabel || "wake";
  if (DRY_RUN) {
    console.log(`[${ts()}] DRY RUN would send "${PROMPT}" to ${TMUX_TARGET || "<unset>"} — ${label}`);
    return;
  }
  execFile("tmux", ["send-keys", "-t", TMUX_TARGET, PROMPT, "Enter"], (err) => {
    if (err) {
      console.error(`[${ts()}] tmux send-keys failed: ${err.message}`);
      console.error("  Is tmux running? Is TMUX_TARGET correct? Is the pane still open?");
      return;
    }
    console.log(`[${ts()}] fired "${PROMPT}" → ${TMUX_TARGET}  (${label})`);
  });
}

function maybeWake() {
  if (!wakePending) return;
  if (Date.now() - lastFiredAt < MIN_INTERVAL) return;
  checkIdle((idle) => {
    if (!wakePending) return; // drained while checking
    if (!idle) return;        // busy — retry next tick; payload is safe in the server
    wakePending = false;
    lastFiredAt = Date.now();
    pokeTmux();
  });
}
setInterval(maybeWake, IDLE_POLL_MS);

function handleEvent(event) {
  if (!event || !event.type) return;
  const id = event.task?.id || event.message?.id || "?";
  if (!ACTIONABLE.has(event.type)) {
    console.log(`[${ts()}] fyi: ${event.type} #${id} from ${event.actor || "?"}`);
    return;
  }
  lastLabel = `${event.type} #${id} from ${event.actor || "?"}`;
  wakePending = true;
  console.log(`[${ts()}] wake pending (idle-gated): ${lastLabel}`);
}

// ── SSE client ──────────────────────────────────────────────────
//
// Minimal SSE parser: split on blank lines, concat data: lines, JSON-parse.
// Ignores comment frames (lines starting with ":") — those are the
// server's keepalive pings.

function connect() {
  const url = new URL(URL_STR);
  const mod = url.protocol === "https:" ? https : http;

  const req = mod.request(
    {
      host: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      },
    },
    (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (chunk) => (body += chunk.toString()));
        res.on("end", () => {
          console.error(`[${ts()}] HTTP ${res.statusCode}: ${body.trim() || "<no body>"}`);
          console.error(`  reconnecting in ${RECONNECT_MS}ms`);
          setTimeout(connect, RECONNECT_MS);
        });
        return;
      }
      console.log(`[${ts()}] connected to ${URL_STR}`);

      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        // SSE frames end with a blank line
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const dataLines = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            // lines starting with ":" are comments (our heartbeat pings) — skip
          }
          if (dataLines.length === 0) continue;
          try {
            handleEvent(JSON.parse(dataLines.join("\n")));
          } catch (e) {
            console.error(`[${ts()}] bad event frame: ${e.message}`);
          }
        }
      });

      // Reconnect-on-disconnect handlers.
      //
      // Both `end` (clean EOF) and `error` (stream/socket error) are
      // always followed by `close`, so `close` is the single reliable
      // trigger for "we're no longer subscribed, reconnect now." We
      // log the distinguishing event type (if any) and let the debounced
      // scheduleReconnect pick it up. This fixes the bug where the
      // server restarting would cause `error` to fire, no reconnect to
      // be scheduled, and Node to exit cleanly with status 0 — which
      // systemd's Restart=on-failure then ignores.
      res.on("end", () => {
        // clean EOF — `close` will fire right after; no action needed here
      });

      res.on("error", (e) => {
        console.error(`[${ts()}] stream error: ${e.message}`);
        // `close` will fire right after and schedule the reconnect
      });

      res.on("close", () => {
        scheduleReconnect("stream closed");
      });
    }
  );

  req.on("error", (e) => {
    console.error(`[${ts()}] connection error: ${e.message}`);
    scheduleReconnect("after connection error");
  });

  req.end();
}

// Both signals shut down cleanly. systemctl stop sends SIGTERM by
// default; Ctrl-C in a terminal sends SIGINT. Without a SIGTERM
// handler, the process would still exit, but the "shutting down"
// line wouldn't land in journalctl — and if we ever add cleanup
// logic, it would be skipped on `systemctl stop`.
function shutdown(sig) {
  console.log(`\n${sig} received, shutting down`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log(`dispatch-watch`);
console.log(`  events URL:   ${URL_STR}`);
console.log(`  tmux target:  ${TMUX_TARGET || "(dry-run)"}`);
console.log(`  prompt:       ${PROMPT}`);
console.log(`  min interval: ${MIN_INTERVAL}ms`);
console.log(`  idle gate:    poll ${IDLE_POLL_MS}ms, busy marker "${BUSY_MARKER}"`);
console.log(`  reconnect:    ${RECONNECT_MS}ms`);
console.log(`  dry run:      ${DRY_RUN}`);
console.log();
connect();
