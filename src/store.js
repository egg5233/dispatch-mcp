import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import { localDateStamp, utcNow } from "./tz.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DISPATCH_DATA_DIR lets tests (and a staging copy) point at another DB.
const DATA_DIR = process.env.DISPATCH_DATA_DIR || join(__dirname, "..", "data");
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

  -- Per-recipient read set (dispatch v2 P1). The users.last_message_seen_at
  -- cursor alone forced /msg/recv to drain the WHOLE backlog in one go
  -- (a --limit could only hide, never defer). With an explicit read set a
  -- drain can be partial (limit / min-priority) and whatever it did not
  -- return simply stays unread on the server. The cursor is kept as a
  -- lower bound so the read set stays small: once a drain returns
  -- everything, the cursor advances and older read rows are pruned.
  -- Delivery / wake records (dispatch v2 P2). Written by whoever surfaced a
  -- message: the hook (digest / immediate injection / Stop block), the async
  -- Wait rewake, the keystroke watcher (fired or blocked), or the CLI when it
  -- printed the SendMessage hint. Lets the dashboard show HOW a message got
  -- to its agent, and why it did not.
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT,
    handle TEXT NOT NULL,
    method TEXT NOT NULL,           -- hook | wait-rewake | keystroke | blocked | native-hint | recv
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deliveries_msg ON deliveries (message_id);

  CREATE TABLE IF NOT EXISTS message_reads (
    handle TEXT NOT NULL,
    message_id TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (handle, message_id)
  );
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

// ── dispatch v2 P1 (2026-09-03): typed messages + task linkage ─────
// messages: type / ack / threading / lifecycle
migrateColumn("messages", "type", "type TEXT NOT NULL DEFAULT 'info'");
migrateColumn("messages", "ack", "ack TEXT NOT NULL DEFAULT 'no'");
migrateColumn("messages", "re", "re TEXT");
migrateColumn("messages", "task_id", "task_id TEXT");
migrateColumn("messages", "state", "state TEXT");
migrateColumn("messages", "attachments", "attachments TEXT NOT NULL DEFAULT '[]'");
migrateColumn("messages", "status", "status TEXT NOT NULL DEFAULT 'queued'");
migrateColumn("messages", "acked_at", "acked_at TEXT");
migrateColumn("messages", "closed_at", "closed_at TEXT");
// `force` is not in the spec's column list but §4 needs it: only a sender
// who explicitly passed --force gets the PreToolUse *deny* treatment.
migrateColumn("messages", "force", "force INTEGER NOT NULL DEFAULT 0");
// tasks: ack tracking + documents + the message thread that spawned it
migrateColumn("tasks", "ack_required", "ack_required INTEGER NOT NULL DEFAULT 0");
migrateColumn("tasks", "acked_at", "acked_at TEXT");
migrateColumn("tasks", "documents", "documents TEXT NOT NULL DEFAULT '[]'");
migrateColumn("tasks", "thread_id", "thread_id TEXT");
// presence: hook-reported turn state (busy / turn_end / idle / offline)
migrateColumn("presence", "state", "state TEXT");
migrateColumn("presence", "state_at", "state_at TEXT");
migrateColumn("presence", "session", "session TEXT");

// Priority vocabulary is now low | medium | high | immediate. Legacy rows
// used normal / urgent; map them once so ORDER BY and filters stay simple.
db.exec(`UPDATE messages SET priority = 'medium'    WHERE priority = 'normal'`);
db.exec(`UPDATE messages SET priority = 'immediate' WHERE priority = 'urgent'`);
db.exec(`UPDATE tasks    SET priority = 'medium'    WHERE priority = 'normal'`);
db.exec(`UPDATE tasks    SET priority = 'immediate' WHERE priority = 'urgent'`);

