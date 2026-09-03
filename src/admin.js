#!/usr/bin/env node
// Admin CLI for managing dispatch-mcp users.
// Runs directly against the SQLite DB — does not require the server to be running.

import {
  addUser,
  listUsers,
  removeUser,
  rotateUserToken,
  getUserByHandle,
  setUserPasswordHash,
  deleteTask,
  deleteAllTasks,
  pruneTasks,
  listTasks,
  listProjects,
  getProject,
  upsertProject,
  removeProject,
  setUserProject,
  handlesInProject,
  projectSummary,
  PROJECT_NAME_RE,
} from "./store.js";
import {
  registerRepo,
  unregisterRepo,
  fetchRepo,
  listRepos,
} from "./git.js";
import { hashPassword } from "./auth.js";
import { stdin, stdout } from "process";
import readline from "readline";

const [cmd, arg] = process.argv.slice(2);

// --flag value / --flag=value lookup over the whole argv (order-independent).
function flag(name) {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return i + 1 < argv.length ? argv[i + 1] : null;
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return null;
}
const hasFlag = (name) => process.argv.includes(name);
const JSON_OUT = hasFlag("--json");
function out(obj, text) {
  if (JSON_OUT) console.log(JSON.stringify(obj));
  else if (text) console.log(text);
}

function usage() {
  console.log(`Usage:

Users:
  node src/admin.js add <handle> [--project <p>] [--json]
                                             Create a user and print their bearer token
  node src/admin.js ensure <handle> [--project <p>] [--json]
                                             Create if missing, else reuse (and re-assign project if given);
                                             prints the token either way — safe to re-run
  node src/admin.js set-project <handle> <project|->
                                             Assign a user to a project (- clears); tasks are backfilled
  node src/admin.js list                     List all users
  node src/admin.js remove <handle>          Delete a user
  node src/admin.js rotate <handle>          Issue a fresh token (old one stops working)
  node src/admin.js set-password <handle>    Set or change the dashboard password
  node src/admin.js clear-password <handle>  Disable dashboard login for this user

Repos (server-side bare clones for commit verification):
  node src/admin.js add-repo <name> <url>    Register a git repo (clones bare into data/repos/)
  node src/admin.js list-repos               List all registered repos
  node src/admin.js fetch-repo <name>        git fetch origin for a registered repo
  node src/admin.js remove-repo <name>       Unregister a repo and delete its bare clone

Projects (multi-project namespace — a coordinator, its agents, a coordination/ dir):
  node src/admin.js project add <name> [--dir <coordination_dir>] [--session <tmux>] [--coordinator <handle>]
  node src/admin.js project list [--json]
  node src/admin.js project remove <name> [--force]   refuses while handles are still assigned unless --force
                                                      (--force clears their project first)

Tasks:
  node src/admin.js delete-task <id>         Delete one task by id (and its comments)
  node src/admin.js clear-tasks              Delete ALL tasks (asks to confirm; use --yes to skip)
  node src/admin.js prune-tasks <duration>   Delete closed/cancelled tasks older than <duration>.
                                              Accepts: 7d, 30d, 24h, 2w.  Add --yes to skip confirm.
`);
  process.exit(1);
}

