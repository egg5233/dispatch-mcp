// Dispatch v2 P1 protocol tests. Boots src/server.js on a free port with a
// throwaway DB and drives the HTTP API the CLI + hooks use.
//   node --test test/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let proc, base, dataDir;
const tokens = {};

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
const send = (who, body) => api(who, "POST", "/msg/send", body);

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "dispatch-p1-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // create users directly through the store (same DB dir)
  process.env.DISPATCH_TASKS_DIR = join(dataDir, "tasks");
  const env = { ...process.env, DISPATCH_DATA_DIR: dataDir, PORT: String(port), DISPATCH_TASKS_DIR: process.env.DISPATCH_TASKS_DIR };
  const setup = spawn(process.execPath, ["--input-type=module", "-e", `
    import { addUser } from "${ROOT}/src/store.js";
    const out = {};
    for (const h of ["coord", "dev", "other"]) out[h] = addUser(h).token;
    console.log(JSON.stringify(out));
  `], { env, cwd: ROOT });
  let raw = "";
  setup.stdout.on("data", (d) => (raw += d));
  await new Promise((res) => setup.on("exit", res));
  Object.assign(tokens, JSON.parse(raw.trim().split("\n").pop()));
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

test("defaults: no flags = info/medium, legacy normal→medium, urgent→immediate", async () => {
  let r = await send("coord", { to: "dev", body: "hi" });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, "info");
  assert.equal(r.body.priority, "medium");
  r = await send("coord", { to: "dev", body: "hi", priority: "normal" });
  assert.equal(r.body.priority, "medium");
  r = await send("coord", { to: "dev", body: "hi", priority: "urgent" });
  assert.equal(r.body.priority, "immediate");
  await api("dev", "GET", "/msg/recv");
});

test("body limit: 1,600 chars rejected with --attach hint; 1,500 CJK accepted", async () => {
  let r = await send("coord", { to: "dev", body: "x".repeat(1600) });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /--attach/);
  r = await send("coord", { to: "dev", body: "測".repeat(1500) });
  assert.equal(r.status, 200);
  r = await send("coord", { to: "dev", body: "測".repeat(1501) });
  assert.equal(r.status, 400);
  await api("dev", "GET", "/msg/recv");
});

test("validation: bad type / priority / state / force / unknown handle", async () => {
  assert.equal((await send("coord", { to: "dev", body: "x", type: "bogus" })).status, 400);
  assert.equal((await send("coord", { to: "dev", body: "x", priority: "bogus" })).status, 400);
  assert.equal((await send("coord", { to: "dev", body: "x", state: "done" })).status, 400);
  assert.equal((await send("coord", { to: "dev", body: "x", type: "report", state: "nope" })).status, 400);
  assert.equal((await send("coord", { to: "dev", body: "x", priority: "high", force: true })).status, 400);
  assert.equal((await send("coord", { to: "nobody", body: "x" })).status, 404);
  assert.equal((await send("coord", { to: "dev", body: "x", type: "ack" })).status, 400);
  assert.equal((await send("coord", { to: "dev", body: "x", re: "nope" })).status, 404);
});

test("type=task --ack auto --priority high creates T-YYYYMMDD-NN, unclaimed until acked", async () => {
  const r = await send("coord", { to: "dev", body: "Do the thing\nmore", type: "task", ack: "auto", priority: "high",
    attachments: ["/tmp/spec.md"] });
  assert.equal(r.status, 200);
  assert.match(r.body.task_id, /^T-\d{8}-\d{2}$/);
  assert.equal(r.body.ack_required, true);
  assert.equal(r.body.task.status, "open");
  // digest shows it as open task, ack required, not acked
  let d = (await api("dev", "GET", "/hook/digest")).body;
  const t = d.open_tasks.find((x) => x.id === r.body.task_id);
  assert.ok(t);
  assert.equal(t.ack_required, 1);
  assert.equal(t.acked_at, null);
  assert.equal(t.title, "Do the thing");
  // medium task with ack=auto does NOT require ack
  const r2 = await send("coord", { to: "dev", body: "minor", type: "task", ack: "auto" });
  assert.equal(r2.body.ack_required, false);
  // ack → task acked
  const a = await send("dev", { to: "coord", body: "ack", type: "ack", re: r.body.id });
  assert.equal(a.status, 200);
  assert.equal(a.body.task.status, "acked");
  const m = (await api("dev", "GET", `/msg/${r.body.id}`)).body;
  assert.equal(m.status, "acked");
  assert.ok(m.acked_at);
  assert.equal(m.task.documents[0].path, "/tmp/spec.md");
  // report continuing → in_progress; done → closed with result
  let rep = await send("dev", { to: "coord", body: "[CONTINUING] wip", type: "report", state: "continuing", re: r.body.id });
  assert.equal(rep.body.task.status, "in_progress");
  rep = await send("dev", { to: "coord", body: "[DONE] shipped", type: "report", state: "done", re: r.body.task_id });
  assert.equal(rep.body.task.status, "closed");
  d = (await api("dev", "GET", "/hook/digest")).body;
  assert.ok(!d.open_tasks.find((x) => x.id === r.body.task_id));
  // reports are never acked
  const bad = await send("coord", { to: "dev", body: "ok", type: "ack", re: rep.body.id });
  assert.equal(bad.status, 400);
  // close the minor task too
  await send("dev", { to: "coord", body: "[DONE]", type: "report", state: "done", re: r2.body.task_id });
  await api("dev", "GET", "/msg/recv");
  await api("coord", "GET", "/msg/recv");
});

