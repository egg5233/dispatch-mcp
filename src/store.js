import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "dispatch.db"));

// WAL mode for concurrent readers
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'discussion',    -- 'review' | 'work' | 'discussion'
    type TEXT NOT NULL DEFAULT 'freeform',       -- legacy, retained for backward compat
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    files TEXT NOT NULL DEFAULT '[]',
    from_user TEXT NOT NULL,
    to_user TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    result TEXT,
    verdict TEXT,                                -- 'approved' | 'changes_requested' (review kind)
    repo TEXT,                                   -- registered repo name (FK-ish to repos.name)
    base_branch TEXT,
    base_commit TEXT,
    head_branch TEXT,
    head_commit TEXT,
    pr_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_by TEXT
  );

  CREATE TABLE IF NOT EXISTS task_comments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    user TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS presence (
    user TEXT PRIMARY KEY,
    working_on TEXT,
    files TEXT NOT NULL DEFAULT '[]',
    last_seen TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    handle TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT,
    last_seen_ip TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repos (
    name TEXT PRIMARY KEY,               -- short handle, e.g. "widgets"
    remote_url TEXT NOT NULL,            -- full git URL
    clone_path TEXT NOT NULL,            -- absolute path to bare clone
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_fetched_at TEXT
  );

  -- Lightweight inter-agent messages — distinct from tasks. No worktree,
  -- no claim/complete lifecycle; just a directed (or broadcast) note that
  -- the recipient drains via my_messages. delivered_at IS NULL = unread.
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT,                        -- NULL = broadcast to everyone
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_inbox
    ON messages (to_user, delivered_at);
`);

// ── Migrations for DBs that predate the columns above ──────────────
// CREATE TABLE IF NOT EXISTS won't backfill columns on an existing table,
// so we check PRAGMA table_info and add what's missing.

function migrateColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

migrateColumn("users", "password_hash", "password_hash TEXT");
// Option E: track when each user last saw their outbound-task
// completions so we can surface them once in my_tasks / dashboard.
// Initialized to the user's created_at by the migration so existing
// users don't get hit with a wall of historical completions on first
// call — they only see things that finish AFTER this migration runs.
migrateColumn("users", "last_results_seen_at", "last_results_seen_at TEXT");
db.exec(`
  UPDATE users
     SET last_results_seen_at = datetime('now')
   WHERE last_results_seen_at IS NULL
`);
// Per-user read cursor for messages. A single delivered_at on the row
// can't model broadcasts (the first reader would consume it for everyone),
// so each user tracks how far they've read instead.
migrateColumn("users", "last_message_seen_at", "last_message_seen_at TEXT");
db.exec(`
  UPDATE users
     SET last_message_seen_at = datetime('now')
   WHERE last_message_seen_at IS NULL
`);
migrateColumn("tasks", "kind", "kind TEXT NOT NULL DEFAULT 'discussion'");
migrateColumn("tasks", "verdict", "verdict TEXT");
migrateColumn("tasks", "repo", "repo TEXT");
migrateColumn("tasks", "base_branch", "base_branch TEXT");
migrateColumn("tasks", "base_commit", "base_commit TEXT");
migrateColumn("tasks", "head_branch", "head_branch TEXT");
migrateColumn("tasks", "head_commit", "head_commit TEXT");
migrateColumn("tasks", "pr_url", "pr_url TEXT");

// Normalize legacy status value 'done' → 'closed' so the new state
// machine has a single terminal-success state.
db.exec(`UPDATE tasks SET status = 'closed' WHERE status = 'done'`);

// Active statuses = tasks that are still live (open or being worked on).
// Used by listTasks / listTasksForUser / my_tasks.
const ACTIVE_STATUSES = "('open', 'in_progress', 'pushed')";

// Prepared statements
const stmts = {
  createTask: db.prepare(`
    INSERT INTO tasks (
      id, kind, type, title, description, files,
      from_user, to_user, priority,
      repo, base_branch, base_commit, head_branch, head_commit, pr_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
  listTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ${ACTIVE_STATUSES}
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      created_at DESC
  `),
  listTasksForUser: db.prepare(`
    SELECT * FROM tasks
    WHERE (to_user = ? OR to_user IS NULL)
      AND status IN ${ACTIVE_STATUSES}
    ORDER BY created_at DESC
  `),
  listAllTasks: db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`),
  claimTask: db.prepare(`
    UPDATE tasks SET status = 'in_progress', claimed_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `),
  pushWork: db.prepare(`
    UPDATE tasks
    SET status = 'pushed',
        head_branch = ?,
        head_commit = ?,
        updated_at = datetime('now')
    WHERE id = ? AND kind = 'work' AND status = 'in_progress'
  `),
  completeTask: db.prepare(`
    UPDATE tasks SET status = 'closed', result = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  setVerdict: db.prepare(`
    UPDATE tasks SET verdict = ?, updated_at = datetime('now')
    WHERE id = ? AND kind = 'review'
  `),
  cancelTask: db.prepare(`
    UPDATE tasks SET status = 'cancelled', updated_at = datetime('now')
    WHERE id = ?
  `),
  addComment: db.prepare(`
    INSERT INTO task_comments (id, task_id, user, body) VALUES (?, ?, ?, ?)
  `),
  getComments: db.prepare(`
    SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC
  `),
  deleteTaskComments: db.prepare(`DELETE FROM task_comments WHERE task_id = ?`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id = ?`),
  deleteAllComments: db.prepare(`DELETE FROM task_comments`),
  deleteAllTasks: db.prepare(`DELETE FROM tasks`),
  // prune: closed/cancelled tasks older than the given cutoff (ISO datetime string)
  pruneTasks: db.prepare(`
    DELETE FROM tasks
    WHERE status IN ('closed', 'cancelled')
      AND updated_at < ?
  `),
  pruneTaskComments: db.prepare(`
    DELETE FROM task_comments
    WHERE task_id IN (
      SELECT id FROM tasks
      WHERE status IN ('closed', 'cancelled')
        AND updated_at < ?
    )
  `),
  countPrunable: db.prepare(`
    SELECT COUNT(*) AS n FROM tasks
    WHERE status IN ('closed', 'cancelled')
      AND updated_at < ?
  `),
  upsertPresence: db.prepare(`
    INSERT INTO presence (user, working_on, files, last_seen)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user) DO UPDATE SET
      working_on = excluded.working_on,
      files = excluded.files,
      last_seen = datetime('now')
  `),
  getPresence: db.prepare(`SELECT * FROM presence`),
  checkConflicts: db.prepare(`
    SELECT * FROM presence WHERE user != ? AND last_seen > datetime('now', '-10 minutes')
  `),
  getUserByToken: db.prepare(`SELECT * FROM users WHERE token = ?`),
  getUserByHandle: db.prepare(`SELECT * FROM users WHERE handle = ?`),
  listUsers: db.prepare(`
    SELECT handle, created_at, last_seen_at, last_seen_ip FROM users ORDER BY handle
  `),
  createUser: db.prepare(`
    INSERT INTO users (handle, token, last_message_seen_at)
    VALUES (?, ?, datetime('now'))
  `),
  deleteUser: db.prepare(`DELETE FROM users WHERE handle = ?`),
  rotateUserToken: db.prepare(`UPDATE users SET token = ? WHERE handle = ?`),
  touchUser: db.prepare(`
    UPDATE users SET last_seen_at = datetime('now'), last_seen_ip = ? WHERE handle = ?
  `),
  setPasswordHash: db.prepare(`UPDATE users SET password_hash = ? WHERE handle = ?`),
  // Option E: outbound task completions the caller hasn't yet acknowledged.
  // "Completion" = reached a terminal state (closed / cancelled) after the
  // user's last_results_seen_at. Limited to tasks where the caller is the
  // from_user (we only surface your own dispatches) and excludes broadcasts
  // the caller initiated to no one in particular.
  getRecentCompletions: db.prepare(`
    SELECT id, kind, title, from_user, to_user, status, verdict, result,
           head_branch, head_commit, pr_url, updated_at
      FROM tasks
     WHERE from_user = ?
       AND status IN ('closed', 'cancelled')
       AND updated_at > (SELECT last_results_seen_at FROM users WHERE handle = ?)
     ORDER BY updated_at ASC
  `),
  markCompletionsSeen: db.prepare(`
    UPDATE users SET last_results_seen_at = datetime('now') WHERE handle = ?
  `),
  getRepo: db.prepare(`SELECT * FROM repos WHERE name = ?`),
  listRepos: db.prepare(`SELECT * FROM repos ORDER BY name`),
  addRepo: db.prepare(`
    INSERT INTO repos (name, remote_url, clone_path) VALUES (?, ?, ?)
  `),
  removeRepo: db.prepare(`DELETE FROM repos WHERE name = ?`),
  touchRepoFetched: db.prepare(`
    UPDATE repos SET last_fetched_at = datetime('now') WHERE name = ?
  `),
  // ── Messages (lightweight inter-agent notes) ──────────────────────
  insertMessage: db.prepare(`
    INSERT INTO messages (id, from_user, to_user, body, priority)
    VALUES (?, ?, ?, ?, ?)
  `),
  // Unread = addressed to me (or broadcast), authored by someone else, and
  // newer than my read cursor. COALESCE to created_at so a freshly-added
  // user sees messages sent after they registered, not a historical wall.
  getUnreadMessages: db.prepare(`
    SELECT * FROM messages
     WHERE from_user != ?
       AND (to_user = ? OR to_user IS NULL)
       AND created_at > (
         SELECT COALESCE(last_message_seen_at, created_at)
           FROM users WHERE handle = ?
       )
     ORDER BY created_at ASC
  `),
  // Advance the cursor to a specific timestamp (the newest message just
  // drained), not datetime('now') — so a message that lands mid-drain
  // isn't skipped.
  markMessagesSeenTo: db.prepare(`
    UPDATE users SET last_message_seen_at = ? WHERE handle = ?
  `),
  getRecentMessages: db.prepare(`
    SELECT * FROM messages
     WHERE to_user = ? OR from_user = ? OR to_user IS NULL
     ORDER BY created_at DESC
     LIMIT ?
  `),
  pruneMessages: db.prepare(`
    DELETE FROM messages WHERE created_at < ?
  `),
};

