// Generate ~/.dispatch/registry.json + a pm2 ecosystem of per-agent watchers
// for a given host's fleet table. Run: node deploy/deploy-fleet.mjs <host>
import db, { addUser, getUserByHandle } from "../src/store.js";
import { writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOST = process.argv[2] || "solana";
const REPO = "/var/solana/data/dispatch-mcp";
const WATCHER = `${REPO}/skills/dispatch-worktree/scripts/dispatch-watch.js`;
const PROMPT = "Run ~/.dispatch/dispatch-recv to read new dispatch message(s), act on them, then reply with ~/.dispatch/dispatch-send <who> ...";

// pane, handle, runtime — fleet tables per host
const FLEET = {
  solana: [
    ["%220","coord","claude"], ["%221","pearl-server","claude"],
    ["%224","pearl-review","codex"], ["%226","pearl-infra","claude"],
    ["%234","pearl-general","codex"], ["%235","kernel-h100","claude"],
    ["%242","kernel-400","claude"], ["%243","kernel-b200","codex"],
    ["%244","kernel-meow","codex"],
  ],
  i5: [
    ["%0","pearl-dashboard","claude"], ["%1","pearl-kernel-50","claude"],
    ["%2","pearl-miner","claude"],
  ],
};
// tmux socket dir per host (so pm2-launched watchers find the right server)
const TMUX_TMPDIR = { solana: "/var/solana/data/tmp", i5: "/tmp" };
// On i5 the server is reached over a reverse tunnel to localhost:7900
const URL = { solana: "http://127.0.0.1:7900", i5: "http://127.0.0.1:7900" };

const table = FLEET[HOST];
if (!table) { console.error("unknown host", HOST); process.exit(1); }

const registry = {};
const apps = [];
for (const [pane, handle, runtime] of table) {
  let u = getUserByHandle(handle);
  if (!u) { addUser(handle); u = getUserByHandle(handle); }
  registry[pane] = { handle, token: u.token, runtime };
  apps.push({
    name: `watch-${handle}`,
    script: WATCHER,
    interpreter: "node",
    env: {
      DISPATCH_URL: URL[HOST] + "/events",
      DISPATCH_TOKEN: u.token,
      TMUX_TARGET: pane,
      TMUX_TMPDIR: TMUX_TMPDIR[HOST],
      DISPATCH_PROMPT: PROMPT,
      DISPATCH_IDLE_POLL_MS: "1500",
      // dispatch v2 P1: low never keystroke-wakes; hooks surface it next turn.
      DISPATCH_MIN_WAKE_PRIORITY: "medium",
    },
    autorestart: true,
    max_restarts: 50,
  });
}

const cfg = join(homedir(), ".dispatch");
mkdirSync(cfg, { recursive: true });
writeFileSync(join(cfg, "registry.json"), JSON.stringify(registry, null, 2));
// fleet.json (P1): handle-keyed single source of truth. registry.json above is
// the pane-keyed compatibility view; `dispatch-fleet sync --write` regenerates
// it from fleet.json later on.
const fleet = { version: 1, generated_at: new Date().toISOString(), url: URL[HOST], tmux_tmpdir: TMUX_TMPDIR[HOST], handles: {} };
for (const [pane, handle, runtime] of table) {
  fleet.handles[handle] = { token: registry[pane].token, runtime, pane, watcher: `watch-${handle}` };
}
writeFileSync(join(cfg, "fleet.json"), JSON.stringify(fleet, null, 2) + "\n");
// watchers.<host>.cjs is DEPRECATED (2026-09-03): a one-time snapshot that drifted from the
// live fleet. Watchers are now started from fleet.json by `dispatch-fleet watchers`
// (deploy/launch-watchers.sh). The ecosystem file is no longer written.
void apps;
console.log(`registry: ${Object.keys(registry).length} panes -> ${join(cfg,"registry.json")}`);
console.log(`watchers:  dispatch-fleet watchers   (watchers.${HOST}.cjs is deprecated, not written)`);
console.log(`fleet:     ${join(cfg, "fleet.json")}`);
for (const [p,h] of table.map(t=>[t[0],t[1]])) console.log(`  ${p}  ${h}`);