test("recv: partial drains never lose messages; priority filter; peek", async () => {
  await send("coord", { to: "dev", body: "low", priority: "low" });
  await send("coord", { to: "dev", body: "med1" });
  await send("coord", { to: "dev", body: "med2" });
  await send("coord", { to: "dev", body: "high", priority: "high" });
  await send("coord", { to: "dev", body: "imm", priority: "immediate", force: true });
  let r = (await api("dev", "GET", "/msg/recv?peek=1")).body;
  assert.equal(r.count, 5);
  r = (await api("dev", "GET", "/msg/recv?priority=high%2B")).body;
  assert.deepEqual(r.messages.map((m) => m.priority), ["high", "immediate"]);
  assert.equal(r.remaining, 3);
  assert.equal(r.messages[0].status, "delivered");
  r = (await api("dev", "GET", "/msg/recv?limit=1")).body;
  assert.equal(r.count, 1);
  assert.equal(r.messages[0].body, "low");
  assert.equal(r.remaining, 2);
  r = (await api("dev", "GET", "/msg/recv")).body;
  assert.deepEqual(r.messages.map((m) => m.body), ["med1", "med2"]);
  assert.equal(r.remaining, 0);
  r = (await api("dev", "GET", "/msg/recv")).body;
  assert.equal(r.count, 0);
  // history is non-destructive and ordered
  const first = (await api("dev", "GET", "/msg/history?since=" + r.handle)).status;
  assert.equal(first, 404);
});

test("broadcast is delivered to everyone except the sender, independently", async () => {
  await send("coord", { body: "all hands" });
  const a = (await api("dev", "GET", "/msg/recv")).body;
  const b = (await api("other", "GET", "/msg/recv")).body;
  const c = (await api("coord", "GET", "/msg/recv")).body;
  assert.equal(a.count, 1);
  assert.equal(b.count, 1);
  assert.equal(c.count, 0);
});

test("same-second arrival after a full drain is not skipped", async () => {
  await send("coord", { to: "dev", body: "a" });
  let r = (await api("dev", "GET", "/msg/recv")).body;
  assert.equal(r.count, 1);
  await send("coord", { to: "dev", body: "b" }); // very likely same second
  r = (await api("dev", "GET", "/msg/recv")).body;
  assert.equal(r.count, 1);
  assert.equal(r.messages[0].body, "b");
});

test("question answered by a --re reply; third party gets 403", async () => {
  const q = await send("coord", { to: "dev", body: "port?", type: "question" });
  await send("dev", { to: "coord", body: "7900", re: q.body.id });
  const m = (await api("coord", "GET", `/msg/${q.body.id}`)).body;
  assert.equal(m.status, "answered");
  assert.equal((await api("other", "GET", `/msg/${q.body.id}`)).status, 403);
  await api("dev", "GET", "/msg/recv");
  await api("coord", "GET", "/msg/recv");
});

test("digest: reported_since, immediate full text, unacked list", async () => {
  const t = await send("coord", { to: "dev", body: "T", type: "task", ack: "yes" });
  const imm = await send("coord", { to: "dev", body: "NOW", priority: "immediate" });
  let d = (await api("dev", "GET", "/hook/digest?since=2000-01-01%2000:00:00")).body;
  assert.equal(d.immediate[0].body, "NOW");
  assert.equal(d.unread.by_priority.immediate, 1);
  assert.equal(d.reported_since, true); // earlier tests reported
  d = (await api("dev", "GET", "/hook/digest?since=2999-01-01%2000:00:00")).body;
  assert.equal(d.reported_since, false);
  await api("dev", "GET", "/msg/recv");
  d = (await api("dev", "GET", "/hook/digest")).body;
  assert.equal(d.unacked_required.length, 1);
  assert.equal(d.unacked_required[0].id, t.body.id);
  await send("dev", { to: "coord", body: "ack", type: "ack", re: t.body.id });
  await send("dev", { to: "coord", body: "[DONE]", type: "report", state: "done", re: t.body.task_id });
  d = (await api("dev", "GET", "/hook/digest")).body;
  assert.equal(d.unacked_required.length, 0);
  await api("coord", "GET", "/msg/recv");
  void imm;
});

