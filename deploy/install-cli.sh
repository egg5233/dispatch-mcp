#!/usr/bin/env bash
# Install (or refresh) the dispatch CLI + hook into ~/.dispatch from this checkout.
# Idempotent; prints what changed. Run after every pull that touches cli/.
#   deploy/install-cli.sh            install
#   deploy/install-cli.sh --check    exit 1 if ~/.dispatch differs from cli/ (no changes made)
# Also writes $DST/repo (the checkout path, so the installed CLIs find src/admin.js and the
# watcher script) and assembles $DST/PROTOCOL.md = cli/PROTOCOL.md + $DST/PROTOCOL.local.md
# (host-local standing rules kept outside the repo; optional).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/cli"
DST="${DISPATCH_HOME:-$HOME/.dispatch}"
FILES=(dispatchlib.py dispatch-send dispatch-recv dispatch-fleet dispatch-init-project dispatch-hook.py hook.sh dispatch-common.sh)
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
mkdir -p "$DST"
rc=0
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  if [ -f "$DST/$f" ] && cmp -s "$SRC/$f" "$DST/$f"; then continue; fi
  if [ $CHECK = 1 ]; then echo "STALE: $DST/$f differs from $SRC/$f"; rc=1; continue; fi
  cp -p "$SRC/$f" "$DST/$f" && echo "installed $f"
done
# PROTOCOL.md = generic protocol + optional host-local addendum
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
cat "$SRC/PROTOCOL.md" > "$tmp"
if [ -f "$DST/PROTOCOL.local.md" ]; then printf '\n' >> "$tmp"; cat "$DST/PROTOCOL.local.md" >> "$tmp"; fi
if ! [ -f "$DST/PROTOCOL.md" ] || ! cmp -s "$tmp" "$DST/PROTOCOL.md"; then
  if [ $CHECK = 1 ]; then echo "STALE: $DST/PROTOCOL.md differs from $SRC/PROTOCOL.md (+ PROTOCOL.local.md)"; rc=1
  else cp "$tmp" "$DST/PROTOCOL.md" && echo "installed PROTOCOL.md$([ -f "$DST/PROTOCOL.local.md" ] && echo ' (+ PROTOCOL.local.md)')"; fi
fi
# checkout path for the installed CLIs
if [ $CHECK = 0 ] && [ "$(cat "$DST/repo" 2>/dev/null || true)" != "$REPO" ]; then echo "$REPO" > "$DST/repo" && echo "wrote $DST/repo -> $REPO"; fi
chmod +x "$DST"/dispatch-send "$DST"/dispatch-recv "$DST"/dispatch-fleet "$DST"/dispatch-init-project "$DST"/dispatch-hook.py "$DST"/hook.sh 2>/dev/null || true
[ $CHECK = 1 ] && [ $rc -eq 0 ] && echo "~/.dispatch is up to date"
exit $rc