// One-time backfill for rows that predate `status`: anything at or before a
// recipient's read cursor was already drained → delivered. Broadcasts are
// marked delivered too (no per-recipient truth exists for them pre-P1).
// Guarded by a settings flag so it runs exactly once.
{
  const flag = db.prepare(`SELECT value FROM settings WHERE key = 'migr_p1_msg_status'`).get();
  if (!flag) {
    db.exec(`
      UPDATE messages SET status = 'delivered', delivered_at = COALESCE(delivered_at, created_at)
       WHERE status = 'queued'
         AND (
           to_user IS NULL
           OR created_at <= (SELECT last_message_seen_at FROM users WHERE handle = messages.to_user)
         );
    `);
    // The unread query now uses created_at >= cursor (see getUnreadMessages)
    // so a message sharing the cursor's second can't be skipped. Seed the
    // read set with rows sitting exactly ON each cursor so they aren't
    // re-delivered once.
    db.exec(`
      INSERT OR IGNORE INTO message_reads (handle, message_id)
      SELECT u.handle, m.id FROM users u JOIN messages m
        ON m.created_at = u.last_message_seen_at
       AND m.from_user != u.handle
       AND (m.to_user = u.handle OR m.to_user IS NULL);
    `);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('migr_p1_msg_status', datetime('now'))`).run();
  }
}

// Normalize legacy status value 'done' → 'closed' so the new state
// machine has a single terminal-success state.
db.exec(`UPDATE tasks SET status = 'closed' WHERE status = 'done'`);

// One-time: T-* tasks created before --title existed got "[TASK] …" bodies
// cut at 80 chars as their title. Re-derive with the current rule.
{
  const flag = db.prepare(`SELECT value FROM settings WHERE key = 'migr_p2_task_titles'`).get();
  if (!flag) {
    const rows = db.prepare(`SELECT id, description FROM tasks WHERE id LIKE 'T-%'`).all();
    const upd = db.prepare(`UPDATE tasks SET title = ? WHERE id = ?`);
    for (const r of rows) upd.run(deriveTaskTitle(r.description), r.id);
    db.prepare(`INSERT INTO settings (key, value) VALUES ('migr_p2_task_titles', datetime('now'))`).run();
  }
}

// Active statuses = tasks that are still live (open or being worked on).
// Used by listTasks / listTasksForUser / my_tasks.
// P1 adds acked / waiting / blocked (report states) to the live set.
const ACTIVE_STATUSES = "('open', 'acked', 'in_progress', 'pushed', 'waiting', 'blocked')";

// Priority vocabulary + rank (higher = more urgent). Legacy values map onto
// the new ones so old clients keep working.
export const PRIORITIES = ["low", "medium", "high", "immediate"];
export const PRIORITY_RANK = { low: 0, medium: 1, high: 2, immediate: 3 };
export function normalizePriority(p) {
  if (p === undefined || p === null || p === "") return "medium";
  const v = String(p).toLowerCase();
  if (v === "normal") return "medium";
  if (v === "urgent") return "immediate";
  return PRIORITIES.includes(v) ? v : null;
}
// SQL fragment ranking a priority column (unknown → medium).
const PRIO_CASE = `CASE priority WHEN 'immediate' THEN 3 WHEN 'urgent' THEN 3 WHEN 'high' THEN 2
  WHEN 'low' THEN 0 ELSE 1 END`;

export const MESSAGE_TYPES = ["task", "question", "request_permission", "report", "ack", "info"];
export const ACK_MODES = ["yes", "no", "auto"];
export const REPORT_STATES = ["done", "continuing", "waiting", "blocked"];
export const MESSAGE_STATUSES = ["queued", "delivered", "acked", "answered", "closed"];
export const BODY_MAX_CHARS = parseInt(process.env.DISPATCH_BODY_MAX || "1500", 10);

// Prepared statements
const stmts = {
  createTask: db.prepare(`
    INSERT INTO tasks (
      id, kind, type, title, description, files,
      from_user, to_user, priority,
      repo, base_branch, base_commit, head_branch, head_commit, pr_url,
      ack_required, documents, thread_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  lastTaskIdForDay: db.prepare(`
    SELECT id FROM tasks WHERE id LIKE ? ORDER BY id DESC LIMIT 1
  `),
  ackTask: db.prepare(`
    UPDATE tasks
       SET acked_at = COALESCE(acked_at, datetime('now')),
           status = CASE WHEN status = 'open' THEN 'acked' ELSE status END,
           claimed_by = COALESCE(claimed_by, ?),
           updated_at = datetime('now')
     WHERE id = ?
  `),
  setTaskStatus: db.prepare(`
    UPDATE tasks
       SET status = ?, claimed_by = COALESCE(claimed_by, ?), updated_at = datetime('now')
     WHERE id = ?
  `),
  openTasksFor: db.prepare(`
    SELECT id, kind, type, title, from_user, to_user, status, priority, ack_required,
           acked_at, claimed_by, thread_id, created_at, updated_at
      FROM tasks
     WHERE (to_user = ? OR claimed_by = ?)
       AND status IN ${ACTIVE_STATUSES}
     ORDER BY ${PRIO_CASE} DESC, created_at ASC
  `),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id = ?`),
  listTasks: db.prepare(`
    SELECT * FROM tasks
    WHERE status IN ${ACTIVE_STATUSES}
    ORDER BY ${PRIO_CASE} DESC, created_at DESC
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
    WHERE id = ? AND status IN ('open', 'acked')
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
  // Hook-reported turn state. Does not touch working_on/files.
  upsertPresenceState: db.prepare(`
    INSERT INTO presence (user, working_on, files, last_seen, state, state_at, session)
    VALUES (?, NULL, '[]', datetime('now'), ?, datetime('now'), ?)
    ON CONFLICT(user) DO UPDATE SET
      state = excluded.state,
      state_at = datetime('now'),
      session = COALESCE(excluded.session, presence.session),
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
  // ── Messages (typed inter-agent notes, dispatch v2 P1) ────────────
  insertMessage: db.prepare(`
    INSERT INTO messages (id, from_user, to_user, body, priority,
                          type, ack, re, task_id, state, attachments, force)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  // Unread = addressed to me (or broadcast), authored by someone else, at or
  // after my cursor, and not in my read set. Ordered oldest-first; the
  // optional min-priority rank filter is what makes `--priority high+` a
  // real partial drain rather than a display trick.
  getUnreadMessages: db.prepare(`
    SELECT * FROM messages m
     WHERE m.from_user != ?
       AND (m.to_user = ? OR m.to_user IS NULL)
       AND m.created_at >= (
         SELECT COALESCE(last_message_seen_at, created_at) FROM users WHERE handle = ?
       )
       AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.handle = ? AND r.message_id = m.id)
       AND (${PRIO_CASE.replace(/priority/g, "m.priority")}) >= ?
     ORDER BY m.created_at ASC, m.rowid ASC
  `),
  markRead: db.prepare(`
    INSERT OR IGNORE INTO message_reads (handle, message_id) VALUES (?, ?)
  `),
  markDelivered: db.prepare(`
    UPDATE messages SET status = 'delivered', delivered_at = datetime('now')
     WHERE id = ? AND status = 'queued'
  `),
  markMessagesSeenTo: db.prepare(`
    UPDATE users SET last_message_seen_at = ? WHERE handle = ?
  `),
  pruneReadsBelow: db.prepare(`
    DELETE FROM message_reads
     WHERE handle = ?
       AND message_id IN (SELECT id FROM messages WHERE created_at < ?)
  `),
  setMessageStatus: db.prepare(`
    UPDATE messages
       SET status = ?,
           acked_at  = CASE WHEN ? = 'acked'  THEN datetime('now') ELSE acked_at  END,
           closed_at = CASE WHEN ? = 'closed' THEN datetime('now') ELSE closed_at END
     WHERE id = ?
  `),
  getRecentMessages: db.prepare(`
    SELECT * FROM messages
     WHERE to_user = ? OR from_user = ? OR to_user IS NULL
     ORDER BY created_at DESC
     LIMIT ?
  `),
  // History after a given message (by that message's created_at/rowid),
  // for `dispatch-recv --since <id>`. Non-destructive.
  historyAfter: db.prepare(`
    SELECT m.* FROM messages m, (SELECT created_at, rowid AS r FROM messages WHERE id = ?) a
     WHERE (m.to_user = ? OR m.from_user = ? OR m.to_user IS NULL)
       AND (m.created_at > a.created_at OR (m.created_at = a.created_at AND m.rowid > a.r))
     ORDER BY m.created_at ASC, m.rowid ASC
     LIMIT ?
  `),
  lastReportAt: db.prepare(`
    SELECT MAX(created_at) AS t FROM messages WHERE from_user = ? AND type = 'report'
  `),
  // ack-required messages delivered to me that nobody has acked yet
  unackedRequired: db.prepare(`
    SELECT id, from_user, type, priority, created_at, task_id, substr(body, 1, 120) AS summary
      FROM messages
     WHERE to_user = ?
       AND status = 'delivered'
       AND (ack = 'yes' OR (ack = 'auto' AND priority IN ('high', 'immediate')))
     ORDER BY created_at ASC
  `),
  // Fleet overview: per-handle unread depth + oldest unread (broadcasts
  // are counted for everyone but the sender).
  inboxDepth: db.prepare(`
    SELECT COUNT(*) AS n, MIN(m.created_at) AS oldest,
           SUM(CASE WHEN m.priority IN ('high', 'immediate') THEN 1 ELSE 0 END) AS high_plus
      FROM messages m
     WHERE m.from_user != ?
       AND (m.to_user = ? OR m.to_user IS NULL)
       AND m.created_at >= (
         SELECT COALESCE(last_message_seen_at, created_at) FROM users WHERE handle = ?
       )
       AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.handle = ? AND r.message_id = m.id)
  `),
  pruneMessages: db.prepare(`
    DELETE FROM messages WHERE created_at < ?
  `),
  // ── P2 dashboard ──
  insertDelivery: db.prepare(`
    INSERT INTO deliveries (message_id, handle, method, detail) VALUES (?, ?, ?, ?)
  `),
  deliveriesFor: db.prepare(`
    SELECT message_id, handle, method, detail, created_at FROM deliveries
     WHERE message_id = ? ORDER BY created_at ASC, id ASC
  `),
  recentDeliveries: db.prepare(`
    SELECT message_id, handle, method, detail, created_at FROM deliveries
     WHERE created_at >= ? ORDER BY created_at ASC, id ASC
  `),
  childrenOf: db.prepare(`SELECT * FROM messages WHERE re = ? ORDER BY created_at ASC, rowid ASC`),
  byTask: db.prepare(`SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC, rowid ASC`),
  reportsForTask: db.prepare(`
    SELECT id, from_user, state, created_at, substr(body, 1, 200) AS summary
      FROM messages WHERE task_id = ? AND type = 'report'
     ORDER BY created_at ASC, rowid ASC
  `),
  openRequests: db.prepare(`
    SELECT * FROM messages
     WHERE type = 'request_permission' AND status IN ('queued', 'delivered')
     ORDER BY created_at ASC
  `),
  allTasksRecent: db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`),
};

// Human-facing task id: T-YYYYMMDD-NN (date in the display zone, NN = per-day
// sequence). Overflows to three digits past 99 rather than failing.
export function nextTaskId(date = new Date()) {
  const day = localDateStamp(date);
  const last = stmts.lastTaskIdForDay.get(`T-${day}-%`);
  let n = 1;
  if (last) {
    const m = /-(\d+)$/.exec(last.id);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `T-${day}-${String(n).padStart(2, "0")}`;
}

export function createTask({
  id = null,
  kind = "discussion",
  type = "freeform",
  title,
  description = "",
  files = [],
  from_user,
  to_user = null,
  priority = "medium",
  repo = null,
  base_branch = null,
  base_commit = null,
  head_branch = null,
  head_commit = null,
  pr_url = null,
  ack_required = 0,
  documents = [],
  thread_id = null,
}) {
  const taskId = id || randomUUID().slice(0, 8);
  stmts.createTask.run(
    taskId,
    kind,
    type,
    title,
    description,
    JSON.stringify(files),
    from_user,
    to_user,
    normalizePriority(priority) || "medium",
    repo,
    base_branch,
    base_commit,
    head_branch,
    head_commit,
    pr_url,
    ack_required ? 1 : 0,
    JSON.stringify(documents || []),
    thread_id
  );
  return getTask(taskId);
}

// Title for a task created from a message: an explicit --title wins;
// otherwise the first non-empty body line with a leading "[TASK]"-style tag
// removed, cut to 80 characters (code points).
export function deriveTaskTitle(body, explicit = null) {
  const cut = (str, n) => { const cps = [...str]; return cps.length > n ? cps.slice(0, n - 1).join("") + "…" : str; };
  if (explicit && String(explicit).trim()) return cut(String(explicit).trim(), 80);
  let line = (body || "").split("\n").find((l) => l.trim()) || "(untitled)";
  line = line.trim().replace(/^(\[[A-Za-z0-9_\- ]+\]\s*)+/, "").trim() || line.trim();
  return cut(line, 80);
}

// Task spawned by a type=task message. The message id becomes thread_id so
// replies with --re <msg id> resolve back to the task.
export function createTaskFromMessage(msg, explicitTitle = null) {
  const title = deriveTaskTitle(msg.body, explicitTitle);
  const ackRequired =
    msg.ack === "yes" || (msg.ack === "auto" && (msg.priority === "high" || msg.priority === "immediate"));
  // Retry once on a same-second id collision (two senders in the same tick).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return createTask({
        id: nextTaskId(),
        kind: "discussion",
        type: "task",
        title,
        description: msg.body,
        from_user: msg.from_user,
        to_user: msg.to_user,
        priority: msg.priority,
        ack_required: ackRequired,
        documents: Array.isArray(msg.attachments)
          ? msg.attachments
          : JSON.parse(msg.attachments || "[]"),
        thread_id: msg.id,
      });
    } catch (e) {
      if (e.code !== "SQLITE_CONSTRAINT_PRIMARYKEY" || attempt === 2) throw e;
    }
  }
  return null;
}

export function ackTask(id, by) {
  stmts.ackTask.run(by, id);
  return getTask(id);
}

// Report-state → task status mapping. `done` closes with the report body
// as the result; the others are live statuses the P2 board will render.
export function applyReportState(id, state, by, result = "") {
  const task = stmts.getTask.get(id);
  if (!task) return null;
  if (state === "done") {
    stmts.completeTask.run(result, id);
  } else if (state === "continuing") {
    stmts.setTaskStatus.run("in_progress", by, id);
  } else if (state === "waiting" || state === "blocked") {
    stmts.setTaskStatus.run(state, by, id);
  }
  return getTask(id);
}

export function getOpenTasksFor(handle) {
  return stmts.openTasksFor.all(handle, handle);
}

export function getTask(id) {
  const task = stmts.getTask.get(id);
  if (task) {
    task.files = JSON.parse(task.files);
    try { task.documents = JSON.parse(task.documents || "[]"); } catch { task.documents = []; }
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
// Typed directed (or broadcast) notes between agents. send → store;
// pull → drain (partial drains allowed); peek → look without consuming.

export function sendMessage({
  from_user,
  to_user = null,
  body,
  priority = "medium",
  type = "info",
  ack = "no",
  re = null,
  task_id = null,
  state = null,
  attachments = [],
  force = 0,
}) {
  const id = randomUUID().slice(0, 8);
  stmts.insertMessage.run(
    id,
    from_user,
    to_user,
    body,
    normalizePriority(priority) || "medium",
    type,
    ack,
    re,
    task_id,
    state,
    JSON.stringify(attachments || []),
    force ? 1 : 0
  );
  return getMessage(id);
}

export function getMessage(id) {
  const m = stmts.getMessage.get(id);
  if (!m) return null;
  try { m.attachments = JSON.parse(m.attachments || "[]"); } catch { m.attachments = []; }
  return m;
}

function parseAttachments(rows) {
  for (const m of rows) {
    try { m.attachments = JSON.parse(m.attachments || "[]"); } catch { m.attachments = []; }
  }
  return rows;
}

function unreadRows(handle, minPriority = "low") {
  const rank = PRIORITY_RANK[minPriority] ?? 0;
  return stmts.getUnreadMessages.all(handle, handle, handle, handle, rank);
}

// Look at unread messages WITHOUT consuming them (hooks, /msg/wait).
export function peekUnreadMessages(handle, { minPriority = "low", limit = 0 } = {}) {
  const rows = unreadRows(handle, minPriority);
  return parseAttachments(limit > 0 ? rows.slice(0, limit) : rows);
}

export function countUnread(handle) {
  const rows = unreadRows(handle, "low");
  const by = { low: 0, medium: 0, high: 0, immediate: 0 };
  for (const r of rows) by[r.priority] = (by[r.priority] || 0) + 1;
  return { total: rows.length, by_priority: by };
}

// Drain unread messages for `handle`, atomically. A partial drain (limit or
// min-priority) marks only the returned rows read; the rest stay unread on
// the server — nothing is ever silently consumed. When a drain returns the
// whole backlog the cursor advances to the newest row and older read rows
// are pruned so message_reads stays small. Returns { messages, remaining }.
export function pullUnreadMessages(handle, { minPriority = "low", limit = 0 } = {}) {
  const tx = db.transaction(() => {
    const all = unreadRows(handle, minPriority);
    const rows = limit > 0 ? all.slice(0, limit) : all;
    for (const r of rows) {
      stmts.markRead.run(handle, r.id);
      if (stmts.markDelivered.run(r.id).changes > 0) {
        r.status = "delivered";
        r.delivered_at = utcNow();
      }
    }
    const drainedEverything = rows.length === all.length && minPriority === "low";
    if (drainedEverything && rows.length > 0) {
      const newest = rows[rows.length - 1].created_at;
      stmts.markMessagesSeenTo.run(newest, handle);
      stmts.pruneReadsBelow.run(handle, newest);
    }
    const remaining = drainedEverything ? 0 : unreadRows(handle, "low").length;
    return { messages: parseAttachments(rows), remaining };
  });
  return tx();
}

// Mark one message read for `handle` (used by GET /msg/:id?read=1 so that
// reading a message in full also clears it from the unread set).
export function markMessageRead(handle, id) {
  const m = stmts.getMessage.get(id);
  if (!m || m.from_user === handle || (m.to_user && m.to_user !== handle)) return false;
  stmts.markRead.run(handle, id);
  stmts.markDelivered.run(id);
  return true;
}

export function setMessageStatus(id, status) {
  stmts.setMessageStatus.run(status, status, status, id);
  return getMessage(id);
}

export function messageHistoryAfter(handle, sinceId, limit = 100) {
  return parseAttachments(stmts.historyAfter.all(sinceId, handle, handle, limit));
}

export function lastReportAt(handle) {
  return stmts.lastReportAt.get(handle)?.t || null;
}

export function unackedRequiredFor(handle) {
  return stmts.unackedRequired.all(handle);
}

export function inboxDepth(handle) {
  return stmts.inboxDepth.get(handle, handle, handle, handle);
}

export function getRecentMessages(handle, limit = 50) {
  return parseAttachments(stmts.getRecentMessages.all(handle, handle, limit));
}

export function pruneMessages(cutoff) {
  const info = stmts.pruneMessages.run(cutoff);
  return { messages: info.changes, cutoff };
}

// ── P2: dashboard queries ─────────────────────────────────────────

export function recordDelivery(handle, method, messageIds = [], detail = null) {
  const ids = Array.isArray(messageIds) && messageIds.length ? messageIds : [null];
  const tx = db.transaction(() => {
    for (const id of ids) stmts.insertDelivery.run(id, handle, method, detail);
  });
  tx();
  return ids.length;
}

export function deliveriesFor(messageId) {
  return stmts.deliveriesFor.all(messageId);
}

export function recentDeliveries(sinceUtc) {
  return stmts.recentDeliveries.all(sinceUtc);
}

// Free-form message listing for the dashboard (all messages, not per-identity).
export function listMessages({ from = null, to = null, type = null, priority = null, status = null,
  since = null, until = null, q = null, task = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push("from_user = ?"); args.push(from); }
  if (to) {
    if (to === "all") where.push("to_user IS NULL");
    else { where.push("to_user = ?"); args.push(to); }
  }
  if (type) { where.push("type = ?"); args.push(type); }
  if (priority) { where.push("priority = ?"); args.push(priority); }
  if (status) { where.push("status = ?"); args.push(status); }
  if (task) { where.push("task_id = ?"); args.push(task); }
  if (since) { where.push("created_at >= ?"); args.push(since); }
  if (until) { where.push("created_at <= ?"); args.push(until); }
  if (q) { where.push("body LIKE ?"); args.push("%" + q + "%"); }
  const sql = `SELECT * FROM messages${where.length ? " WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, rowid DESC LIMIT ?`;
  args.push(Math.min(2000, Math.max(1, limit)));
  return parseAttachments(db.prepare(sql).all(...args));
}

// A thread = the root of the `re` chain plus every descendant, plus every
// message that carries the same task_id. Bounded walk; ids deduplicated.
export function threadFor(messageId) {
  const seen = new Map();
  let root = stmts.getMessage.get(messageId);
  if (!root) return null;
  let guard = 0;
  while (root.re && guard++ < 50) {
    const parent = stmts.getMessage.get(root.re);
    if (!parent) break;
    root = parent;
  }
  const queue = [root];
  while (queue.length) {
    const m = queue.shift();
    if (seen.has(m.id)) continue;
    seen.set(m.id, m);
    for (const c of stmts.childrenOf.all(m.id)) queue.push(c);
    if (m.task_id) for (const t of stmts.byTask.all(m.task_id)) queue.push(t);
    if (seen.size > 500) break;
  }
  const rows = [...seen.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
  return { root_id: root.id, task_id: root.task_id || rows.find((r) => r.task_id)?.task_id || null, messages: parseAttachments(rows) };
}

export function reportsForTask(taskId) {
  return stmts.reportsForTask.all(taskId);
}

export function openRequests() {
  return parseAttachments(stmts.openRequests.all());
}

export function listAllTasks(limit = 300) {
  return stmts.allTasksRecent.all(limit).map((t) => {
    try { t.files = JSON.parse(t.files); } catch { t.files = []; }
    try { t.documents = JSON.parse(t.documents || "[]"); } catch { t.documents = []; }
    return t;
  });
}

// Task timeline + staleness. `staleHours`: hours since the last report (or
// since creation) after which an active task is flagged; `maxContinuing`:
// consecutive trailing CONTINUING reports after which it is flagged.
export function taskHealth(task, { staleHours = 4, maxContinuing = 5 } = {}) {
  const reports = stmts.reportsForTask.all(task.id);
  const active = ["open", "acked", "in_progress", "waiting", "blocked", "pushed"].includes(task.status);
  const last = reports.length ? reports[reports.length - 1] : null;
  const anchor = last ? last.created_at : task.updated_at || task.created_at;
  const ageH = (Date.now() - new Date(anchor.replace(" ", "T") + "Z").getTime()) / 3600e3;
  let trailing = 0;
  for (let i = reports.length - 1; i >= 0; i--) {
    if (reports[i].state === "continuing") trailing++;
    else break;
  }
  const flags = [];
  if (active && ageH >= staleHours) flags.push(`no report for ${ageH.toFixed(1)}h (limit ${staleHours}h)`);
  if (active && trailing >= maxContinuing) flags.push(`${trailing} consecutive CONTINUING (limit ${maxContinuing})`);
  if (active && task.ack_required && !task.acked_at) flags.push("ack required, not acked");
  return { reports, last_report_at: last ? last.created_at : null, hours_since_report: Number(ageH.toFixed(2)),
           trailing_continuing: trailing, flags, overdue: flags.length > 0 };
}

export function updatePresence(user, workingOn = null, files = []) {
  stmts.upsertPresence.run(user, workingOn, JSON.stringify(files));
  return { user, working_on: workingOn, files };
}

export function getPresence() {
  return stmts.getPresence.all().map((p) => ({ ...p, files: JSON.parse(p.files) }));
}

export const PRESENCE_STATES = ["busy", "turn_end", "idle", "offline"];
export function setPresenceState(user, state, session = null) {
  stmts.upsertPresenceState.run(user, state, session);
  return { user, state, session };
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
