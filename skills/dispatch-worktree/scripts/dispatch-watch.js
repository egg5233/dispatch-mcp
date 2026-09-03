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
import fs from "fs";
import os from "os";

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
const TMUX_BIN = process.env.DISPATCH_TMUX || "tmux";

// ── Send-keys guards (added 2026-09-03, dispatch v2 P0) ────────────
//
// WHY: the idle gate above only looked for BUSY_MARKER. A pane whose agent
// has EXITED (back to a bash prompt) shows no marker at all, so it read as
// "idle" and we typed the prompt straight into the shell. That really
// happened on %7/%10 (`bash: syntax error near unexpected token '('`) and
// %6 (codex had crashed out to bash). Three guards now gate every poke;
// if any fails we log one `blocked:` line and retry on the next tick —
// the payload stays safe on the server, so deferring costs nothing.
const EXPECT_CMD_ENV = process.env.DISPATCH_EXPECT_CMD || "";
const REGISTRY_PATH =
  process.env.DISPATCH_REGISTRY || `${os.homedir()}/.dispatch/registry.json`;
// runtime -> expected #{pane_current_command}. codex runs as a node process
// (measured 2026-09-03 on %5: `node .../bin/codex --dangerously-bypass...`).
const RUNTIME_CMD = { claude: "claude", codex: "node" };
const HUMAN_IDLE_MS = parseInt(process.env.DISPATCH_HUMAN_IDLE_MS || "8000", 10);
// Composer placeholders that LOOK like residual text but are not. codex
// renders a grey hint after its `\u203a` prompt; treat those as empty.
const PLACEHOLDERS = (process.env.DISPATCH_PLACEHOLDERS ||
  "Write tests for @filename|Ask Codex to do anything").split("|").map((x) => x.trim()).filter(Boolean);
// Escape hatch: DISPATCH_GUARDS_OFF=1 restores pre-v2 behaviour.
const GUARDS_OFF = process.env.DISPATCH_GUARDS_OFF === "1";
// dispatch v2 P1: a `low` message never wakes anyone by keystroke — it waits
// for the agent's next natural turn (SessionStart / UserPromptSubmit hooks
// surface it). Raise to "high" to make medium wait for the Stop hook too.
const PRIORITY_RANK = { low: 0, medium: 1, high: 2, immediate: 3, normal: 1, urgent: 3 };
const MIN_WAKE_PRIORITY = process.env.DISPATCH_MIN_WAKE_PRIORITY || "medium";
const MIN_WAKE_RANK = PRIORITY_RANK[MIN_WAKE_PRIORITY] ?? 1;
const FLEET_PATH = process.env.DISPATCH_FLEET || `${os.homedir()}/.dispatch/fleet.json`;

// Expected foreground command for THIS watcher's pane. Explicit env wins;
// otherwise derive it from registry.json (pane id -> runtime -> command).
// Empty string = unknown -> guard A cannot run, and we FAIL CLOSED.
function resolveExpectCmd() {
  if (EXPECT_CMD_ENV) return EXPECT_CMD_ENV;
  // fleet.json (P1, single source of truth) first; registry.json fallback.
  try {
    const fleet = JSON.parse(fs.readFileSync(FLEET_PATH, "utf8"));
    for (const ent of Object.values(fleet.handles || {})) {
      if (ent.pane === TMUX_TARGET && ent.runtime) return RUNTIME_CMD[ent.runtime] || ent.runtime;
    }
  } catch {
    // no fleet.json yet — fall through
  }
  try {
    const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    const ent = reg[TMUX_TARGET];
    if (ent && ent.runtime) return RUNTIME_CMD[ent.runtime] || ent.runtime;
  } catch (e) {
    console.error(`[${ts()}] registry read failed (${REGISTRY_PATH}): ${e.message}`);
  }
  return "";
}
const EXPECT_CMD = resolveExpectCmd();

// Log `blocked:` at most once per reason per BLOCK_LOG_MS, so a pane that
// sits in a blocked state for hours doesn't flood the pm2 log at 1.5s/tick.
const BLOCK_LOG_MS = parseInt(process.env.DISPATCH_BLOCK_LOG_MS || "30000", 10);
let lastBlockReason = "";
let lastBlockLoggedAt = 0;
function logBlocked(reason) {
  const now = Date.now();
  if (reason === lastBlockReason && now - lastBlockLoggedAt < BLOCK_LOG_MS) return;
  lastBlockReason = reason;
  lastBlockLoggedAt = now;
  console.log(`[${ts()}] blocked: ${reason}`);
}
function clearBlocked() {
  lastBlockReason = "";
}