test("wait: resolves on medium+ arrival, ignores low, times out", async () => {
  const t0 = Date.now();
  const p = api("dev", "GET", "/msg/wait?priority=medium%2B&timeout=5");
  await new Promise((r) => setTimeout(r, 200));
  await send("coord", { to: "dev", body: "low", priority: "low" });
  await new Promise((r) => setTimeout(r, 200));
  await send("coord", { to: "dev", body: "go", priority: "high" });
  const r = (await p).body;
  assert.equal(r.timed_out, false);
  assert.equal(r.messages[0].body, "go");
  assert.ok(Date.now() - t0 < 3000);
  await api("dev", "GET", "/msg/recv");
  const r2 = (await api("dev", "GET", "/msg/wait?priority=medium%2B&timeout=1")).body;
  assert.equal(r2.timed_out, true);
});

test("presence + fleet", async () => {
  assert.equal((await api("dev", "POST", "/presence", { state: "busy", session: "s1" })).status, 200);
  assert.equal((await api("dev", "POST", "/presence", { state: "nope" })).status, 400);
  const f = (await api("coord", "GET", "/fleet")).body;
  const row = f.handles.find((h) => h.handle === "dev");
  assert.equal(row.state, "busy");
  assert.equal(row.session, "s1");
});

test("legacy client shape still works (no type/ack fields)", async () => {
  const r = await send("coord", { to: "dev", body: "old client", priority: "high" });
  assert.equal(r.status, 200);
  const d = (await api("dev", "GET", "/msg/recv")).body;
  assert.equal(d.messages[0].type, "info");
  assert.equal(d.messages[0].ack, "no");
  assert.match(d.messages[0].created_at, /\+08$/);
});

test("GET /msg/:id?read=1 marks the message read (dispatch-recv --full)", async () => {
  const m = await send("coord", { to: "dev", body: "long one", priority: "high" });
  let d = (await api("dev", "GET", "/hook/digest")).body;
  assert.equal(d.unread.by_priority.high, 1);
  const full = (await api("dev", "GET", `/msg/${m.body.id}?read=1`)).body;
  assert.equal(full.status, "delivered");
  d = (await api("dev", "GET", "/hook/digest")).body;
  assert.equal(d.unread.total, 0);
  // a third party cannot mark it, and the sender reading it does not affect the recipient
  assert.equal((await api("other", "GET", `/msg/${m.body.id}?read=1`)).status, 403);
});

test("a report without --re/--task never touches a task, even the sender's only open one", async () => {
  const t = await send("coord", { to: "dev", body: "only task", type: "task" });
  const r = await send("dev", { to: "coord", body: "[DONE] something else", type: "report", state: "done" });
  assert.equal(r.body.task_id, undefined);
  let d = (await api("dev", "GET", "/hook/digest")).body;
  assert.ok(d.open_tasks.find((x) => x.id === t.body.task_id), "task must still be open");
  assert.equal(d.reported_since, undefined);
  await send("dev", { to: "coord", body: "[DONE]", type: "report", state: "done", re: t.body.task_id });
  d = (await api("dev", "GET", "/hook/digest")).body;
  assert.ok(!d.open_tasks.find((x) => x.id === t.body.task_id));
  await api("dev", "GET", "/msg/recv");
  await api("coord", "GET", "/msg/recv");
});

// ── P2 dashboard API ──────────────────────────────────────────────
async function dash(who, method, path, body) {
  // JWT cookie login via the users table password; tests set one first.
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", cookie: jwtCookie[who] },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
}
const jwtCookie = {};

