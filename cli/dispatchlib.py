#!/usr/bin/env python3
"""Shared helpers for the dispatch CLI (dispatch-send / dispatch-recv /
dispatch-fleet / dispatch-hook). Stdlib only — this runs inside hooks on a
2-second budget, so no third-party imports.

Identity resolution (first hit wins):
  1. $DISPATCH_TOKEN (+ optional $DISPATCH_HANDLE)
  2. ~/.dispatch/fleet.json   handles.<h>.pane == $TMUX_PANE
  3. ~/.dispatch/registry.json  [$TMUX_PANE] -> {handle, token}
"""
import glob
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

CFG = os.environ.get("DISPATCH_HOME") or os.path.join(os.path.expanduser("~"), ".dispatch")
PRIORITIES = ["low", "medium", "high", "immediate"]
RANK = {"low": 0, "medium": 1, "high": 2, "immediate": 3}
TYPES = ["task", "question", "request_permission", "report", "ack", "info"]
ACKS = ["yes", "no", "auto"]
STATES = ["done", "continuing", "waiting", "blocked"]


class DispatchError(Exception):
    pass


def server_url():
    u = os.environ.get("DISPATCH_URL")
    if not u:
        try:
            u = open(os.path.join(CFG, "url")).read().strip()
        except OSError:
            u = ""
    u = u or "http://127.0.0.1:7900"
    # tolerate the watcher-style ".../events" form
    if u.endswith("/events"):
        u = u[: -len("/events")]
    return u.rstrip("/")


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def load_fleet():
    return _load_json(os.path.join(CFG, "fleet.json"))


def load_registry():
    return _load_json(os.path.join(CFG, "registry.json")) or {}


def identity():
    """Return (handle, token). Either may be '' when unresolvable."""
    tok = os.environ.get("DISPATCH_TOKEN", "")
    if tok:
        return os.environ.get("DISPATCH_HANDLE", ""), tok
    pane = os.environ.get("TMUX_PANE", "")
    if not pane:
        return "", ""
    fleet = load_fleet()
    if fleet and isinstance(fleet.get("handles"), dict):
        for h, ent in fleet["handles"].items():
            if ent.get("pane") == pane and ent.get("token"):
                return h, ent["token"]
    ent = load_registry().get(pane) or {}
    return ent.get("handle", ""), ent.get("token", "")


def http(method, path, body=None, token=None, timeout=10.0):
    """JSON request. Returns (status, parsed-json-or-None). Raises
    DispatchError on transport failure (connection refused, timeout)."""
    url = server_url() + path
    data = None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise DispatchError("server unreachable at %s: %s" % (url, getattr(e, "reason", e)))
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, {"error": "non-JSON response: " + raw[:200]}


# ── spool (local append-only archive of everything ever drained) ──────

def spool_path(handle):
    return os.path.join(CFG, "spool-%s.jsonl" % (handle or "unknown"))


def spool_append(handle, msgs):
    if not msgs:
        return True
    try:
        os.makedirs(CFG, exist_ok=True)
        with open(spool_path(handle), "a", encoding="utf-8") as f:
            for m in msgs:
                f.write(json.dumps(m, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


def spool_read(handle):
    rows = []
    try:
        with open(spool_path(handle), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return rows


# ── priorities ────────────────────────────────────────────────────────

def parse_min_priority(s):
    """'high', 'high+', 'HIGH+' -> 'high'. Legacy normal/urgent accepted."""
    if not s:
        return "low"
    v = s.strip().lower().rstrip("+")
    v = {"normal": "medium", "urgent": "immediate"}.get(v, v)
    if v not in RANK:
        raise DispatchError("bad priority '%s' (use low|medium|high|immediate, optional trailing +)" % s)
    return v


# ── rendering ─────────────────────────────────────────────────────────

def _short_time(ts):
    """'2026-09-03 13:19:19+08' -> '13:19:19' if today (display zone), else the date+time."""
    if not ts:
        return ""
    try:
        today = time.strftime("%Y-%m-%d")  # host clock is in the display zone on this fleet
        if ts.startswith(today):
            return ts[11:19]
        return ts[5:16]
    except Exception:
        return ts


def flags_for(m):
    out = []
    if m.get("force"):
        out.append("[FORCE]")
    ack = m.get("ack")
    pri = m.get("priority")
    if (ack == "yes" or (ack == "auto" and pri in ("high", "immediate"))) and m.get("status") not in ("acked", "closed"):
        out.append("[ACK!]")
    if m.get("task_id"):
        out.append("[%s]" % m["task_id"])
    if m.get("re"):
        out.append("[re %s]" % m["re"])
    if m.get("state"):
        out.append("[%s]" % m["state"].upper())
    n_att = len(m.get("attachments") or [])
    if n_att:
        out.append("[%d attach]" % n_att)
    return out


def summary_line(m, width=120):
    body = " ".join((m.get("body") or "").split())
    n = len(body)
    if n > width:
        body = body[: width - 1] + "…"
    pri = m.get("priority") or "medium"
    pri_s = pri.upper() if pri in ("high", "immediate") else pri
    to = m.get("to_user") or "all"
    parts = [
        m.get("id", "?"),
        _short_time(m.get("created_at")),
        "%s→%s" % (m.get("from_user", "?"), to),
        m.get("type") or "info",
        pri_s,
    ]
    parts += flags_for(m)
    line = "  " + "  ".join(p for p in parts if p) + "  " + body
    if n > width:
        line += "  (--full %s, %d chars)" % (m.get("id"), n)
    return line


def render_full(m):
    lines = []
    hdr = "── %s  from %s → %s  <%s>  %s  @ %s" % (
        m.get("id"), m.get("from_user"), m.get("to_user") or "all",
        m.get("type") or "info", (m.get("priority") or "medium"), m.get("created_at"))
    fl = flags_for(m)
    if fl:
        hdr += "  " + " ".join(fl)
    lines.append(hdr)
    lines.append(m.get("body") or "")
    for a in m.get("attachments") or []:
        p = a.get("path") if isinstance(a, dict) else str(a)
        extra = ""
        if isinstance(a, dict) and a.get("size") is not None:
            extra = "  (%s bytes)" % a["size"]
        lines.append("  📎 %s%s" % (p, extra))
    t = m.get("task")
    if t:
        lines.append("  task %s  status=%s  ack_required=%s  acked_at=%s" % (
            t.get("id"), t.get("status"), bool(t.get("ack_required")), t.get("acked_at")))
    return "\n".join(lines)


# ── Claude Code local session registry (~/.claude/sessions/<pid>.json) ──

def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def claude_sessions():
    """Live Claude Code sessions on this host: [{name, status, pane, cwd, pid, session_id}]."""
    out = []
    for path in glob.glob(os.path.join(os.path.expanduser("~"), ".claude", "sessions", "*.json")):
        d = _load_json(path)
        if not d or not _pid_alive(d.get("pid")):
            continue
        tm = d.get("tmux") or ""
        pane = tm.rsplit(".", 1)[-1] if "." in tm else ""
        out.append({
            "name": d.get("name"),
            "status": d.get("status"),
            "pane": pane if pane.startswith("%") else "",
            "tmux": tm,
            "cwd": d.get("cwd"),
            "pid": d.get("pid"),
            "session_id": d.get("sessionId"),
            "version": d.get("version"),
        })
    return out


def session_for_pane(pane):
    if not pane:
        return None
    for s in claude_sessions():
        if s["pane"] == pane:
            return s
    return None


def sha256_file(path, limit=64 * 1024 * 1024):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        n = 0
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
            n += len(chunk)
            if n > limit:
                break
    return h.hexdigest()


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)