// Strip box-drawing/decoration so we can tell an empty composer from a
// half-typed one. Keeps it deliberately crude — this guard is best-effort.
function composerResidue(capture) {
  // The reliable discriminator is STYLING, not text: every TUI here renders
  // its composer hint with SGR 2 (faint), while text a human actually typed
  // carries no dim attribute. Measured 2026-09-03 on live panes:
  //   %6 codex   \x1b[2mAsk Codex to do anything\x1b[0m     placeholder
  //   %5 codex   \x1b[2mWrite tests for @filename\x1b[0m    placeholder
  //   %9 claude  \x1b[39m\u276f <half-typed line>           real input
  // A literal hint list loses, because codex rotates the hint.
  // REQUIRES a capture taken with `capture-pane -e` so escapes survive.
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    const undimmed = raw.replace(/\x1b\[2m[\s\S]*?\x1b\[0m/g, "");
    const plain = undimmed.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const m = /[\u276f\u203a>][ \u00a0]?(.*)$/.exec(plain);
    if (!m) continue;
    let rest = m[1]
      .replace(/[\u2500-\u257f]/g, "")
      .replace(/[\u00a0\s]/g, " ")
      .trim();
    if (!rest) return "";
    if (PLACEHOLDERS.some((ph) => rest === ph || rest.startsWith(ph))) return "";
    return rest;
  }
  return "";
}

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

// Decide whether it is safe to type into the target pane. Runs three
// guards plus the original busy-marker check; `cb(ok, reason)`.
//
//   A. foreground command  — #{pane_current_command} must equal the runtime
//      this handle is registered as. This is the one that stops us typing
//      into a bash prompt after an agent has exited. FAILS CLOSED: if we
//      cannot determine the expected command we refuse to send.
//   B. human activity      — a human touching the session in the last
//      HUMAN_IDLE_MS means hands are on the keyboard; defer.
//   C. composer empty      — best-effort: don't append to half-typed input.
//
// Any tmux error also blocks: we never fire blind.
function checkGuards(cb) {
  if (!TMUX_TARGET) return cb(true, "");
  execFile(
    TMUX_BIN,
    ["display", "-p", "-t", TMUX_TARGET,
     "#{pane_current_command}\n#{session_activity}\n#{session_name}"],
    (err, out) => {
      if (err) return cb(false, `tmux display failed: ${err.message}`);
      const parts = String(out).split("\n").map((x) => x.trim());
      const cmd = parts[0] || "";
      const sessAct = parseInt(parts[1] || "0", 10) || 0;
      const sessName = parts[2] || "";

      // ── Guard A: foreground command ──
      if (!GUARDS_OFF) {
        if (!EXPECT_CMD) {
          return cb(false,
            `no expected runtime for ${TMUX_TARGET} (registry miss) — failing closed`);
        }
        if (cmd !== EXPECT_CMD) {
          return cb(false,
            `foreground is "${cmd}", expected "${EXPECT_CMD}" — agent not running in ${TMUX_TARGET}`);
        }
      }

      // ── Guard B: human activity ──
      execFile(TMUX_BIN, ["list-clients", "-F", "#{client_session} #{client_activity}"],
        (e2, cout) => {
          let newest = sessAct;
          if (!e2 && cout) {
            for (const line of String(cout).split("\n")) {
              const bits = line.trim().split(/\s+/);
              if (bits.length === 2 && bits[0] === sessName) {
                const a = parseInt(bits[1], 10) || 0;
                if (a > newest) newest = a;
              }
            }
          }
          const ageMs = (Math.floor(Date.now() / 1000) - newest) * 1000;
          if (!GUARDS_OFF && newest > 0 && ageMs >= 0 && ageMs < HUMAN_IDLE_MS) {
            return cb(false,
              `human activity ${Math.round(ageMs / 1000)}s ago in session "${sessName}" (< ${HUMAN_IDLE_MS / 1000}s)`);
          }

          // ── busy marker + Guard C: composer empty ──
          execFile(TMUX_BIN, ["capture-pane", "-p", "-t", TMUX_TARGET], (e3, cap) => {
            if (e3) return cb(false, `capture-pane failed: ${e3.message}`);
            if (String(cap).includes(BUSY_MARKER)) {
              return cb(false, "agent busy (interrupt hint visible)");
            }
            if (GUARDS_OFF) return cb(true, "");
            // Guard C needs -e: the plain capture drops the dim attribute
            // that distinguishes a placeholder from half-typed input.
            execFile(TMUX_BIN, ["capture-pane", "-p", "-e", "-t", TMUX_TARGET], (e4, capE) => {
              if (e4) return cb(false, `capture-pane -e failed: ${e4.message}`);
              const residue = composerResidue(String(capE));
              if (residue) {
                return cb(false, `composer not empty: ${JSON.stringify(residue.slice(0, 40))}`);
              }
              cb(true, "");
            });
          });
        });
    }
  );
}

function pokeTmux() {
  const label = lastLabel || "wake";
  if (DRY_RUN) {
    console.log(`[${ts()}] DRY RUN would send "${PROMPT}" to ${TMUX_TARGET || "<unset>"} — ${label}`);
    return;
  }
  // Type the text (literal) and the Enter as SEPARATE send-keys calls with
  // a short gap — a combined "text Enter" races on TUI composers (the Enter
  // can arrive before the paste is processed, leaving text unsubmitted).
  execFile(TMUX_BIN, ["send-keys", "-t", TMUX_TARGET, "-l", PROMPT], (err) => {
    if (err) {
      console.error(`[${ts()}] tmux send-keys (text) failed: ${err.message}`);
      console.error("  Is tmux running? Is TMUX_TARGET correct? Is the pane still open?");
      return;
    }
    setTimeout(() => {
      execFile(TMUX_BIN, ["send-keys", "-t", TMUX_TARGET, "Enter"], (e2) => {
        if (e2) console.error(`[${ts()}] tmux send-keys (Enter) failed: ${e2.message}`);
        else console.log(`[${ts()}] fired "${PROMPT}" → ${TMUX_TARGET}  (${label})`);
      });
    }, 200);
  });
}

function maybeWake() {
  if (!wakePending) return;
  if (Date.now() - lastFiredAt < MIN_INTERVAL) return;
  checkGuards((ok, reason) => {
    if (!wakePending) return;      // drained while checking
    if (!ok) { logBlocked(reason); return; }  // retry next tick; payload safe on server
    clearBlocked();
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
  if (event.type === "message_created" && event.message) {
    const rank = PRIORITY_RANK[event.message.priority] ?? 1;
    if (rank < MIN_WAKE_RANK) {
      console.log(`[${ts()}] no wake (priority ${event.message.priority} < ${MIN_WAKE_PRIORITY}): #${id} from ${event.actor || "?"}`);
      return;
    }
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

// --selftest: run the guards once against TMUX_TARGET, print the verdict,
// exit 0 if we WOULD fire and 1 if blocked. Handy for auditing a pane
// without waiting for a real event, and for the deploy DoD check.
if (process.argv.includes("--selftest")) {
  checkGuards((ok, reason) => {
    console.log(
      `selftest ${TMUX_TARGET}: ${ok ? "WOULD FIRE" : "BLOCKED"}` +
      (reason ? ` — ${reason}` : "") +
      `  (expect cmd "${EXPECT_CMD || "<unknown>"}")`
    );
    process.exit(ok ? 0 : 1);
  });
} else {

console.log(`dispatch-watch`);
console.log(`  events URL:   ${URL_STR}`);
console.log(`  tmux target:  ${TMUX_TARGET || "(dry-run)"}`);
console.log(`  prompt:       ${PROMPT}`);
console.log(`  min interval: ${MIN_INTERVAL}ms`);
console.log(`  idle gate:    poll ${IDLE_POLL_MS}ms, busy marker "${BUSY_MARKER}"`);
console.log(`  min wake:     priority ${MIN_WAKE_PRIORITY}+ (lower waits for the agent's next turn)`);
console.log(`  guards:       ${GUARDS_OFF ? "DISABLED (DISPATCH_GUARDS_OFF=1)" : `expect cmd "${EXPECT_CMD || "<unknown — will fail closed>"}", human-idle ${HUMAN_IDLE_MS}ms`}`);
console.log(`  reconnect:    ${RECONNECT_MS}ms`);
console.log(`  dry run:      ${DRY_RUN}`);
console.log();
connect();
}