export function createTask({
  kind = "discussion",
  type = "freeform",
  title,
  description = "",
  files = [],
  from_user,
  to_user = null,
  priority = "normal",
  repo = null,
  base_branch = null,
  base_commit = null,
  head_branch = null,
  head_commit = null,
  pr_url = null,
}) {
  const id = randomUUID().slice(0, 8);
  stmts.createTask.run(
    id,
    kind,
    type,
    title,
    description,
    JSON.stringify(files),
    from_user,
    to_user,
    priority,
    repo,
    base_branch,
    base_commit,
    head_branch,
    head_commit,
    pr_url
  );
  return getTask(id);
}

export function getTask(id) {
  const task = stmts.getTask.get(id);
  if (task) {
    task.files = JSON.parse(task.files);
    const comments = stmts.getComments.all(id);
    task.comments = comments;
  }
  return task;
}

export function listTasks({ user = null, all = false, limit = 50 } = {}) {
  let tasks;
  if (all) {
    tasks = stmts.listAllTasks.all(limit);
  } else if (user) {
    tasks = stmts.listTasksForUser.all(user);
  } else {
    tasks = stmts.listTasks.all();
  }
  return tasks.map((t) => ({ ...t, files: JSON.parse(t.files) }));
}

// Option E — outbound completions the user hasn't acknowledged yet.
// Returns rows without updating the "seen" timestamp. Use this for
// pure observation (dashboard polling) where you don't want to
// dismiss the badge just by polling.
export function getPendingCompletions(handle) {
  return stmts.getRecentCompletions.all(handle, handle);
}

