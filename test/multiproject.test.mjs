// Multi-project (T-20260903-20): projects namespace, `coord` alias, per-project
// task mirror, project-scoped dashboard API.   node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let proc, base, dataDir, jwtCookie;
const tokens = {};
const dirs = {};

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function api(who, method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}
async function ui(path) {
  const r = await fetch(base + path, { headers: { cookie: jwtCookie } });
  return { status: r.status, body: await r.json() };
}
const send = (who, body) => api(who, "POST", "/msg/send", body);

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "dispatch-mp-"));
  dirs.pearl = join(dataDir, "pearl_ws", "coordination");
  dirs.x = join(dataDir, "x_ws", "coordination");
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, DISPATCH_DATA_DIR: dataDir, PORT: String(port),
    DISPATCH_TASKS_DIR: join(dataDir, "default-tasks"), DISPATCH_HANDLING_S: "2", JWT_SECRET: "test-secret-test-secret-1234",
  };
  const setup = spawn(process.execPath, ["--input-type=module", "-e", `
    import { addUser, upsertProject } from "${ROOT}/src/store.js";
    import { signJwt, JWT_COOKIE } from "${ROOT}/src/auth.js";
    upsertProject({ name: "pearl", coordination_dir: ${JSON.stringify(dirs.pearl)}, tmux_session: "pearl", coordinator: "coord" });
    upsertProject({ name: "x", coordination_dir: ${JSON.stringify(dirs.x)}, tmux_session: "x", coordinator: "coord-x" });
    upsertProject({ name: "dispatch", coordination_dir: ${JSON.stringify(dirs.pearl)}, tmux_session: "pearl", coordinator: "coord" });
    upsertProject({ name: "y", coordinator: "coord-y" }); // coordinator without an account, no dir
    const out = { tokens: {} };
    for (const [h, p] of [["coord", "pearl"], ["dev", "pearl"], ["coord-x", "x"], ["x-dev", "x"], ["dispatch-dev", "dispatch"], ["y-dev", "y"], ["user", null]]) out.tokens[h] = addUser(h, p).token;
    out.cookie = JWT_COOKIE + "=" + signJwt("user");
    console.log(JSON.stringify(out));
  `], { env, cwd: ROOT });
  let raw = "";
  setup.stdout.on("data", (d) => (raw += d));
  setup.stderr.on("data", (d) => process.stderr.write(d));
  await new Promise((res) => setup.on("exit", res));
  const parsed = JSON.parse(raw.trim().split("\n").pop());
  Object.assign(tokens, parsed.tokens);
  jwtCookie = parsed.cookie;
  proc = spawn(process.execPath, ["src/server.js"], { env, cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + "/login"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
});

after(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

test("coord alias: resolves to the sender's project coordinator; Pearl and global senders untouched", async () => {
  let r = await send("x-dev", { to: "coord", body: "[CONTINUING] x report" });
  assert.equal(r.status, 200);
  assert.equal(r.body.to, "coord-x");
  assert.equal(r.body.alias, "coord");
  assert.equal(r.body.resolved_to, "coord-x");
  const inbox = await api("coord-x", "GET", "/msg/recv");
  assert.ok(inbox.body.messages.some((m) => m.id === r.body.id && m.to_user === "coord-x"));
  const pearlInbox = await api("coord", "GET", "/msg/recv?peek=1");
  assert.ok(!pearlInbox.body.messages.some((m) => m.id === r.body.id), "Pearl coord must not receive x-dev's report");

  r = await send("dev", { to: "coord", body: "pearl report" });
  assert.equal(r.body.to, "coord");
  assert.equal(r.body.alias, undefined);
  r = await send("dispatch-dev", { to: "coord", body: "platform report" });
  assert.equal(r.body.to, "coord", "dispatch project's coordinator is Pearl's coord");
  r = await send("user", { to: "coord", body: "no project → literal coord" });
  assert.equal(r.body.to, "coord");
  await api("coord", "GET", "/msg/recv");
});

test("coord alias: a project whose coordinator has no account fails loudly instead of misrouting", async () => {
  const r = await send("y-dev", { to: "coord", body: "hello?" });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /coord-y/);
  assert.match(r.body.error, /no server account/);
});