// Read a password without echoing it. Falls back to a single-line read
// if stdin is piped (so you can do `echo pw | node admin.js set-password david`).
function promptPassword(prompt) {
  return new Promise((resolve) => {
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      // NOTE: resolve(line) MUST come before rl.close(). rl.close()
      // synchronously emits "close", and if the close handler runs
      // first it will resolve the promise to "" before we get a
      // chance to deliver the actual line.
      rl.once("line", (line) => {
        resolve(line);
        rl.close();
      });
      rl.once("close", () => resolve(""));
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const c of s) {
        if (c === "\n" || c === "\r" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          return resolve(buf);
        } else if (c === "\u0003") {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          process.exit(130);
        } else if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// Parse a simple duration like "7d", "24h", "2w" into milliseconds.
// Returns null on invalid input so callers can render a clear error.
function parseDuration(s) {
  if (!s || typeof s !== "string") return null;
  const m = /^(\d+)([hdw])$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const ms = unit === "h" ? 3600e3 : unit === "d" ? 86400e3 : 86400e3 * 7;
  return n * ms;
}

// Ask y/N at the terminal. Accepts `--yes` to skip. Piped stdin also
// counts as non-interactive — in that case, require --yes to proceed.
async function confirm(prompt) {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;
  if (!stdin.isTTY) {
    console.error("Refusing destructive action over non-tty stdin without --yes.");
    return false;
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(`${prompt} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function readNewPassword() {
  const a = await promptPassword("New password: ");
  if (a.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }
  if (stdin.isTTY) {
    const b = await promptPassword("Confirm:      ");
    if (a !== b) {
      console.error("Passwords do not match.");
      process.exit(1);
    }
  }
  return a;
}

function printClientConfig(token) {
  const port = process.env.PORT || 7900;
  console.log(`Add to this user's .claude/claude.json:\n`);
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          dispatch: {
            type: "sse",
            url: `http://YOUR_SERVER_IP:${port}/sse`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      },
      null,
      2
    )
  );
  console.log();
}

async function main() {
switch (cmd) {
  case "add": {
    if (!arg) usage();
    try {
      const project = flag("--project");
      if (project && !getProject(project)) {
        console.error(`Error: unknown project '${project}'. Create it first: node src/admin.js project add ${project} ...`);
        process.exit(1);
      }
      const { handle, token } = addUser(arg, project);
      if (JSON_OUT) { console.log(JSON.stringify({ handle, token, project: project || null, created: true })); break; }
      console.log(`\nCreated user: ${handle}${project ? ` (project ${project})` : ""}`);
      console.log(`Bearer token: ${token}\n`);
      printClientConfig(token);
    } catch (e) {
      if (e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        console.error(`Error: user "${arg}" already exists. Use 'rotate' to reissue a token.`);
      } else {
        console.error(`Error: ${e.message}`);
      }
      process.exit(1);
    }
    break;
  }

  case "ensure": {
    if (!arg) usage();
    const project = flag("--project");
    if (project && !getProject(project)) {
      console.error(`Error: unknown project '${project}'. Create it first: node src/admin.js project add ${project} ...`);
      process.exit(1);
    }
    let u = getUserByHandle(arg);
    let created = false;
    if (!u) {
      addUser(arg, project);
      u = getUserByHandle(arg);
      created = true;
    } else if (project && u.project !== project) {
      setUserProject(arg, project);
      u = getUserByHandle(arg);
    }
    out({ handle: u.handle, token: u.token, project: u.project || null, created },
      `${created ? "Created" : "Reused"} user ${u.handle}${u.project ? ` (project ${u.project})` : ""}\nBearer token: ${u.token}`);
    break;
  }

  case "set-project": {
    const [, , , handle, project] = process.argv;
    if (!handle || !project) { console.error("Usage: node src/admin.js set-project <handle> <project|->"); process.exit(1); }
    if (!getUserByHandle(handle)) { console.error(`User not found: ${handle}`); process.exit(1); }
    const p = project === "-" ? null : project;
    if (p && !getProject(p)) { console.error(`Unknown project '${p}'. Create it first: node src/admin.js project add ${p} ...`); process.exit(1); }
    setUserProject(handle, p);
    out({ handle, project: p }, `${handle} → project ${p || "(none)"}`);
    break;
  }

  case "project": {
    const sub = process.argv[3];
    const name = process.argv[4];
    if (sub === "add") {
      if (!name || !PROJECT_NAME_RE.test(name)) { console.error("Usage: node src/admin.js project add <name> [--dir D] [--session S] [--coordinator H]   (name: [a-z0-9][a-z0-9_-]*)"); process.exit(1); }
      const p = upsertProject({ name, coordination_dir: flag("--dir"), tmux_session: flag("--session"), coordinator: flag("--coordinator") });
      const warn = p.coordinator && !getUserByHandle(p.coordinator) ? ` (note: coordinator '${p.coordinator}' has no server account yet)` : "";
      out(p, `project ${p.name}: dir=${p.coordination_dir || "-"} session=${p.tmux_session || "-"} coordinator=${p.coordinator || "-"}${warn}`);
      break;
    }
    if (sub === "list") {
      const sum = projectSummary();
      if (JSON_OUT) { console.log(JSON.stringify(sum)); break; }
      if (!sum.projects.length) console.log("No projects. Add one with: node src/admin.js project add <name> --dir <coordination_dir> --session <tmux> --coordinator <handle>");
      else console.table(sum.projects.map((p) => ({ name: p.name, coordinator: p.coordinator + (p.coordinator_exists ? "" : " (no account)"), handles: p.handle_count, tmux_session: p.tmux_session, coordination_dir: p.coordination_dir })));
      if (sum.unassigned.length) console.log(`unassigned handles (no project): ${sum.unassigned.join(", ")}`);
      break;
    }
    if (sub === "remove") {
      if (!name) { console.error("Usage: node src/admin.js project remove <name> [--force]"); process.exit(1); }
      if (!getProject(name)) { console.error(`Project not found: ${name}`); process.exit(1); }
      const hs = handlesInProject(name);
      if (hs.length && !hasFlag("--force")) {
        console.error(`Refusing: ${hs.length} handle(s) still in project ${name}: ${hs.join(", ")}. Reassign them (set-project) or pass --force to clear their project.`);
        process.exit(1);
      }
      for (const h of hs) setUserProject(h, null);
      removeProject(name);
      out({ removed: name, cleared: hs }, `Removed project ${name}${hs.length ? ` (cleared project on ${hs.join(", ")})` : ""}`);
      break;
    }
    console.error("Usage: node src/admin.js project add|list|remove ...");
    process.exit(1);
  }

  case "list": {
    const users = listUsers();
    if (users.length === 0) {
      console.log("No users yet. Add one with: node src/admin.js add <handle>");
    } else {
      console.table(users);
    }
    break;
  }

  case "remove": {
    if (!arg) usage();
    const ok = removeUser(arg);
    console.log(ok ? `Removed ${arg}` : `User not found: ${arg}`);
    if (!ok) process.exit(1);
    break;
  }

  case "rotate": {
    if (!arg) usage();
    const result = rotateUserToken(arg);
    if (!result) {
      console.error(`User not found: ${arg}`);
      process.exit(1);
    }
    console.log(`\nRotated token for: ${result.handle}`);
    console.log(`New bearer token:  ${result.token}\n`);
    printClientConfig(result.token);
    break;
  }

  case "set-password": {
    if (!arg) usage();
    const user = getUserByHandle(arg);
    if (!user) {
      console.error(`User not found: ${arg}. Run 'node src/admin.js add ${arg}' first.`);
      process.exit(1);
    }
    const password = await readNewPassword();
    const hash = await hashPassword(password);
    setUserPasswordHash(arg, hash);
    console.log(`\nDashboard password set for ${arg}.`);
    console.log(`They can now sign in at http://YOUR_SERVER_IP:7900/login\n`);
    break;
  }

  case "clear-password": {
    if (!arg) usage();
    const user = getUserByHandle(arg);
    if (!user) {
      console.error(`User not found: ${arg}`);
      process.exit(1);
    }
    setUserPasswordHash(arg, null);
    console.log(`Dashboard login disabled for ${arg}. Bearer token still works for MCP.`);
    break;
  }

  case "add-repo": {
    const [, , , name, url] = process.argv;
    if (!name || !url) {
      console.error("Usage: node src/admin.js add-repo <name> <url>");
      process.exit(1);
    }
    try {
      const repo = await registerRepo(name, url);
      console.log(`\nRegistered repo: ${repo.name}`);
      console.log(`Remote:          ${repo.remote_url}`);
      console.log(`Bare clone:      ${repo.clone_path}\n`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    break;
  }

  case "list-repos": {
    const repos = listRepos();
    if (repos.length === 0) {
      console.log("No repos registered. Add one with: node src/admin.js add-repo <name> <url>");
    } else {
      console.table(
        repos.map((r) => ({
          name: r.name,
          remote: r.remote_url,
          last_fetched: r.last_fetched_at || "never",
        }))
      );
    }
    break;
  }

  case "fetch-repo": {
    if (!arg) usage();
    try {
      await fetchRepo(arg);
      console.log(`Fetched origin for ${arg}.`);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    break;
  }

  case "remove-repo": {
    if (!arg) usage();
    try {
      const ok = await unregisterRepo(arg);
      console.log(ok ? `Removed repo ${arg}` : `Repo not found: ${arg}`);
      if (!ok) process.exit(1);
    } catch (e) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    break;
  }

  case "delete-task": {
    if (!arg) usage();
    const deleted = deleteTask(arg);
    if (!deleted) {
      console.error(`Task not found: ${arg}`);
      process.exit(1);
    }
    console.log(`Deleted task ${deleted.id}: ${deleted.title}`);
    console.log(`  kind=${deleted.kind} status=${deleted.status} from=${deleted.from_user} to=${deleted.to_user || "(broadcast)"}`);
    break;
  }

  case "clear-tasks": {
    const total = listTasks({ all: true, limit: 1e9 }).length;
    if (total === 0) {
      console.log("No tasks to clear.");
      break;
    }
    console.log(`This will DELETE ALL ${total} task(s) and their comments.`);
    console.log("Users, repos, and presence will NOT be touched.");
    const ok = await confirm("Proceed?");
    if (!ok) {
      console.log("Aborted.");
      break;
    }
    const { tasks, comments } = deleteAllTasks();
    console.log(`Deleted ${tasks} task(s) and ${comments} comment(s).`);
    break;
  }

  case "prune-tasks": {
    if (!arg) {
      console.error("Usage: node src/admin.js prune-tasks <duration>   (e.g. 7d, 30d, 24h, 2w)");
      process.exit(1);
    }
    const ms = parseDuration(arg);
    if (ms === null) {
      console.error(`Invalid duration: "${arg}". Use forms like 7d, 24h, 2w.`);
      process.exit(1);
    }
    // SQLite comparison string: "YYYY-MM-DD HH:MM:SS" in UTC.
    const cutoff = new Date(Date.now() - ms).toISOString().replace("T", " ").slice(0, 19);
    console.log(`Pruning closed/cancelled tasks with updated_at < ${cutoff} (UTC)`);
    const ok = await confirm(`Delete all such tasks?`);
    if (!ok) {
      console.log("Aborted.");
      break;
    }
    const { tasks } = pruneTasks(cutoff);
    console.log(`Pruned ${tasks} task(s).`);
    break;
  }

  default:
    usage();
}
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