// Option E — pull outbound completions AND advance the seen timestamp
// atomically. Use this for "I'm acknowledging these right now" actions
// (my_tasks MCP call, explicit dashboard ack button).
export function pullPendingCompletions(handle) {
  const tx = db.transaction(() => {
    const rows = stmts.getRecentCompletions.all(handle, handle);
    stmts.markCompletionsSeen.run(handle);
    return rows;
  });
  return tx();
}

// Option E — advance the seen timestamp without returning anything.
// For dashboard "dismiss" actions where the UI already has the data
// and just wants the badge cleared.
export function markCompletionsSeen(handle) {
  stmts.markCompletionsSeen.run(handle);
}

export function claimTask(id, user) {
  const result = stmts.claimTask.run(user, id);
  if (result.changes === 0) {
    const task = stmts.getTask.get(id);
    if (!task) return { error: "Task not found" };
    return { error: `Task is already ${task.status}` };
  }
  return stmts.getTask.get(id);
}

export function completeTask(id, result = "") {
  stmts.completeTask.run(result, id);
  return getTask(id);
}

export function cancelTask(id) {
  stmts.cancelTask.run(id);
  return getTask(id);
}

// Work-kind transition: records the head branch/commit once the assignee
// has pushed. The server-side git verification happens in server.js before
// this is called — this function just trusts the inputs.
export function pushWork(id, head_branch, head_commit) {
  const result = stmts.pushWork.run(head_branch, head_commit, id);
  if (result.changes === 0) {
    const task = stmts.getTask.get(id);
    if (!task) return { error: "Task not found" };
    if (task.kind !== "work") return { error: "push_work is only valid for work-kind tasks" };
    return { error: `Cannot push: task is ${task.status} (expected in_progress)` };
  }
  return getTask(id);
}

