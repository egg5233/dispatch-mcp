#!/usr/bin/env python3
"""Claude Code hook body for the dispatch bus (called by hook.sh <event>).

Behaviour per event (spec: DISPATCH-V2-SPEC.md §P1.4):
  SessionStart      digest of unread + open tasks → additionalContext
  UserPromptSubmit  presence=busy; digest → additionalContext; record turn start
  PreToolUse        immediate unread → additionalContext with full text
                    (sender --force → deny the tool call ONCE, unless the call
                    is itself dispatch-recv)
  PostToolUse       immediate unread → additionalContext (full text first time,
                    one-line reminder afterwards)
  Stop              presence=turn_end; unread medium+ → block with summary;
                    open task and no report this turn → block ("report first");
                    stop_hook_active=true → always allow
  Notification      idle_prompt → presence=idle
  SessionEnd        presence=offline
  Wait              (B′ experiment; run as an async Stop hook with asyncRewake)
                    long-poll /msg/wait?priority=medium+ until a message lands →
                    print the digest and exit 2 so Claude Code re-wakes the
                    session; exit 0 quietly at the deadline (DISPATCH_WAIT_TOTAL_S,
                    default 600). One waiter per session (pid file).

Every server call has a ≤2s timeout; if the server is down we exit 0 silently.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import dispatchlib as D  # noqa: E402

HTTP_TIMEOUT = float(os.environ.get("DISPATCH_HOOK_TIMEOUT", "2"))
STATE_DIR = os.path.join(D.CFG, "state")
RECV_HINT = "~/.dispatch/dispatch-recv"


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.flush()


def state_path(handle, session_id):
    return os.path.join(STATE_DIR, "%s-%s.json" % (handle, (session_id or "nosession")[:36]))


def load_state(handle, session_id):
    try:
        with open(state_path(handle, session_id), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"injected": {}, "denied": {}, "turn_start": None, "blocked_turn": None}


def save_state(handle, session_id, st):
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        tmp = state_path(handle, session_id) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(st, f)
        os.replace(tmp, state_path(handle, session_id))
    except OSError:
        pass


def presence(tok, state, session_name):
    try:
        D.http("POST", "/presence", {"state": state, "session": session_name}, token=tok, timeout=min(HTTP_TIMEOUT, 1.5))
    except D.DispatchError:
        pass


def wake(tok, method, ids, detail=None):
    """Fire-and-forget delivery record for the dashboard (P2)."""
    try:
        D.http("POST", "/wake", {"method": method, "message_ids": list(ids)[:50], "detail": detail}, token=tok, timeout=min(HTTP_TIMEOUT, 1.5))
    except D.DispatchError:
        pass


def digest(tok, since=None):
    q = "/hook/digest"
    if since:
        q += "?since=" + since.replace(" ", "%20")
    try:
        st, d = D.http("GET", q, token=tok, timeout=HTTP_TIMEOUT)
    except D.DispatchError:
        return None
    if st != 200 or not d:
        return None
    return d


def fmt_item(i):
    pri = i["priority"].upper() if i["priority"] in ("high", "immediate") else i["priority"]
    flags = []
    if i.get("force"):
        flags.append("[FORCE]")
    if i.get("task_id"):
        flags.append("[%s]" % i["task_id"])
    if i.get("ack") == "yes" or (i.get("ack") == "auto" and i["priority"] in ("high", "immediate")):
        flags.append("[ACK!]")
    return "  %s  %s→you  %s  %s  %s%s" % (
        i["id"], i["from_user"], i["type"], pri, (" ".join(flags) + "  ") if flags else "", i["summary"])


def digest_text(d, handle, header="[dispatch]"):
    u = d["unread"]
    by = u["by_priority"]
    parts = []
    lines = []
    if u["total"]:
        counts = " · ".join("%s %d" % (k, by.get(k, 0)) for k in ("immediate", "high", "medium", "low") if by.get(k))
        lines.append("%s %d unread message(s) for %s (%s). Read them: %s" % (header, u["total"], handle, counts, RECV_HINT))
        for i in u["items"][:15]:
            lines.append(fmt_item(i))
        if u["total"] > 15:
            lines.append("  … %d more (dispatch-recv shows them)" % (u["total"] - 15))
    if d.get("open_tasks"):
        ts = []
        for t in d["open_tasks"]:
            tag = t["status"]
            if t.get("ack_required") and not t.get("acked_at"):
                tag += ", ACK REQUIRED — dispatch-send %s --type ack --re %s \"...\"" % (t["from_user"], t.get("thread_id") or t["id"])
            ts.append("  %s  %s  (%s)" % (t["id"], t["title"], tag))
        lines.append("%s open task(s) assigned to %s — report progress with dispatch-send <from> --type report --state <done|continuing|waiting|blocked> --re <task id> \"...\":" % (header, handle))
        lines.extend(ts)
    if d.get("unacked_required"):
        for m in d["unacked_required"]:
            lines.append("%s message %s from %s still needs your ack: dispatch-send %s --type ack --re %s \"...\"" % (header, m["id"], m["from_user"], m["from_user"], m["id"]))
    return "\n".join(lines)


def immediate_text(d, full_ids):
    """Full text of immediate messages (first time) or a one-line reminder."""
    lines = []
    for m in d.get("immediate") or []:
        if m["id"] in full_ids:
            lines.append("[dispatch IMMEDIATE] %s from %s%s — handle this before anything else, then run %s to mark it read:" % (
                m["id"], m["from_user"], " (FORCE)" if m.get("force") else "", RECV_HINT))
            lines.append(m["body"])
            for a in m.get("attachments") or []:
                lines.append("  📎 %s" % (a.get("path") if isinstance(a, dict) else a))
        else:
            lines.append("[dispatch IMMEDIATE] %s from %s is still unread — run %s now." % (m["id"], m["from_user"], RECV_HINT))
    return "\n".join(lines)


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        inp = json.load(sys.stdin)
    except ValueError:
        inp = {}
    if not isinstance(inp, dict):
        inp = {}
    # argv wins: an async "Wait" hook is configured under the Stop event, so
    # its stdin says hook_event_name=Stop. Only fall back to the JSON field
    # when no argument was given.
    event = event or inp.get("hook_event_name") or ""
    handle, tok = D.identity()
    if not tok:
        return  # not a fleet pane — stay silent
    session_id = inp.get("session_id") or ""
    sess = D.session_for_pane(os.environ.get("TMUX_PANE", ""))
    session_name = sess["name"] if sess else None
    st = load_state(handle, session_id)

    if event == "SessionStart":
        d = digest(tok)
        st["session_start"] = (d or {}).get("server_time")
        st["turn_start"] = st["session_start"]
        st["injected"] = {}
        st["denied"] = {}
        save_state(handle, session_id, st)
        if d and (d["unread"]["total"] or d.get("open_tasks") or d.get("unacked_required")):
            out({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                       "additionalContext": digest_text(d, handle)}})
        return

    if event == "UserPromptSubmit":
        presence(tok, "busy", session_name)
        d = digest(tok)
        if d:
            st["turn_start"] = d.get("server_time")
            st["blocked_turn"] = None
        save_state(handle, session_id, st)
        if d and (d["unread"]["total"] or d.get("unacked_required")):
            out({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                       "additionalContext": digest_text(d, handle)}})
        return

    if event in ("PreToolUse", "PostToolUse"):
        d = digest(tok)
        if not d or not d.get("immediate"):
            return
        tool = inp.get("tool_name") or ""
        cmd = ""
        ti = inp.get("tool_input")
        if isinstance(ti, dict):
            cmd = str(ti.get("command") or "")
        is_recv = tool == "Bash" and "dispatch-recv" in cmd
        injected = st.setdefault("injected", {})
        denied = st.setdefault("denied", {})
        first = [m["id"] for m in d["immediate"] if m["id"] not in injected]
        if first:
            wake(tok, "hook", first, event + " immediate")
        text = immediate_text(d, set(first))
        for m in d["immediate"]:
            injected[m["id"]] = injected.get(m["id"], 0) + 1
        forced_new = [m for m in d["immediate"] if m.get("force") and m["id"] not in denied]
        save_state(handle, session_id, st)
        if event == "PreToolUse" and forced_new and not is_recv:
            for m in forced_new:
                denied[m["id"]] = time.time()
            save_state(handle, session_id, st)
            out({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "Blocked by dispatch: a FORCE-priority message must be handled first.\n" + text}})
            return
        out({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}})
        return

    if event == "Stop":
        presence(tok, "turn_end", session_name)
        if inp.get("stop_hook_active"):
            return  # we already blocked once this stop; never loop
        turn_start = st.get("turn_start")
        d = digest(tok, since=turn_start)
        if not d:
            return
        if st.get("blocked_turn") and st["blocked_turn"] == turn_start:
            return  # belt and braces: one block per turn
        by = d["unread"]["by_priority"]
        n_med_plus = by.get("medium", 0) + by.get("high", 0) + by.get("immediate", 0)
        reason = None
        if n_med_plus:
            reason = ("%d unread dispatch message(s) at medium+ priority. Run `%s --priority medium+` first, act on them, "
                      "and report to coord with dispatch-send before stopping.\n%s" % (n_med_plus, RECV_HINT, digest_text(d, handle)))
        elif d.get("open_tasks") and turn_start and d.get("reported_since") is False:
            reason = ("You hold %d open dispatch task(s) and have not sent a report this turn. Before stopping, run "
                      "`~/.dispatch/dispatch-send coord --type report --state <done|continuing|waiting|blocked> --re <task id> \"[STATE] what you did + current state\"`.\n%s"
                      % (len(d["open_tasks"]), digest_text(d, handle)))
        if reason:
            st["blocked_turn"] = turn_start
            save_state(handle, session_id, st)
            wake(tok, "hook", [i["id"] for i in d["unread"]["items"] if i["priority"] != "low"], "Stop block")
            # Documented block signal for Stop: exit 2, stderr = reason. The JSON
            # form on stdout is kept for older builds that parse it.
            out({"decision": "block", "reason": reason})
            sys.stderr.write(reason + "\n")
            sys.stderr.flush()
            sys.exit(2)
        return

    if event == "Notification":
        nt = inp.get("notification_type") or inp.get("matcher") or ""
        msg = str(inp.get("message") or "")
        if nt == "idle_prompt" or "waiting for your input" in msg.lower():
            presence(tok, "idle", session_name)
        return

    if event == "SessionEnd":
        presence(tok, "offline", session_name)
        _kill_waiter(handle, session_id)
        return

    if event == "Wait":
        wait_loop(tok, handle, session_id)
        return


def _waiter_pid_path(handle, session_id):
    return os.path.join(STATE_DIR, "%s-%s.wait.pid" % (handle, (session_id or "nosession")[:36]))


def _kill_waiter(handle, session_id):
    try:
        with open(_waiter_pid_path(handle, session_id)) as f:
            pid = int(f.read().strip() or 0)
        if pid and pid != os.getpid():
            os.kill(pid, 15)
    except (OSError, ValueError):
        pass


def wait_loop(tok, handle, session_id):
    """B′: block until a medium+ message is unread, then exit 2 with the digest."""
    total = float(os.environ.get("DISPATCH_WAIT_TOTAL_S", "600"))
    min_pri = os.environ.get("DISPATCH_WAIT_PRIORITY", "medium")
    log = os.path.join(STATE_DIR, "wait.log")
    _kill_waiter(handle, session_id)
    try:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(_waiter_pid_path(handle, session_id), "w") as f:
            f.write(str(os.getpid()))
    except OSError:
        pass

    def logln(msg):
        try:
            with open(log, "a") as f:
                f.write("%s %s %s pid=%d %s\n" % (time.strftime("%H:%M:%S"), handle, (session_id or "-")[:8], os.getpid(), msg))
        except OSError:
            pass
    logln("wait start total=%ss min=%s" % (total, min_pri))
    deadline = time.time() + total
    while time.time() < deadline:
        chunk = int(min(280, max(1, deadline - time.time())))
        try:
            st, d = D.http("GET", "/msg/wait?priority=%s%%2B&timeout=%d" % (min_pri, chunk), token=tok, timeout=chunk + 5)
        except D.DispatchError as e:
            logln("server error: %s — sleeping 10s" % e)
            time.sleep(10)
            continue
        if st != 200 or not d:
            logln("bad response %s" % st)
            time.sleep(5)
            continue
        if d.get("count"):
            dg = digest(tok) or {"unread": {"total": d["count"], "by_priority": {}, "items": []}, "open_tasks": []}
            text = digest_text(dg, handle, header="[dispatch wake]") or "[dispatch wake] %d new message(s) — run %s" % (d["count"], RECV_HINT)
            logln("message arrived (%d) -> exit 2" % d["count"])
            wake(tok, "wait-rewake", [m["id"] for m in d.get("messages") or []], "async Stop hook exit 2")
            sys.stdout.write(text + "\n")
            sys.stderr.write(text + "\n")
            sys.stdout.flush()
            sys.stderr.flush()
            sys.exit(2)
    logln("deadline reached -> exit 0")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass  # never fail the agent
    sys.exit(0)