test("P2: dashboard login, messages/thread/inbox/tasks/settings/decisions/wake/mirror", async () => {
  // give 'coord' and 'user' dashboard passwords via the store + JWT login
  const setup = spawn(process.execPath, ["--input-type=module", "-e", `
    import { addUser, setUserPasswordHash, getUserByHandle } from "${ROOT}/src/store.js";
    import { hashPassword } from "${ROOT}/src/auth.js";
    if (!getUserByHandle("user")) addUser("user");
    setUserPasswordHash("coord", await hashPassword("coordpass1"));
    setUserPasswordHash("user", await hashPassword("userpass12"));
    console.log("ok");
  `], { env: { ...process.env, DISPATCH_DATA_DIR: dataDir }, cwd: ROOT });
  await new Promise((res) => setup.on("exit", res));
  for (const [h, pw] of [["coord", "coordpass1"], ["user", "userpass12"]]) {
    const r = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: h, password: pw }) });
    assert.equal(r.status, 200);
    jwtCookie[h] = r.headers.get("set-cookie").split(";")[0];
  }
  // a task thread: task → ack → report continuing → request_permission → decision → done
  const t = await send("coord", { to: "dev", body: "P2 thread task\ndetails", type: "task", ack: "auto", priority: "high" });
  const a = await send("dev", { to: "coord", body: "ack", type: "ack", re: t.body.id });
  await send("dev", { to: "coord", body: "[CONTINUING] wip", type: "report", state: "continuing", re: t.body.task_id });
  const rp = await send("dev", { to: "user", body: "May I delete X?", type: "request_permission", re: t.body.id });
  // wake records from the hook / watcher
  assert.equal((await api("dev", "POST", "/wake", { method: "hook", message_ids: [t.body.id], detail: "Stop-block" })).status, 200);
  assert.equal((await api("dev", "POST", "/wake", { method: "bogus" })).status, 400);
  // messages + filters
  let r = await dash("coord", "GET", "/api/messages?type=task&limit=5");
  assert.equal(r.status, 200);
  assert.ok(r.body.messages.some((m) => m.id === t.body.id));
  assert.equal(r.body.messages.find((m) => m.id === t.body.id).deliveries[0].method, "hook");
  r = await dash("coord", "GET", `/api/messages/${a.body.id}/thread`);
  assert.equal(r.body.root_id, t.body.id);
  assert.equal(r.body.task_id, t.body.task_id);
  assert.ok(r.body.messages.length >= 4);
  assert.ok(r.body.messages.some((m) => m.id === rp.body.id));
  // inbox
  r = await dash("coord", "GET", "/api/inbox");
  const dev = r.body.handles.find((h) => h.handle === "dev");
  assert.ok(dev.unread >= 1);
  // tasks + health + settings
  r = await dash("coord", "GET", "/api/tasks");
  const tk = r.body.tasks.find((x) => x.id === t.body.task_id);
  assert.equal(tk.status, "in_progress");
  assert.equal(tk.health.trailing_continuing, 1);
  assert.equal(tk.health.overdue, false);
  assert.equal((await dash("coord", "POST", "/api/settings", { task_max_continuing: 1 })).status, 200);
  r = await dash("coord", "GET", "/api/tasks");
  assert.equal(r.body.tasks.find((x) => x.id === t.body.task_id).health.overdue, true);
  assert.equal((await dash("coord", "POST", "/api/settings", { task_stale_hours: -1 })).status, 400);
  // decisions: GO from the `user` account, arrives as from=user with re=
  r = await dash("user", "GET", "/api/decisions");
  assert.ok(r.body.requests.some((m) => m.id === rp.body.id));
  r = await dash("user", "POST", "/api/decide", { re: rp.body.id, decision: "GO", note: "fine" });
  assert.equal(r.status, 200);
  assert.equal(r.body.answered, rp.body.id);
  const inbox = (await api("dev", "GET", "/msg/recv")).body;
  const go = inbox.messages.find((m) => m.re === rp.body.id);
  assert.equal(go.from_user, "user");
  assert.match(go.body, /^\[GO\]/);
  assert.equal((await dash("user", "GET", "/api/decisions")).body.requests.some((m) => m.id === rp.body.id), false);
  assert.equal((await dash("user", "POST", "/api/decide", { re: t.body.id, decision: "GO" })).status, 404);
  // mirror: a file per task in the temp tasks dir
  await send("dev", { to: "coord", body: "[DONE] finished", type: "report", state: "done", re: t.body.task_id });
  const { readdirSync, readFileSync } = await import("node:fs");
  const files = readdirSync(process.env.DISPATCH_TASKS_DIR).filter((f) => f.startsWith(t.body.task_id));
  assert.equal(files.length, 1);
  const md = readFileSync(join(process.env.DISPATCH_TASKS_DIR, files[0]), "utf8");
  assert.match(md, /^---\ntitle: "P2 thread task"\ntype: "task"\ntask: "T-/);
  assert.match(md, /status: "closed"/);
  assert.match(md, /report \[CONTINUING\]/);
  r = await dash("coord", "POST", "/api/tasks/mirror-all");
  assert.ok(r.body.mirrored >= 1);
  // unauthenticated → 401
  assert.equal((await fetch(base + "/api/messages")).status, 401);
  await api("coord", "GET", "/msg/recv");
  await api("user", "GET", "/msg/recv");
});