// Review-kind helper: records the verdict (approved / changes_requested).
// Typically called alongside completeTask.
export function setVerdict(id, verdict) {
  const result = stmts.setVerdict.run(verdict, id);
  if (result.changes === 0) {
    const task = stmts.getTask.get(id);
    if (!task) return { error: "Task not found" };
    if (task.kind !== "review") return { error: "Verdicts are only valid for review-kind tasks" };
  }
  return getTask(id);
}

export function addComment(taskId, user, body) {
  const id = randomUUID().slice(0, 8);
  stmts.addComment.run(id, taskId, user, body);
  return { id, task_id: taskId, user, body };
}

// ── Destructive helpers for admin CLI ──────────────────────────────
// Not exposed through any MCP tool — only src/admin.js uses these.
// Each helper cleans up task_comments before deleting the parent
// task rows, because there are no ON DELETE CASCADE constraints.

export function deleteTask(id) {
  const task = stmts.getTask.get(id);
  if (!task) return null;
  const tx = db.transaction(() => {
    stmts.deleteTaskComments.run(id);
    stmts.deleteTask.run(id);
  });
  tx();
  return task;
}

export function deleteAllTasks() {
  const countTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const countComments = db.prepare("SELECT COUNT(*) AS n FROM task_comments").get().n;
  const tx = db.transaction(() => {
    stmts.deleteAllComments.run();
    stmts.deleteAllTasks.run();
  });
  tx();
  return { tasks: countTasks, comments: countComments };
}

// Delete closed/cancelled tasks whose `updated_at` is older than the
// given cutoff. `cutoff` is an ISO datetime string (UTC) compatible
// with SQLite's `datetime()` comparisons. Returns counts.
export function pruneTasks(cutoff) {
  const prunable = stmts.countPrunable.get(cutoff).n;
  const tx = db.transaction(() => {
    stmts.pruneTaskComments.run(cutoff);
    stmts.pruneTasks.run(cutoff);
  });
  tx();
  return { tasks: prunable, cutoff };
}

