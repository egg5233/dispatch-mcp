# sourced by dispatch-send / dispatch-recv — resolves the server URL and
# this agent's bearer token (by tmux pane, falling back to env).
_dispatch_cfg="${DISPATCH_HOME:-$HOME/.dispatch}"
DISPATCH_URL="${DISPATCH_URL:-$(cat "$_dispatch_cfg/url" 2>/dev/null)}"
DISPATCH_URL="${DISPATCH_URL:-http://127.0.0.1:7900}"
_dispatch_token() {
  if [ -n "${DISPATCH_TOKEN:-}" ]; then printf '%s' "$DISPATCH_TOKEN"; return; fi
  local reg="$_dispatch_cfg/registry.json"
  if [ -n "${TMUX_PANE:-}" ] && [ -f "$reg" ]; then
    python3 -c "import json;print(json.load(open('$reg')).get('$TMUX_PANE',{}).get('token',''))" 2>/dev/null
  fi
}
