#!/usr/bin/env python3
"""Merge the dispatch hooks block into a Claude Code settings file, or roll it back.

  deploy/enable-hooks.py [--settings ~/.claude/settings.json] [--dry-run]
  deploy/enable-hooks.py --rollback

Merge rules: every existing hook group is kept untouched (e.g. the SessionStart
cache-heal and the PreToolUse rtk-rewrite); our groups are APPENDED to each
event's array, and never added twice (idempotent — detected by the
"$HOME/.dispatch/hook.sh" command prefix). Backup is written to a FIXED name
<settings>.bak-dispatch-hooks before the first change; --rollback restores it.
"""
import json
import os
import shutil
import sys

SETTINGS = os.path.expanduser("~/.claude/settings.json")
H = "$HOME/.dispatch/hook.sh"
BLOCK = {
    "SessionStart":     [{"hooks": [{"type": "command", "command": H + " SessionStart", "timeout": 10}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": H + " UserPromptSubmit", "timeout": 10}]}],
    "PreToolUse":       [{"hooks": [{"type": "command", "command": H + " PreToolUse", "timeout": 10}]}],
    "PostToolUse":      [{"hooks": [{"type": "command", "command": H + " PostToolUse", "timeout": 10}]}],
    "Stop":             [{"hooks": [{"type": "command", "command": H + " Stop", "timeout": 10},
                                    {"type": "command", "command": H + " Wait", "timeout": 900,
                                     "async": True, "asyncRewake": True}]}],
    "Notification":     [{"matcher": "idle_prompt",
                          "hooks": [{"type": "command", "command": H + " Notification", "timeout": 10}]}],
    "SessionEnd":       [{"hooks": [{"type": "command", "command": H + " SessionEnd", "timeout": 10}]}],
}


def is_ours(group):
    return any(str(h.get("command", "")).startswith(H) for h in group.get("hooks", []))


def main(argv):
    settings = SETTINGS
    if "--settings" in argv:
        settings = os.path.expanduser(argv[argv.index("--settings") + 1])
    backup = settings + ".bak-dispatch-hooks"
    if "--rollback" in argv:
        if not os.path.exists(backup):
            print("no backup at %s — nothing to roll back" % backup)
            return 1
        shutil.copy2(backup, settings)
        print("restored %s from %s" % (settings, backup))
        return 0
    if "--print" in argv:
        print(json.dumps({"hooks": BLOCK}, indent=2))
        return 0
    with open(settings, encoding="utf-8") as f:
        d = json.load(f)
    hooks = d.setdefault("hooks", {})
    added = []
    for ev, groups in BLOCK.items():
        cur = hooks.setdefault(ev, [])
        if any(is_ours(g) for g in cur):
            continue
        cur.extend(groups)
        added.append(ev)
    if not added:
        print("already enabled in %s — nothing to do" % settings)
        return 0
    if "--dry-run" in argv:
        print("would add %s to %s (backup would be %s)" % (", ".join(added), settings, backup))
        print(json.dumps(d.get("hooks"), indent=2))
        return 0
    if not os.path.exists(backup):
        shutil.copy2(settings, backup)
    tmp = settings + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    os.replace(tmp, settings)
    print("added %s to %s; backup at %s" % (", ".join(added), settings, backup))
    print("rollback: cp %s %s   (or: deploy/enable-hooks.py --rollback)" % (backup, settings))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