// ── Messages ───────────────────────────────────────────────────────
// Lightweight directed (or broadcast) notes between agents, separate
// from the task lifecycle. send → store; my_messages → drain unread.

export function sendMessage({ from_user, to_user = null, body, priority = "normal" }) {
  const id = randomUUID().slice(0, 8);
  stmts.insertMessage.run(id, from_user, to_user, body, priority);
  return {
    id,
    from_user,
    to_user,
    body,
    priority,
    created_at: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
}

// Return unread messages for `handle` AND advance the read cursor,
// atomically. Cursor moves to the newest drained message's created_at, so
// a message arriving mid-drain is caught next time (not skipped, not
// re-shown). An empty drain leaves the cursor untouched.
export function pullUnreadMessages(handle) {
  const tx = db.transaction(() => {
    const rows = stmts.getUnreadMessages.all(handle, handle, handle);
    if (rows.length > 0) {
      // rows are ASC by created_at, so the last one is the newest.
      stmts.markMessagesSeenTo.run(rows[rows.length - 1].created_at, handle);
    }
    return rows;
  });
  return tx();
}

export function getRecentMessages(handle, limit = 50) {
  return stmts.getRecentMessages.all(handle, handle, limit);
}

export function pruneMessages(cutoff) {
  const info = stmts.pruneMessages.run(cutoff);
  return { messages: info.changes, cutoff };
}

export function updatePresence(user, workingOn = null, files = []) {
  stmts.upsertPresence.run(user, workingOn, JSON.stringify(files));
  return { user, working_on: workingOn, files };
}

export function getPresence() {
  return stmts.getPresence.all().map((p) => ({ ...p, files: JSON.parse(p.files) }));
}

export function checkConflicts(user, files = []) {
  const others = stmts.checkConflicts.all(user);
  const conflicts = [];
  for (const other of others) {
    const otherFiles = JSON.parse(other.files);
    const overlap = files.filter((f) => otherFiles.includes(f));
    if (overlap.length > 0) {
      conflicts.push({
        user: other.user,
        working_on: other.working_on,
        conflicting_files: overlap,
        last_seen: other.last_seen,
      });
    }
  }
  return conflicts;
}

// ── Users / identity ───────────────────────────────────────────────

export function getUserByToken(token) {
  if (!token) return null;
  return stmts.getUserByToken.get(token) || null;
}

export function getUserByHandle(handle) {
  return stmts.getUserByHandle.get(handle) || null;
}

export function listUsers() {
  return stmts.listUsers.all();
}

export function addUser(handle) {
  const token = `${handle}-${randomUUID()}`;
  stmts.createUser.run(handle, token);
  return { handle, token };
}

export function removeUser(handle) {
  const result = stmts.deleteUser.run(handle);
  return result.changes > 0;
}

export function rotateUserToken(handle) {
  const token = `${handle}-${randomUUID()}`;
  const result = stmts.rotateUserToken.run(token, handle);
  if (result.changes === 0) return null;
  return { handle, token };
}

export function touchUser(handle, ip) {
  stmts.touchUser.run(ip || null, handle);
}

export function setUserPasswordHash(handle, hash) {
  const result = stmts.setPasswordHash.run(hash, handle);
  return result.changes > 0;
}

// ── Repos (registered git remotes with server-side bare clones) ────

export function getRepo(name) {
  return stmts.getRepo.get(name) || null;
}

export function listRepos() {
  return stmts.listRepos.all();
}

export function addRepo(name, remoteUrl, clonePath) {
  stmts.addRepo.run(name, remoteUrl, clonePath);
  return getRepo(name);
}

export function removeRepo(name) {
  const result = stmts.removeRepo.run(name);
  return result.changes > 0;
}

export function touchRepoFetched(name) {
  stmts.touchRepoFetched.run(name);
}

// ── Settings (key/value bag for things like the JWT secret) ────────

const settingStmts = {
  get: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  set: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
};

export function getSetting(key) {
  const row = settingStmts.get.get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  settingStmts.set.run(key, value);
}

export default db;
