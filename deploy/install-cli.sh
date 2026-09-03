#!/usr/bin/env bash
# Install (or refresh) the dispatch CLI + hook into ~/.dispatch from this checkout.
# Idempotent; prints what changed. Run after every pull that touches cli/.
#   deploy/install-cli.sh            install
#   deploy/install-cli.sh --check    exit 1 if ~/.dispatch differs from cli/ (no changes made)
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/cli"
DST="${DISPATCH_HOME:-$HOME/.dispatch}"
FILES=(dispatchlib.py dispatch-send dispatch-recv dispatch-fleet dispatch-init-project dispatch-hook.py hook.sh dispatch-common.sh PROTOCOL.md)
mkdir -p "$DST"
rc=0
for f in "${FILES[@]}"; do
  [ -f "$SRC/$f" ] || continue
  if [ -f "$DST/$f" ] && cmp -s "$SRC/$f" "$DST/$f"; then
    continue
  fi
  if [ "${1:-}" = "--check" ]; then echo "STALE: $DST/$f differs from $SRC/$f"; rc=1; continue; fi
  cp -p "$SRC/$f" "$DST/$f" && echo "installed $f"
done
chmod +x "$DST"/dispatch-send "$DST"/dispatch-recv "$DST"/dispatch-fleet "$DST"/dispatch-init-project "$DST"/dispatch-hook.py "$DST"/hook.sh 2>/dev/null || true
[ "${1:-}" = "--check" ] && [ $rc -eq 0 ] && echo "~/.dispatch is up to date"
exit $rc