test("tasks record the sender's project and mirror into that project's coordination/tasks/", async () => {
  let r = await send("coord", { to: "dev", type: "task", title: "Pearl task", body: "[TASK] do pearl thing" });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.project, "pearl");
  const pearlFiles = readdirSync(join(dirs.pearl, "tasks"));
  assert.ok(pearlFiles.some((f) => f.startsWith(r.body.task_id)), "mirror in pearl dir");
  // Pearl mirror format unchanged: frontmatter carries no project key
  const md = readFileSync(join(dirs.pearl, "tasks", pearlFiles.find((f) => f.startsWith(r.body.task_id))), "utf8");
  assert.ok(!/^project:/m.test(md), "no new frontmatter key in Pearl mirrors");
  assert.match(md, /^title: "Pearl task"$/m);

  r = await send("coord-x", { to: "x-dev", type: "task", title: "X task", body: "[TASK] do x thing" });
  assert.equal(r.body.task.project, "x");
  assert.ok(readdirSync(join(dirs.x, "tasks")).some((f) => f.startsWith(r.body.task_id)), "mirror in x dir");
  assert.ok(!readdirSync(join(dirs.pearl, "tasks")).some((f) => f.startsWith(r.body.task_id)), "not in pearl dir");

  // cross-project: x's coordinator assigns the platform agent → filed under x (sender's project)
  r = await send("coord-x", { to: "dispatch-dev", type: "task", title: "X asks dispatch", body: "fix something" });
  assert.equal(r.body.task.project, "x");

  // explicit override
  r = await send("coord", { to: "dev", type: "task", title: "Filed under x", body: "override", project: "x" });
  assert.equal(r.body.task.project, "x");
  assert.ok(readdirSync(join(dirs.x, "tasks")).some((f) => f.startsWith(r.body.task_id)));
  r = await send("coord", { to: "dev", type: "task", body: "bad project", project: "nope" });
  assert.equal(r.status, 404);
  assert.match(r.body.error, /unknown project 'nope'/);

  // a project without coordination_dir, and a sender without a project, fall back to DISPATCH_TASKS_DIR
  r = await send("user", { to: "y-dev", type: "task", title: "Y task", body: "y" });
  assert.equal(r.body.task.project, "y");
  assert.ok(readdirSync(join(dataDir, "default-tasks")).some((f) => f.startsWith(r.body.task_id)), "fallback dir");
  for (const h of ["dev", "x-dev", "dispatch-dev", "y-dev"]) await api(h, "GET", "/msg/recv");
});

test("/fleet and /projects expose projects; coordinator existence is reported", async () => {
  const f = await api("coord", "GET", "/fleet");
  const byHandle = Object.fromEntries(f.body.handles.map((h) => [h.handle, h.project]));
  assert.equal(byHandle["x-dev"], "x");
  assert.equal(byHandle["dispatch-dev"], "dispatch");
  assert.equal(byHandle["user"], null);
  const p = await api("coord", "GET", "/projects");
  const y = p.body.projects.find((x) => x.name === "y");
  assert.equal(y.coordinator_exists, false);
  const x = p.body.projects.find((q) => q.name === "x");
  assert.equal(x.coordinator_exists, true);
  assert.deepEqual(x.handles, ["coord-x", "x-dev"]);
  assert.equal(x.tasks_dir, join(dirs.x, "tasks"));
  assert.deepEqual(p.body.unassigned, ["user"]);
});

test("dashboard API scopes inbox / tasks / messages / decisions by ?project=", async () => {
  await send("x-dev", { to: "coord", type: "request_permission", body: "may I?" });
  await send("dev", { to: "coord", type: "request_permission", body: "pearl may I?" });
  let r = await ui("/api/inbox?project=x");
  assert.deepEqual(r.body.handles.map((h) => h.handle).sort(), ["coord-x", "x-dev"]);
  assert.ok(r.body.handles.every((h) => h.project === "x"));
  r = await ui("/api/inbox");
  assert.ok(r.body.handles.some((h) => h.handle === "user"), "all = every handle");

  r = await ui("/api/tasks?project=x");
  assert.ok(r.body.tasks.length >= 3);
  assert.ok(r.body.tasks.every((t) => t.project === "x" || t.to_user === "x-dev"));
  r = await ui("/api/tasks?project=pearl");
  assert.ok(r.body.tasks.every((t) => t.project === "pearl" || ["dev", "coord"].includes(t.to_user)));
  assert.ok(!r.body.tasks.some((t) => t.title === "X task"));

  r = await ui("/api/messages?project=x&since=");
  assert.ok(r.body.count > 0);
  assert.ok(r.body.messages.every((m) => ["coord-x", "x-dev"].includes(m.from_user) || ["coord-x", "x-dev"].includes(m.to_user)));
  r = await ui("/api/messages?project=nope");
  assert.equal(r.body.count, 0, "unknown project = empty view, not an error");

  r = await ui("/api/decisions?project=x");
  assert.equal(r.body.requests.length, 1);
  assert.equal(r.body.requests[0].from_user, "x-dev");
  r = await ui("/api/decisions");
  assert.equal(r.body.requests.length, 2);

  r = await ui("/api/projects");
  assert.ok(r.body.projects.map((p) => p.name).includes("x"));
  r = await fetch(base + "/api/tasks/mirror-all?project=x", { method: "POST", headers: { cookie: jwtCookie } }).then((x) => x.json());
  assert.ok(r.mirrored >= 3);
  assert.ok(r.tasks_dirs.includes(join(dirs.x, "tasks")));
  assert.ok(existsSync(join(dirs.x, "tasks")));
});
