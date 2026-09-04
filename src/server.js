import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import {
  createTask,
  getTask,
  listTasks,
  claimTask,
  completeTask,
  cancelTask,
  pushWork,
  setVerdict,
  addComment,
  updatePresence,
  getPresence,
  checkConflicts,
  getUserByToken,
  getUserByHandle,
  listUsers,
  setUserPasswordHash,
  touchUser,
  getRepo,
  getPendingCompletions,
  pullPendingCompletions,
  markCompletionsSeen,
  sendMessage,
  pullUnreadMessages,
  peekUnreadMessages,
  countUnread,
  getMessage,
  setMessageStatus,
  markMessageRead,
  messageHistoryAfter,
  lastReportAt,
  unackedRequiredFor,
  inboxDepth,
  createTaskFromMessage,
  ackTask,
  applyReportState,
  getOpenTasksFor,
  setPresenceState,
  normalizePriority,
  PRIORITIES,
  PRIORITY_RANK,
  MESSAGE_TYPES,
  ACK_MODES,
  REPORT_STATES,
  PRESENCE_STATES,
  BODY_MAX_CHARS,
  recordDelivery,
  deliveriesFor,
  recentDeliveries,
  listMessages,
  threadFor,
  openRequests,
  listAllTasks,
  taskHealth,
  getSetting,
  setSetting,
  markHandling,
  nextHandlingExpiry,
  listProjects,
  getProject,
  projectOf,
  coordinatorFor,
  handlesInProject,
  projectSummary,
} from "./store.js";
import { writeTaskMirror, TASKS_DIR, tasksDirForProject } from "./mirror.js";
import { execFile } from "child_process";
import { readFileSync as readFileSyncFs } from "fs";
import { homedir } from "os";
import db from "./store.js";
import { localizeMessages, toDisplayTz, utcNow } from "./tz.js";
import {
  verifyCommitWithFetch,
  getDiffStats,
} from "./git.js";
import {
  signJwt,
  requireJwt,
  verifyPassword,
  hashPassword,
  JWT_COOKIE,
  cookieOptions,
} from "./auth.js";

const PORT = process.env.PORT || 7900;
// Bind address. 0.0.0.0 serves LAN peers and the dashboard from other machines;
// set DISPATCH_BIND=127.0.0.1 when every client is local or comes in over a tunnel.
const BIND = process.env.DISPATCH_BIND || "0.0.0.0";

// ── Event bus (for /events SSE stream) ─────────────────────────────
//
// In-process EventEmitter — good enough for 2-3 teammates. Every state
// transition emits a {type, task, actor, recipients, timestamp} event.
// The /events endpoint filters by recipient and streams matching events
// as SSE frames. The watcher daemon (scripts/dispatch-watch.js) listens
// on this stream and uses `tmux send-keys` to poke a live Claude Code
// session into action.

import { EventEmitter } from "events";

const dispatchEvents = new EventEmitter();
// Default is 10; raise it so many concurrent /events subscribers don't
// trigger the "possible memory leak" warning.
dispatchEvents.setMaxListeners(100);

// Derive who should be notified about a given event. Never includes
// the actor — you don't need to hear about your own actions.
function deriveRecipients(type, task, actor) {
  if (!task) return [];
  const all = new Set(
    [task.to_user, task.from_user, task.claimed_by].filter(Boolean)
  );
  all.delete(actor);
  switch (type) {
    case "task_created":
      // Direct assignment → notify assignee. Unassigned → broadcast
      // (empty array means "anyone listening is a recipient").
      if (!task.to_user) return [];
      return task.to_user !== actor ? [task.to_user] : [];
    case "task_claimed":
    case "task_pushed":
    case "task_completed":
      // The requester cares about progress on their task.
      return task.from_user && task.from_user !== actor ? [task.from_user] : [];
    case "task_cancelled":
    case "task_commented":
      // Everyone on the task except the actor.
      return Array.from(all);
    default:
      return Array.from(all);
  }
}

function emitTaskEvent(type, task, actor) {
  if (!task || !task.id) return;
  const recipients = deriveRecipients(type, task, actor);
  dispatchEvents.emit("task", {
    type,
    task,
    actor,
    recipients,
    timestamp: new Date().toISOString(),
  });
}

// Emit a message event onto the same SSE bus the watcher already listens
// on. recipients = [to_user] for a directed message, or [] (broadcast) so
// every watcher except the sender's pokes its agent. The /events handler
// only reads actor/recipients, so a message-shaped event streams fine.
function emitMessageEvent(message, actor) {
  if (!message || !message.id) return;
  dispatchEvents.emit("task", {
    type: "message_created",
    message,
    actor,
    recipients: message.to_user ? [message.to_user] : [],
    timestamp: new Date().toISOString(),
  });
}

// ── Worktree command generation ────────────────────────────────────
//
// dispatch-mcp doesn't run commands on the agent's machine — the
// server just hands back the exact sequences the agent should execute
// locally. The convention is one worktree per task at a predictable
// path, created on claim and removed on complete/cancel.

const WORKTREE_ROOT = "~/.dispatch-worktrees";

function worktreePathFor(taskId) {
  return `${WORKTREE_ROOT}/${taskId}`;
}

// Build a worktree instruction bundle for a task. Returns null for
// discussion tasks (no code, no worktree needed). For review tasks we
// create a detached-HEAD checkout at the pinned commit; for work tasks
// we create a new branch from base_commit.
function worktreeFor(task) {
  if (!task || task.kind === "discussion") return null;
  const path = worktreePathFor(task.id);

  if (task.kind === "review") {
    if (!task.head_commit) return null;
    return {
      path,
      setup: [
        "# Run from inside your local checkout of the repo",
        "git fetch origin",
        `git worktree add ${path} ${task.head_commit}`,
        `cd ${path}`,
      ],
      cleanup: [`git worktree remove ${path}`, "git worktree prune"],
    };
  }

  if (task.kind === "work") {
    if (!task.base_commit) return null;
    const branch = task.head_branch || `dispatch/${task.id}`;
    return {
      path,
      setup: [
        "# Run from inside your local checkout of the repo",
        "git fetch origin",
        `git worktree add -b ${branch} ${path} ${task.base_commit}`,
        `cd ${path}`,
      ],
      push: [
        `cd ${path}`,
        `git push -u origin ${branch}`,
        `# Then call push_work with head_branch="${branch}" and head_commit=$(git rev-parse HEAD)`,
      ],
      cleanup: [`git worktree remove ${path}`, "git worktree prune"],
    };
  }

  return null;
}

// Return a JSON response payload that includes the task plus its
// worktree instructions (if applicable). Used by claim/push/complete/cancel.
function taskResponse(task, extra = {}) {
  const wt = worktreeFor(task);
  const payload = { task };
  if (wt) payload.worktree = wt;
  return { ...payload, ...extra };
}

// ── MCP Server Definition ──────────────────────────────────────────
//
// Each SSE connection gets its own McpServer instance with `identity`
// captured in every tool closure. That identity is resolved from the
// bearer token presented at connection time — tool callers cannot
// override it, so agents can't accidentally or deliberately claim to
// be someone else.

function createMcpServer(identity) {
  const server = new McpServer({
    name: "dispatch",
    version: "1.0.0",
  });

  // ── request_review ─────────────────────────────────────────────
  server.tool(
    "request_review",
    "Ask a teammate to review a specific commit on a specific branch. The server verifies that head_commit exists in the registered repo before creating the task — there's no way to request a review on code that hasn't been pushed. Identity is automatic.",
    {
      title: z.string().describe("Short summary of what to review"),
      description: z.string().optional().describe("Context, what you want attention on, acceptance criteria"),
      repo: z.string().describe("Registered repo name (see admin.js list-repos)"),
      head_branch: z.string().describe("Branch name containing the work to review, e.g. 'fix/auth'"),
      head_commit: z.string().describe("Commit SHA to pin the review to (must exist on origin)"),
      base_branch: z.string().optional().describe("Base branch the work was forked from, e.g. 'main'"),
      base_commit: z.string().optional().describe("Base commit (enables diff stats on the dashboard)"),
      files: z.array(z.string()).optional().describe("Files you want the reviewer to focus on"),
      to_user: z.string().optional().describe("Handle of the specific reviewer (omit for anyone)"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Task priority"),
    },
    async (args) => {
      const repo = getRepo(args.repo);
      if (!repo) {
        return {
          content: [{
            type: "text",
            text: `Error: repo '${args.repo}' is not registered. Ask the admin to run 'node src/admin.js add-repo ${args.repo} <url>'.`,
          }],
        };
      }
      const headOk = await verifyCommitWithFetch(args.repo, args.head_commit);
      if (!headOk) {
        return {
          content: [{
            type: "text",
            text: `Error: head_commit ${args.head_commit} was not found in '${args.repo}' even after a fetch. Did you push the branch?`,
          }],
        };
      }
      if (args.base_commit) {
        const baseOk = await verifyCommitWithFetch(args.repo, args.base_commit);
        if (!baseOk) {
          return {
            content: [{
              type: "text",
              text: `Error: base_commit ${args.base_commit} was not found in '${args.repo}'.`,
            }],
          };
        }
      }
      const task = createTask({
        kind: "review",
        title: args.title,
        description: args.description || "",
        files: args.files,
        from_user: identity,
        to_user: args.to_user,
        priority: args.priority,
        repo: args.repo,
        base_branch: args.base_branch,
        base_commit: args.base_commit,
        head_branch: args.head_branch,
        head_commit: args.head_commit,
      });
      emitTaskEvent("task_created", task, identity);
      return {
        content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      };
    }
  );

  // ── request_work ───────────────────────────────────────────────
  server.tool(
    "request_work",
    "Ask a teammate to produce code for you, starting from a specific base commit. The assignee will branch from base_commit, do the work in an isolated worktree, and call push_work when ready. The server verifies base_commit exists before accepting.",
    {
      title: z.string().describe("Short summary of what needs to be done"),
      description: z.string().describe("Detailed description, acceptance criteria, context"),
      repo: z.string().describe("Registered repo name"),
      base_branch: z.string().describe("Base branch the work should eventually land on, e.g. 'main'"),
      base_commit: z.string().describe("Commit to start the work from (must exist on origin)"),
      head_branch: z.string().optional().describe("Suggested branch name for the assignee (default: dispatch/<task_id>)"),
      files: z.array(z.string()).optional().describe("Files involved (hint, not a constraint)"),
      to_user: z.string().optional().describe("Handle of the specific assignee (omit for anyone)"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Task priority"),
    },
    async (args) => {
      const repo = getRepo(args.repo);
      if (!repo) {
        return {
          content: [{
            type: "text",
            text: `Error: repo '${args.repo}' is not registered. Ask the admin to run 'node src/admin.js add-repo ${args.repo} <url>'.`,
          }],
        };
      }
      const baseOk = await verifyCommitWithFetch(args.repo, args.base_commit);
      if (!baseOk) {
        return {
          content: [{
            type: "text",
            text: `Error: base_commit ${args.base_commit} was not found in '${args.repo}' even after a fetch.`,
          }],
        };
      }
      const task = createTask({
        kind: "work",
        title: args.title,
        description: args.description,
        files: args.files,
        from_user: identity,
        to_user: args.to_user,
        priority: args.priority,
        repo: args.repo,
        base_branch: args.base_branch,
        base_commit: args.base_commit,
        head_branch: args.head_branch,
      });
      emitTaskEvent("task_created", task, identity);
      return {
        content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      };
    }
  );

  // ── start_discussion ───────────────────────────────────────────
  server.tool(
    "start_discussion",
    "Start a discussion thread with a teammate — no git refs required. Use this for questions, design back-and-forth, or anything that isn't a concrete code change.",
    {
      title: z.string().describe("Short summary of the discussion topic"),
      description: z.string().optional().describe("Opening message / context"),
      to_user: z.string().optional().describe("Handle of the specific recipient"),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Priority"),
    },
    async ({ title, description, to_user, priority }) => {
      const task = createTask({
        kind: "discussion",
        title,
        description: description || "",
        from_user: identity,
        to_user,
        priority,
      });
      emitTaskEvent("task_created", task, identity);
      return {
        content: [{ type: "text", text: JSON.stringify({ task }, null, 2) }],
      };
    }
  );

  // ── my_tasks ───────────────────────────────────────────────────
  server.tool(
    "my_tasks",
    "List tasks assigned to you AND any outbound dispatches that have finished since your last check. Check this at the start of a session and whenever you want a status digest.",
    {},
    async () => {
      const tasks = listTasks({ user: identity });
      // Option E: also surface outbound completions. This is a
      // "pull" — the timestamp advances, so the next my_tasks call
      // won't re-show the same completions unless they move state again.
      const completions = pullPendingCompletions(identity);

      // Format as human-readable text for Claude to present, with a
      // machine-readable JSON block at the end in case the client
      // wants to parse it.
      const lines = [];
      if (tasks.length === 0) {
        lines.push("📥 No open tasks for you right now.");
      } else {
        lines.push(`📥 Assigned to you (${tasks.length}):`);
        for (const t of tasks) {
          const who = t.from_user ? `from ${t.from_user}` : "";
          lines.push(`  #${t.id}  ${t.kind}  ${t.title}  ${who}`);
        }
      }
      if (completions.length > 0) {
        lines.push("");
        lines.push(`✅ Finished since your last check (${completions.length}):`);
        for (const c of completions) {
          const outcome =
            c.status === "cancelled"
              ? "CANCELLED"
              : c.kind === "review" && c.verdict
                ? c.verdict.toUpperCase().replace(/_/g, " ")
                : c.kind === "work" && c.head_commit
                  ? `PUSHED ${c.head_branch || ""}@${c.head_commit.slice(0, 8)}`
                  : "CLOSED";
          lines.push(`  #${c.id}  ${c.kind}  → ${outcome}  by ${c.to_user || "?"}`);
          if (c.result) {
            // Indent + truncate the result summary for readability
            const summary = c.result.length > 200 ? c.result.slice(0, 197) + "..." : c.result;
            lines.push(`         "${summary}"`);
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
          {
            type: "text",
            text: JSON.stringify({ tasks, recent_completions: completions }, null, 2),
          },
        ],
      };
    }
  );

  // ── list_all_tasks ─────────────────────────────────────────────
  server.tool(
    "list_all_tasks",
    "List all tasks (open, in-progress, done, cancelled). Good for seeing the full history.",
    {
      limit: z.number().optional().describe("Max tasks to return (default 50)"),
    },
    async ({ limit }) => {
      const tasks = listTasks({ all: true, limit: limit || 50 });
      return {
        content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }],
      };
    }
  );

  // ── get_task ───────────────────────────────────────────────────
  server.tool(
    "get_task",
    "Get full details of a specific task including comments. For code tasks, the response also includes the worktree setup commands you should use to work on it.",
    {
      id: z.string().describe("Task ID"),
    },
    async ({ id }) => {
      const task = getTask(id);
      if (!task) return { content: [{ type: "text", text: "Task not found." }] };
      return {
        content: [{ type: "text", text: JSON.stringify(taskResponse(task), null, 2) }],
      };
    }
  );

  // ── claim_task ─────────────────────────────────────────────────
  server.tool(
    "claim_task",
    "Claim an open task and start working on it. Transitions status from 'open' to 'in_progress'. For review/work tasks, the response includes the exact git-worktree commands you should run locally — do NOT improvise. The dispatch-worktree skill has the full protocol.",
    {
      id: z.string().describe("Task ID to claim"),
    },
    async ({ id }) => {
      const result = claimTask(id, identity);
      if (result.error) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
      }
      emitTaskEvent("task_claimed", result, identity);
      mirrorTask(id);
      return {
        content: [{ type: "text", text: JSON.stringify(taskResponse(result), null, 2) }],
      };
    }
  );

  // ── push_work ──────────────────────────────────────────────────
  server.tool(
    "push_work",
    "Work-kind only: record the branch and commit you've pushed to origin. The server verifies the commit exists (fetching first if necessary) before accepting. Transitions status from 'in_progress' to 'pushed'. After this, the requester can review or you can complete_task.",
    {
      id: z.string().describe("Task ID"),
      head_branch: z.string().describe("Branch you pushed, e.g. 'fix/auth'"),
      head_commit: z.string().describe("Head commit SHA (40 or abbreviated hex)"),
    },
    async ({ id, head_branch, head_commit }) => {
      const existing = getTask(id);
      if (!existing) {
        return { content: [{ type: "text", text: "Error: Task not found" }] };
      }
      if (existing.kind !== "work") {
        return { content: [{ type: "text", text: "Error: push_work is only valid for work-kind tasks" }] };
      }
      if (!existing.repo) {
        return { content: [{ type: "text", text: "Error: task has no associated repo" }] };
      }
      const ok = await verifyCommitWithFetch(existing.repo, head_commit);
      if (!ok) {
        return {
          content: [{
            type: "text",
            text: `Error: ${head_commit} was not found in '${existing.repo}' even after a fetch. Did 'git push' succeed?`,
          }],
        };
      }
      const updated = pushWork(id, head_branch, head_commit);
      if (updated.error) {
        return { content: [{ type: "text", text: `Error: ${updated.error}` }] };
      }
      emitTaskEvent("task_pushed", updated, identity);
      return {
        content: [{ type: "text", text: JSON.stringify(taskResponse(updated), null, 2) }],
      };
    }
  );

  // ── complete_task ──────────────────────────────────────────────
  server.tool(
    "complete_task",
    "Mark a task as closed. For review tasks, pass verdict='approved' or 'changes_requested'. The response includes worktree cleanup commands you should run locally.",
    {
      id: z.string().describe("Task ID"),
      result: z.string().optional().describe("Summary of what was done / the review comment"),
      verdict: z.enum(["approved", "changes_requested"]).optional().describe("Review verdict (review tasks only)"),
    },
    async ({ id, result, verdict }) => {
      const existing = getTask(id);
      if (!existing) {
        return { content: [{ type: "text", text: "Error: Task not found" }] };
      }
      if (verdict) {
        if (existing.kind !== "review") {
          return { content: [{ type: "text", text: "Error: verdict is only valid for review-kind tasks" }] };
        }
        setVerdict(id, verdict);
      }
      const task = completeTask(id, result);
      emitTaskEvent("task_completed", task, identity);
      mirrorTask(id);
      return {
        content: [{ type: "text", text: JSON.stringify(taskResponse(task), null, 2) }],
      };
    }
  );

  // ── cancel_task ────────────────────────────────────────────────
  server.tool(
    "cancel_task",
    "Cancel a task that is no longer needed. Response includes worktree cleanup commands if you had one set up.",
    {
      id: z.string().describe("Task ID"),
    },
    async ({ id }) => {
      const task = cancelTask(id);
      emitTaskEvent("task_cancelled", task, identity);
      mirrorTask(id);
      return {
        content: [{ type: "text", text: JSON.stringify(taskResponse(task), null, 2) }],
      };
    }
  );

  // ── comment ────────────────────────────────────────────────────
  server.tool(
    "comment_on_task",
    "Add a comment to a task. Use for questions, progress updates, or notes.",
    {
      task_id: z.string().describe("Task ID"),
      body: z.string().describe("Comment text"),
    },
    async ({ task_id, body }) => {
      const comment = addComment(task_id, identity, body);
      const task = getTask(task_id);
      if (task) emitTaskEvent("task_commented", task, identity);
      return { content: [{ type: "text", text: JSON.stringify(comment, null, 2) }] };
    }
  );

  // ── announce_work ──────────────────────────────────────────────
  server.tool(
    "announce_work",
    "Announce what you're currently working on. This helps prevent merge conflicts by letting others see which files you're touching.",
    {
      working_on: z.string().optional().describe("Short description of current work"),
      files: z.array(z.string()).optional().describe("Files you're currently editing"),
    },
    async ({ working_on, files }) => {
      const presence = updatePresence(identity, working_on, files);
      return { content: [{ type: "text", text: JSON.stringify(presence, null, 2) }] };
    }
  );

  // ── check_conflicts ────────────────────────────────────────────
  server.tool(
    "check_conflicts",
    "Check if anyone else is working on the same files as you. Run this before starting work on a file.",
    {
      files: z.array(z.string()).describe("Files you plan to edit"),
    },
    async ({ files }) => {
      const conflicts = checkConflicts(identity, files);
      if (conflicts.length === 0) {
        return { content: [{ type: "text", text: "No conflicts. You're clear to work on these files." }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `⚠️ CONFLICTS DETECTED:\n${JSON.stringify(conflicts, null, 2)}`,
          },
        ],
      };
    }
  );

  // ── who_is_online ──────────────────────────────────────────────
  server.tool(
    "who_is_online",
    "See who else is currently active and what they're working on.",
    {},
    async () => {
      const presence = getLivePresence();
      if (presence.length === 0) {
        return { content: [{ type: "text", text: "Nobody is currently connected." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(presence, null, 2) }] };
    }
  );

  // ── whoami ─────────────────────────────────────────────────────
  server.tool(
    "whoami",
    "Show the handle this session is authenticated as. Useful to confirm identity at session start.",
    {},
    async () => {
      return { content: [{ type: "text", text: identity }] };
    }
  );

  // ── send_message ───────────────────────────────────────────────
  server.tool(
    "send_message",
    "Send a lightweight note to another agent (or broadcast). Unlike a task, there's no claim/complete lifecycle — the recipient just reads it via my_messages. The recipient's watcher pokes their session when idle, so they pick it up without you doing anything else. Use this for coordination pings, status reports, and hand-offs.",
    {
      to: z.string().optional().describe("Recipient handle. Omit to broadcast to everyone online."),
      body: z.string().describe(`The message text (max ${BODY_MAX_CHARS} chars; put longer material in a file and list it in attachments).`),
      priority: z.enum(["low", "medium", "high", "immediate", "normal", "urgent"]).optional().describe("low | medium (default) | high | immediate."),
      type: z.enum(MESSAGE_TYPES).optional().describe("task | question | request_permission | report | ack | info (default)."),
      ack: z.enum(ACK_MODES).optional().describe("yes | no (default) | auto (= required when priority is high/immediate)."),
      re: z.string().optional().describe("Id of the message this replies to / acks."),
      state: z.enum(REPORT_STATES).optional().describe("report only: done | continuing | waiting | blocked."),
      attachments: z.array(z.string()).optional().describe("Absolute file paths the recipient should read."),
    },
    async (args) => {
      const r = handleSend(identity, args);
      if (r.status !== 200) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(r.body, null, 2) }] };
    }
  );

  // ── my_messages ────────────────────────────────────────────────
  server.tool(
    "my_messages",
    "Drain your unread messages (directed to you or broadcast). Each message is returned once — reading it marks it delivered. Call this when your watcher pokes you, or at the start of a session.",
    {},
    async () => {
      const { messages: raw } = pullUnreadMessages(identity);
      const messages = localizeMessages(raw);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "📭 No unread messages." }] };
      }
      const lines = [`📬 ${messages.length} unread message(s):`];
      for (const m of messages) {
        const pri = m.priority && m.priority !== "medium" ? ` [${m.priority}]` : "";
        const typ = m.type && m.type !== "info" ? ` <${m.type}>` : "";
        const scope = m.to_user ? "" : " (broadcast)";
        lines.push(`  • ${m.id} from ${m.from_user}${scope}${typ}${pri} @ ${m.created_at}`);
        lines.push(`    ${m.body}`);
      }
      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify({ messages }, null, 2) },
        ],
      };
    }
  );

  return server;
}

// ── Auth helper ────────────────────────────────────────────────────

function extractToken(req) {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  // Query-param fallback — useful for clients that can't set headers.
  // Prefer the header where possible; query strings can land in access logs.
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

// ── Express + SSE Transport ────────────────────────────────────────

const app = express();
const transports = {};

// Derive live presence from the set of currently-connected MCP sessions.
// Each SSE connect adds to `transports`; `res.on("close")` removes. This
// is authoritative — a handle appears here iff they have at least one
// live session. Enriched with announce_work data (working_on / files)
// when the user has called announce_work on this session.
function getLivePresence() {
  const liveHandles = new Set();
  for (const sid in transports) {
    liveHandles.add(transports[sid].handle);
  }
  const announced = new Map();
  for (const row of getPresence()) {
    announced.set(row.user, row);
  }
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  return [...liveHandles].map((handle) => {
    const ann = announced.get(handle);
    return {
      user: handle,
      working_on: ann?.working_on || null,
      files: ann?.files || [],
      last_seen: now,
    };
  });
}

app.get("/sse", async (req, res) => {
  const token = extractToken(req);
  const user = token ? getUserByToken(token) : null;
  if (!user) {
    res.status(401).json({
      error:
        "Missing or invalid token. Configure Authorization: Bearer <token> in your .claude/claude.json. Ask the server admin to run 'node src/admin.js add <your-handle>' to get a token.",
    });
    return;
  }
  touchUser(user.handle, req.ip);

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(user.handle);
  transports[transport.sessionId] = { transport, server, handle: user.handle };

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const entry = transports[sessionId];
  if (!entry) {
    res.status(400).json({ error: "Unknown session" });
    return;
  }
  // Session was authenticated at SSE connect time — the sessionId was
  // returned only over that authenticated stream, so possession of it
  // implies possession of a valid token at some point. No further
  // re-check here.
  await entry.transport.handlePostMessage(req, res);
});

// ── /events — task event stream for external watchers ─────────────
//
// Not an MCP endpoint. This is a plain SSE feed of task state
// transitions, intended for the dispatch-watch daemon (which uses
// `tmux send-keys` to poke a live Claude Code session into action)
// and for any other automation that wants to react to task activity.
//
// Events are filtered per-user: only events where the authenticated
// user is in the recipients list (or recipients is empty, i.e. a
// broadcast) are sent down this connection.

app.get("/events", (req, res) => {
  const token = extractToken(req);
  const user = token ? getUserByToken(token) : null;
  if (!user) {
    res.status(401).json({
      error:
        "Missing or invalid token. Add Authorization: Bearer <token> to your watcher config.",
    });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Disable nginx proxy buffering if present — otherwise events pile
    // up in the proxy until the response is "complete" (which never
    // happens on an SSE stream).
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected as ${user.handle}\n\n`);
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  // Keep the connection alive through proxies that close idle HTTP.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      // stream already closed; cleanup handled by req.on('close')
    }
  }, 30000);

  const handler = (event) => {
    // Never echo a user's own actions back to them — a watcher fired
    // by its owner's own dispatch would trigger /dispatch-next
    // pointlessly.
    if (event.actor === user.handle) return;

    // Broadcast (empty recipients) → everyone else
    // Directed → only users in the list
    const isBroadcast = event.recipients.length === 0;
    const isForMe = event.recipients.includes(user.handle);
    if (!isBroadcast && !isForMe) return;

    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // ignore — cleanup happens on close
    }
  };

  dispatchEvents.on("task", handler);

  req.on("close", () => {
    clearInterval(heartbeat);
    dispatchEvents.off("task", handler);
  });
});

// ── Plain HTTP message API (for the shell CLI + hooks) ─────────────
//
// dispatch-send / dispatch-recv / hook.sh talk to these. Bearer-authed,
// identity from the token. Same store + event bus as the MCP tools, so an
// already-running agent (which can't pick up a new MCP server without a
// restart) can still send and receive via a one-line curl. Uniform
// across Claude Code and Codex.

function httpIdentity(req, res) {
  const token = extractToken(req);
  const user = token ? getUserByToken(token) : null;
  if (!user) {
    res.status(401).json({ error: "Missing or invalid bearer token." });
    return null;
  }
  touchUser(user.handle, req.ip);
  return user.handle;
}

// Count user-perceived characters (code points), not UTF-16 units, so CJK
// and emoji don't get double-counted against the body limit.
function charCount(str) {
  let n = 0;
  for (const _ of str) n++;
  return n;
}

// Normalize the `attachments` field: accept ["/abs/path", ...] or
// [{path, size?, sha256?, name?}, ...]; reject anything else.
function normalizeAttachments(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const a of raw) {
    if (typeof a === "string") {
      if (!a.trim()) return null;
      out.push({ path: a });
    } else if (a && typeof a === "object" && typeof a.path === "string" && a.path.trim()) {
      const o = { path: a.path };
      if (Number.isFinite(a.size)) o.size = a.size;
      if (typeof a.sha256 === "string") o.sha256 = a.sha256;
      if (typeof a.name === "string") o.name = a.name;
      out.push(o);
    } else {
      return null;
    }
  }
  return out;
}

// Resolve which task a report / ack refers to. Order: explicit task_id →
// re that IS a task id → re that is a message carrying a task_id. There is
// deliberately NO "the sender's single open task" fallback: a report about
// something else would silently close whatever task happened to be open
// (it did, on 2026-09-03 — a deploy note closed a freshly assigned task).
// A report that names no task only counts toward "reported this turn".
function resolveTaskFor(identity, { task_id, re, reMsg }) {
  if (task_id && getTask(task_id)) return task_id;
  if (re && getTask(re)) return re;
  if (reMsg && reMsg.task_id && getTask(reMsg.task_id)) return reMsg.task_id;
  return null;
}

// Shared by POST /msg/send and the MCP send_message tool.
// Returns { status, body } — 200 on success, 4xx with { error } otherwise.
function handleSend(identity, payload) {
  const p = payload || {};
  const bad = (status, error, extra = {}) => ({ status, body: { delivered: false, error, ...extra } });

  let to = p.to && p.to !== "all" ? String(p.to) : null;
  const body = p.body;
  if (!body || typeof body !== "string") return bad(400, "body (string) is required");
  // `coord` is an alias for the sender's project coordinator (multi-project
  // D3): the global CLAUDE.md rule "dispatch-send coord ..." keeps working in
  // every project. A project whose coordinator IS the literal handle `coord`
  // (and senders with no project) are untouched. A project whose
  // coordinator has no server account fails loudly instead of misrouting.
  let alias = null;
  if (to === "coord") {
    const c = coordinatorFor(identity);
    if (c && c !== "coord") {
      if (!getUserByHandle(c)) {
        return bad(404, `your project's coordinator '${c}' has no server account yet — message NOT delivered (dispatch-fleet add ${c} …, or dispatch-fleet project add <project> --coordinator <handle>)`);
      }
      alias = "coord";
      to = c;
    }
  }
  // Project a task is filed under: explicit `project`, else the sender's,
  // else the recipient's. Only meaningful for type=task (it decides which
  // coordination/tasks/ the mirror lands in) but validated for every type.
  const explicitProject = p.project !== undefined && p.project !== null && String(p.project).trim() ? String(p.project).trim() : null;
  if (explicitProject && !getProject(explicitProject)) {
    return bad(404, `unknown project '${explicitProject}'. Known: ${listProjects().map((x) => x.name).join(", ") || "(none)"}`);
  }
  const nChars = charCount(body);
  if (nChars > BODY_MAX_CHARS) {
    return bad(
      400,
      `body too long: ${nChars} chars > ${BODY_MAX_CHARS}. Put the detail in a file and pass --attach <path> (body = summary + pointer).`,
      { limit: BODY_MAX_CHARS, chars: nChars }
    );
  }
  // Reject directed messages to unknown handles — otherwise the message is
  // silently stored under a recipient nobody polls and is never delivered.
  if (to && !getUserByHandle(to)) {
    return bad(
      404,
      `unknown recipient handle '${to}' — message NOT delivered. Known handles: ${listUsers()
        .map((u) => u.handle)
        .join(", ")}`
    );
  }
  const priority = normalizePriority(p.priority);
  if (!priority) return bad(400, `priority must be one of ${PRIORITIES.join("|")} (got '${p.priority}')`);
  const type = p.type ? String(p.type) : "info";
  if (!MESSAGE_TYPES.includes(type)) return bad(400, `type must be one of ${MESSAGE_TYPES.join("|")} (got '${type}')`);
  const ack = p.ack ? String(p.ack) : "no";
  if (!ACK_MODES.includes(ack)) return bad(400, `ack must be one of ${ACK_MODES.join("|")} (got '${ack}')`);
  let state = p.state ? String(p.state) : null;
  if (state && type !== "report") return bad(400, "state is only valid with type=report");
  if (state && !REPORT_STATES.includes(state)) return bad(400, `state must be one of ${REPORT_STATES.join("|")} (got '${state}')`);
  if (type === "report" && !state) state = "continuing";
  const attachments = normalizeAttachments(p.attachments);
  if (attachments === null) return bad(400, "attachments must be an array of paths or {path,size,sha256} objects");
  const title = p.title !== undefined && p.title !== null ? String(p.title).trim() : null;
  if (title && type !== "task") return bad(400, "title is only valid with type=task");
  if (title && charCount(title) > 120) return bad(400, "title must be ≤ 120 chars");
  const force = p.force === true || p.force === 1 || p.force === "1" ? 1 : 0;
  if (force && priority !== "immediate") return bad(400, "--force requires --priority immediate");

  const re = p.re ? String(p.re) : null;
  let reMsg = null;
  if (re) {
    reMsg = getMessage(re);
    if (!reMsg && !getTask(re)) return bad(404, `re='${re}' matches neither a message id nor a task id`);
    if (reMsg && type === "ack" && reMsg.type === "report") {
      return bad(400, `message ${re} is a report — reports are never acked (the protocol forbids it)`);
    }
    if (reMsg && type === "ack" && reMsg.type === "ack") {
      return bad(400, `message ${re} is itself an ack — don't ack an ack`);
    }
  }
  if (type === "ack" && !re) return bad(400, "type=ack requires --re <message id>");

  const taskId = type === "task" ? null : resolveTaskFor(identity, { task_id: p.task_id, re, reMsg });

  const message = sendMessage({
    from_user: identity,
    to_user: to,
    body,
    priority,
    type,
    ack,
    re,
    task_id: taskId,
    state,
    attachments,
    force,
  });

  const effects = {};
  // type=task → a task row, linked both ways.
  if (type === "task") {
    const taskProject = explicitProject || projectOf(identity) || (to ? projectOf(to) : null) || null;
    const task = createTaskFromMessage(message, title, taskProject);
    if (task) {
      db.prepare(`UPDATE messages SET task_id = ? WHERE id = ?`).run(task.id, message.id);
      message.task_id = task.id;
      effects.task = { id: task.id, ack_required: !!task.ack_required, status: task.status, project: task.project || null };
      emitTaskEvent("task_created", task, identity);
    }
  }
  // type=ack re=<msg> → that message (and its task) is acknowledged.
  if (type === "ack" && reMsg) {
    setMessageStatus(reMsg.id, "acked");
    if (reMsg.task_id) {
      const t = ackTask(reMsg.task_id, identity);
      if (t) effects.task = { id: t.id, status: t.status, acked_at: t.acked_at };
    }
    effects.acked = reMsg.id;
  }
  // type=report → task state follows `state`; a referenced message closes /
  // gets answered.
  if (type === "report") {
    if (taskId) {
      const t = applyReportState(taskId, state, identity, state === "done" ? body : "");
      if (t) {
        effects.task = { id: t.id, status: t.status };
        if (state === "done") emitTaskEvent("task_completed", t, identity);
      }
    }
    if (reMsg) setMessageStatus(reMsg.id, state === "done" ? "closed" : "answered");
  }
  // Any non-ack reply to a question / permission request answers it.
  if (reMsg && type !== "ack" && type !== "report" &&
      (reMsg.type === "question" || reMsg.type === "request_permission")) {
    setMessageStatus(reMsg.id, "answered");
    effects.answered = reMsg.id;
  }

  emitMessageEvent(message, identity);
  if (message.task_id) mirrorTask(message.task_id);
  return {
    status: 200,
    body: {
      delivered: true,
      id: message.id,
      to: to || "(broadcast)",
      ...(alias ? { alias, resolved_to: to } : {}),
      type,
      priority,
      ack_required: ack === "yes" || (ack === "auto" && (priority === "high" || priority === "immediate")),
      ...(message.task_id ? { task_id: message.task_id } : {}),
      ...effects,
    },
  };
}

app.post("/msg/send", express.json({ limit: "256kb" }), (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const r = handleSend(identity, req.body);
  res.status(r.status).json(r.body);
});

// Parse "high", "high+", "medium+" → a minimum priority (the "+" is implied:
// a filter always means "this level and above").
function parseMinPriority(q) {
  if (!q) return "low";
  const v = normalizePriority(String(q).replace(/\+$/, ""));
  return v || null;
}

// Drain (default) or peek (?peek=1). ?limit=N bounds the drain — the rest
// STAYS UNREAD on the server (see store.pullUnreadMessages). ?priority=high+
// drains only that level and above.
app.get("/msg/recv", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const minPriority = parseMinPriority(req.query.priority);
  if (!minPriority) return res.status(400).json({ error: `bad priority filter '${req.query.priority}'` });
  const limit = Math.max(0, parseInt(req.query.limit || "0", 10) || 0);
  const peek = req.query.peek === "1" || req.query.peek === "true";
  const excludeHandling = req.query.exclude_handling === "1";
  let messages, remaining;
  if (peek) {
    messages = peekUnreadMessages(identity, { minPriority, limit, excludeHandling });
    remaining = countUnread(identity).total - messages.length;
  } else {
    ({ messages, remaining } = pullUnreadMessages(identity, { minPriority, limit }));
  }
  res.json({
    handle: identity,
    count: messages.length,
    remaining,
    remaining_by_priority: remaining > 0 ? countUnread(identity).by_priority : undefined,
    messages: localizeMessages(messages),
  });
});

// Non-destructive history: everything involving me after message <since>.
app.get("/msg/history", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const since = req.query.since ? String(req.query.since) : null;
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "100", 10) || 100));
  if (!since) return res.status(400).json({ error: "since=<message id> is required" });
  if (!getMessage(since)) return res.status(404).json({ error: `message ${since} not found` });
  const messages = messageHistoryAfter(identity, since, limit);
  res.json({ handle: identity, count: messages.length, messages: localizeMessages(messages) });
});

// Long-poll: block until an unread message at/above ?priority arrives (or
// ?timeout seconds elapse). Peek semantics — never consumes. Used by the
// B′ asyncRewake experiment. Capped below Node's 300s request timeout.
const WAIT_MAX_S = parseInt(process.env.DISPATCH_WAIT_MAX_S || "280", 10);
app.get("/msg/wait", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const minPriority = parseMinPriority(req.query.priority);
  if (!minPriority) return res.status(400).json({ error: `bad priority filter '${req.query.priority}'` });
  const timeoutS = Math.min(WAIT_MAX_S, Math.max(1, parseInt(req.query.timeout || "60", 10) || 60));
  const minRank = PRIORITY_RANK[minPriority];

  // Messages a hook already delivered (handling_until in the future) are not
  // a reason to rewake; if one is still unread when its handling window ends,
  // a re-check timer picks it up then.
  const check = () => peekUnreadMessages(identity, { minPriority, excludeHandling: true });
  let done = false;
  let recheck = null;
  const armRecheck = () => {
    const exp = nextHandlingExpiry(identity, minPriority);
    if (!exp || done) return;
    const ms = Math.max(500, new Date(exp.replace(" ", "T") + "Z").getTime() - Date.now() + 500);
    clearTimeout(recheck);
    recheck = setTimeout(() => { const f = check(); if (f.length > 0) finish(f, false); else armRecheck(); }, ms);
  };
  const finish = (messages, timedOut) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(recheck);
    dispatchEvents.off("task", handler);
    res.json({
      handle: identity,
      timed_out: timedOut,
      count: messages.length,
      messages: localizeMessages(messages),
    });
  };
  const handler = (event) => {
    if (event.type !== "message_created" || !event.message) return;
    const m = event.message;
    if (m.from_user === identity) return;
    if (m.to_user && m.to_user !== identity) return;
    if ((PRIORITY_RANK[m.priority] ?? 1) < minRank) return;
    const found = check();
    if (found.length > 0) finish(found, false); else armRecheck();
  };
  const timer = setTimeout(() => finish(check(), true), timeoutS * 1000);
  const first = check();
  if (first.length > 0) return finish(first, false);
  armRecheck();
  dispatchEvents.on("task", handler);
  req.on("close", () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    clearTimeout(recheck);
    dispatchEvents.off("task", handler);
  });
});

// Hook digest: everything ~/.dispatch/hook.sh needs in ONE cheap call.
// Never consumes anything. `since` (optional, UTC "YYYY-MM-DD HH:MM:SS")
// lets the Stop hook ask "did I report since my turn started?".
app.get("/hook/digest", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const unread = peekUnreadMessages(identity, {});
  const by = { low: 0, medium: 0, high: 0, immediate: 0 };
  for (const m of unread) by[m.priority] = (by[m.priority] || 0) + 1;
  const summarize = (m) => ({
    id: m.id,
    from_user: m.from_user,
    to_user: m.to_user,
    type: m.type,
    priority: m.priority,
    ack: m.ack,
    force: !!m.force,
    task_id: m.task_id,
    re: m.re,
    created_at: toDisplayTz(m.created_at),
    handling_until: m.handling_until || null,
    summary: m.body.length > 120 ? m.body.slice(0, 117).replace(/\s+/g, " ") + "..." : m.body.replace(/\s+/g, " "),
    chars: charCount(m.body),
    attachments: m.attachments.length,
  });
  const openTasks = getOpenTasksFor(identity).map((t) => ({
    ...t,
    created_at: toDisplayTz(t.created_at),
    updated_at: toDisplayTz(t.updated_at),
  }));
  const reportAt = lastReportAt(identity);
  res.json({
    handle: identity,
    server_time: utcNow(),
    unread: { total: unread.length, by_priority: by, items: unread.map(summarize) },
    immediate: localizeMessages(unread.filter((m) => m.priority === "immediate")),
    open_tasks: openTasks,
    unacked_required: unackedRequiredFor(identity).map((m) => ({ ...m, created_at: toDisplayTz(m.created_at) })),
    last_report_at: reportAt,
    reported_since: req.query.since ? !!(reportAt && reportAt >= String(req.query.since)) : undefined,
  });
});

// Hook-reported turn state: busy (UserPromptSubmit) / turn_end (Stop) /
// idle (Notification idle_prompt) / offline (SessionEnd).
app.post("/presence", express.json(), (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const state = req.body && String(req.body.state || "");
  if (!PRESENCE_STATES.includes(state)) {
    return res.status(400).json({ error: `state must be one of ${PRESENCE_STATES.join("|")}` });
  }
  const session = req.body.session ? String(req.body.session).slice(0, 120) : null;
  res.json(setPresenceState(identity, state, session));
});

// Fleet overview for `dispatch-fleet check` and the P2 dashboard: per
// handle, last contact, hook-reported state, inbox depth, open tasks.
app.get("/fleet", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const presence = new Map(getPresence().map((p) => [p.user, p]));
  const live = new Set(getLivePresence().map((p) => p.user));
  const rows = listUsers().map((u) => {
    const p = presence.get(u.handle);
    const depth = inboxDepth(u.handle);
    const open = getOpenTasksFor(u.handle);
    return {
      handle: u.handle,
      project: u.project || null,
      last_seen_at: toDisplayTz(u.last_seen_at),
      mcp_connected: live.has(u.handle),
      state: p?.state || null,
      state_at: toDisplayTz(p?.state_at || null),
      session: p?.session || null,
      unread: depth.n || 0,
      unread_high_plus: depth.high_plus || 0,
      oldest_unread_at: toDisplayTz(depth.oldest),
      open_tasks: open.length,
      unacked_tasks: open.filter((t) => t.ack_required && !t.acked_at).length,
    };
  });
  res.json({ requested_by: identity, server_time: toDisplayTz(utcNow()), handles: rows, projects: listProjects() });
});

// Project registry as the server sees it (bearer auth; used by
// `dispatch-fleet check` to verify fleet.json and the DB agree).
app.get("/projects", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const sum = projectSummary();
  res.json({
    ...sum,
    projects: sum.projects.map((p) => ({ ...p, tasks_dir: tasksDirForProject(p) })),
    default_tasks_dir: TASKS_DIR,
  });
});

// One message, full text. Only parties to it (sender, recipient, or anyone
// for a broadcast) may read it.
app.get("/msg/:id", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const m = getMessage(req.params.id);
  if (!m) return res.status(404).json({ error: `message ${req.params.id} not found` });
  if (m.to_user && m.to_user !== identity && m.from_user !== identity) {
    return res.status(403).json({ error: "not a party to this message" });
  }
  // ?read=1: reading it in full counts as reading it (dispatch-recv --full).
  if (req.query.read === "1" || req.query.read === "true") markMessageRead(identity, m.id);
  const out = localizeMessages([getMessage(m.id)])[0];
  if (m.task_id) out.task = getTask(m.task_id) || null;
  res.json(out);
});

// ── P2: task mirror + dashboard helpers ────────────────────────────

function thresholds() {
  return {
    staleHours: parseFloat(getSetting("task_stale_hours") || "4") || 4,
    maxContinuing: parseInt(getSetting("task_max_continuing") || "5", 10) || 5,
  };
}

function mirrorTask(taskId) {
  try {
    const t = getTask(taskId);
    if (!t) return null;
    const health = taskHealth(t, thresholds());
    const thread = t.thread_id ? threadFor(t.thread_id) : null;
    const path = writeTaskMirror(t, health, thread, tasksDirForProject(getProject(t.project)));
    dispatchEvents.emit("task", { type: "task_mirrored", task: { id: t.id, status: t.status }, actor: "server", recipients: [], timestamp: new Date().toISOString(), path });
    return path;
  } catch (e) {
    console.error(`[mirror] ${taskId}: ${e.message}`);
    return null;
  }
}

// Delivery / wake records — POSTed by hook.sh, the watcher and the CLI.
app.post("/wake", express.json(), (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const b = req.body || {};
  const method = String(b.method || "");
  const METHODS = ["hook", "wait-rewake", "keystroke", "blocked", "native-hint", "recv"];
  if (!METHODS.includes(method)) return res.status(400).json({ error: `method must be one of ${METHODS.join("|")}` });
  const ids = Array.isArray(b.message_ids) ? b.message_ids.map(String).slice(0, 50) : [];
  const handle = b.handle && identity !== b.handle ? String(b.handle) : identity; // a sender may record a hint for its recipient
  const n = recordDelivery(handle, method, ids, b.detail ? String(b.detail).slice(0, 300) : null);
  // A hook delivery means the agent has the text in front of it: give it
  // HANDLING_S before any other path (watcher keystroke, Wait rewake) may act.
  let handling = 0;
  if ((method === "hook" || method === "wait-rewake") && ids.length) handling = markHandling(ids, HANDLING_S);
  // Addressed to the handle it concerns: its own watcher may react, the
  // dashboard stream sees everything anyway, and the other watchers no longer
  // log an "fyi: delivery" line for every record on the host.
  dispatchEvents.emit("task", { type: "delivery", delivery: { handle, method, message_ids: ids, detail: b.detail || null }, actor: "server", recipients: [handle], timestamp: new Date().toISOString() });
  res.json({ ok: true, recorded: n, handling });
});
const HANDLING_S = parseInt(process.env.DISPATCH_HANDLING_S || "60", 10);

// Presence of the caller (watcher idle gate, T-20260903-09). `fresh` = the
// hook-reported state is younger than DISPATCH_PRESENCE_MAX_AGE_S (default 6h);
// older states are stale (session may have died) and callers fall back to
// screen-based detection.
const PRESENCE_MAX_AGE_S = parseInt(process.env.DISPATCH_PRESENCE_MAX_AGE_S || "21600", 10);
app.get("/presence/me", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const p = getPresence().find((x) => x.user === identity);
  const ageS = p?.state_at ? Math.round((Date.now() - new Date(p.state_at.replace(" ", "T") + "Z").getTime()) / 1000) : null;
  res.json({ handle: identity, state: p?.state || null, state_at: toDisplayTz(p?.state_at || null), age_s: ageS,
             fresh: ageS !== null && ageS <= PRESENCE_MAX_AGE_S, session: p?.session || null });
});

// ── P2: dashboard JSON API (JWT cookie) ────────────────────────────

function withDeliveries(msgs) {
  return msgs.map((m) => ({ ...m, created_at_display: toDisplayTz(m.created_at), deliveries: deliveriesFor(m.id) }));
}

// ?project=<name> scopes a dashboard view to one project; absent or "all" =
// everything. Unknown project → empty handle list → empty view (not an error,
// the switcher may remember a project that was removed since).
function projectScope(req) {
  const p = req.query.project ? String(req.query.project).trim() : "";
  if (!p || p === "all") return { project: null, handles: null };
  return { project: p, handles: handlesInProject(p) };
}

app.get("/api/messages", requireJwt, (req, res) => {
  const q = req.query;
  const scope = projectScope(req);
  const rows = listMessages({
    from: q.from || null, to: q.to || null, type: q.type || null,
    priority: q.priority ? normalizePriority(q.priority) : null, status: q.status || null,
    task: q.task || null, since: q.since || null, until: q.until || null, q: q.q || null,
    limit: parseInt(q.limit || "200", 10) || 200,
    handles: scope.handles,
  });
  res.json({ count: rows.length, messages: withDeliveries(rows) });
});

app.get("/api/messages/:id", requireJwt, (req, res) => {
  const m = getMessage(req.params.id);
  if (!m) return res.status(404).json({ error: "not found" });
  res.json(withDeliveries([m])[0]);
});

app.get("/api/messages/:id/thread", requireJwt, (req, res) => {
  const t = threadFor(req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json({ ...t, messages: withDeliveries(t.messages), task: t.task_id ? getTask(t.task_id) : null });
});

app.get("/api/inbox", requireJwt, (req, res) => {
  const presence = new Map(getPresence().map((p) => [p.user, p]));
  const { kindOf } = classifyHandles();
  const order = { local: 0, remote: 1 };
  const scope = projectScope(req);
  const rows = listUsers().filter((u) => kindOf(u.handle) !== "retired" && (!scope.project || u.project === scope.project)).map((u) => {
    const d = inboxDepth(u.handle);
    const p = presence.get(u.handle);
    const unacked = unackedRequiredFor(u.handle);
    const open = getOpenTasksFor(u.handle);
    return {
      handle: u.handle, kind: kindOf(u.handle), project: u.project || null, last_seen_at: toDisplayTz(u.last_seen_at), last_seen_ip: u.last_seen_ip || null,
      state: p?.state || null, state_at: toDisplayTz(p?.state_at || null), session: p?.session || null,
      unread: d.n || 0, unread_high_plus: d.high_plus || 0,
      oldest_unread_at: toDisplayTz(d.oldest), oldest_unread_age_s: d.oldest ? Math.round((Date.now() - new Date(d.oldest.replace(" ", "T") + "Z").getTime()) / 1000) : null,
      unacked_messages: unacked.map((m) => m.id),
      open_tasks: open.map((t) => t.id),
      unacked_tasks: open.filter((t) => t.ack_required && !t.acked_at).map((t) => t.id),
    };
  }).sort((a, b) => (order[a.kind] - order[b.kind]) || a.handle.localeCompare(b.handle));
  res.json({ server_time: toDisplayTz(utcNow()), project: scope.project, handles: rows });
});

app.get("/api/projects", requireJwt, (req, res) => {
  const sum = projectSummary();
  res.json({ ...sum, projects: sum.projects.map((p) => ({ ...p, tasks_dir: tasksDirForProject(p) })), default_tasks_dir: TASKS_DIR });
});

// Fleet health = the CLI's `dispatch-fleet check --json` (so the page and the
// CLI cannot disagree) merged with live presence. Cached for 5 s.
let fleetCache = { at: 0, data: null };
function fleetCheck(cb) {
  if (Date.now() - fleetCache.at < 5000 && fleetCache.data) return cb(fleetCache.data);
  const cli = process.env.DISPATCH_FLEET_CLI || `${homedir()}/.dispatch/dispatch-fleet`;
  let tmpdir = process.env.TMUX_TMPDIR;
  try {
    const f = JSON.parse(readFileSyncFs(`${homedir()}/.dispatch/fleet.json`, "utf8"));
    tmpdir = tmpdir || f.tmux_tmpdir;
  } catch { /* no fleet.json */ }
  const env = { ...process.env, DISPATCH_URL: `http://127.0.0.1:${PORT}` };
  if (tmpdir) env.TMUX_TMPDIR = tmpdir;
  execFile("python3", [cli, "check", "--json"], { env, timeout: 20000, maxBuffer: 4 << 20 }, (err, out) => {
    let data;
    try { data = JSON.parse(out); } catch { data = { server_error: err ? err.message : "bad output", rows: [] }; }
    data.checked_at = toDisplayTz(utcNow());
    fleetCache = { at: Date.now(), data };
    cb(data);
  });
}

// Local rows come from dispatch-fleet check (this host's tmux panes).
// `remote` = server users that are neither in fleet.json nor retired — agents
// on other hosts reached over a tunnel. `retired` is fleet.json's
// list, shown collapsed so look-alike names (codex vs kernel-codex) don't
// confuse anyone.
function localFleetFile() {
  try { return JSON.parse(readFileSyncFs(`${homedir()}/.dispatch/fleet.json`, "utf8")); } catch { return {}; }
}
// One classification for every handle-listing surface (inbox strip, filter
// menus, composer, Fleet tab): local = in this host's fleet.json, retired =
// in its retired list (never shown), remote = everything else on the server.
function classifyHandles() {
  const fleet = localFleetFile();
  const local = new Set(Object.keys(fleet.handles || {}));
  const retired = new Set(fleet.retired || []);
  return { fleet, kindOf: (h) => (retired.has(h) ? "retired" : local.has(h) ? "local" : "remote") };
}
app.get("/api/fleet", requireJwt, (req, res) => {
  const scope = projectScope(req);
  fleetCheck((data) => {
    const presence = new Map(getPresence().map((p) => [p.user, p]));
    const rows = (data.rows || []).map((r) => {
      const p = presence.get(r.handle);
      return { ...r, project: r.project || projectOf(r.handle), presence_state: p?.state || null, presence_at: toDisplayTz(p?.state_at || null), presence_session: p?.session || null };
    }).filter((r) => !scope.project || r.project === scope.project);
    const { fleet, kindOf } = classifyHandles();
    const retired = fleet.retired || [];
    const rowHandles = new Set(rows.map((r) => r.handle));
    const remote = listUsers()
      .filter((u) => kindOf(u.handle) === "remote" && !rowHandles.has(u.handle) && (!scope.project || u.project === scope.project))
      .map((u) => {
        const p = presence.get(u.handle);
        const d = inboxDepth(u.handle);
        return {
          handle: u.handle, project: u.project || null, last_seen_at: toDisplayTz(u.last_seen_at), last_seen_ip: u.last_seen_ip || null,
          presence_state: p?.state || null, presence_at: toDisplayTz(p?.state_at || null), presence_session: p?.session || null,
          unread: d.n || 0, unread_high_plus: d.high_plus || 0, oldest_unread_at: toDisplayTz(d.oldest),
          open_tasks: getOpenTasksFor(u.handle).length,
        };
      });
    res.json({ ...data, rows, remote, retired, project: scope.project, projects: projectSummary().projects });
  });
});

app.get("/api/tasks", requireJwt, (req, res) => {
  const th = thresholds();
  const scope = projectScope(req);
  const tasks = listAllTasks(parseInt(req.query.limit || "300", 10) || 300, scope).map((t) => ({
    ...t, health: taskHealth(t, th),
    created_at_display: toDisplayTz(t.created_at), updated_at_display: toDisplayTz(t.updated_at), acked_at_display: toDisplayTz(t.acked_at),
  }));
  res.json({ thresholds: th, project: scope.project, tasks });
});

app.get("/api/settings", requireJwt, (req, res) => {
  res.json({ task_stale_hours: thresholds().staleHours, task_max_continuing: thresholds().maxContinuing, tasks_dir: TASKS_DIR,
    projects: listProjects().map((p) => ({ ...p, tasks_dir: tasksDirForProject(p) })) });
});

app.post("/api/settings", requireJwt, express.json(), (req, res) => {
  const b = req.body || {};
  if (b.task_stale_hours !== undefined) {
    const v = parseFloat(b.task_stale_hours);
    if (!(v > 0 && v < 1000)) return res.status(400).json({ error: "task_stale_hours must be 0 < h < 1000" });
    setSetting("task_stale_hours", String(v));
  }
  if (b.task_max_continuing !== undefined) {
    const v = parseInt(b.task_max_continuing, 10);
    if (!(v > 0 && v < 1000)) return res.status(400).json({ error: "task_max_continuing must be 0 < n < 1000" });
    setSetting("task_max_continuing", String(v));
  }
  res.json({ ok: true, task_stale_hours: thresholds().staleHours, task_max_continuing: thresholds().maxContinuing });
});

app.get("/api/decisions", requireJwt, (req, res) => {
  const scope = projectScope(req);
  res.json({ project: scope.project, requests: withDeliveries(openRequests({ handles: scope.handles })) });
});

// Send a message AS the logged-in dashboard account. Used by the decisions
// panel (GO / NO-GO with re=<request id>) and the free-form composer. The
// sender is the JWT subject — a human logs in as the `user` handle, so
// decisions arrive with from=user. Same validation as the CLI path.
app.post("/api/send", requireJwt, express.json(), (req, res) => {
  const r = handleSend(req.user.handle, req.body || {});
  res.status(r.status).json(r.body);
});

app.post("/api/decide", requireJwt, express.json(), (req, res) => {
  const b = req.body || {};
  const reqMsg = b.re ? getMessage(String(b.re)) : null;
  if (!reqMsg || reqMsg.type !== "request_permission") return res.status(404).json({ error: "re must be an open request_permission message id" });
  const decision = String(b.decision || "").toUpperCase();
  if (!["GO", "NO-GO"].includes(decision)) return res.status(400).json({ error: "decision must be GO or NO-GO" });
  const note = b.note ? " — " + String(b.note) : "";
  const r = handleSend(req.user.handle, {
    to: reqMsg.from_user, re: reqMsg.id, type: "info",
    priority: b.priority ? normalizePriority(b.priority) || "high" : "high",
    body: `[${decision}] re ${reqMsg.id}${note}`,
  });
  res.status(r.status).json(r.body);
});

app.post("/api/tasks/mirror-all", requireJwt, (req, res) => {
  const out = [];
  const scope = projectScope(req);
  for (const t of listAllTasks(1000, scope)) if (/^T-\d{8}-\d+$/.test(t.id)) out.push({ id: t.id, project: t.project || null, path: mirrorTask(t.id) });
  const dirs = [...new Set(out.map((o) => o.path && o.path.replace(/\/[^/]+$/, "")).filter(Boolean))];
  res.json({ mirrored: out.length, tasks_dir: dirs.length === 1 ? dirs[0] : TASKS_DIR, tasks_dirs: dirs, files: out });
});

app.get("/api/deliveries", requireJwt, (req, res) => {
  const since = req.query.since || new Date(Date.now() - 24 * 3600e3).toISOString().replace("T", " ").slice(0, 19);
  res.json({ since, deliveries: recentDeliveries(since).map((d) => ({ ...d, created_at: toDisplayTz(d.created_at) })) });
});

// Live event stream for the dashboard — every event, no recipient filter.
app.get("/api/events", requireJwt, (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(`: dashboard stream for ${req.user.handle}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* closed */ } }, 25000);
  const handler = (event) => {
    try {
      const e = { ...event };
      if (e.message) e.message = { ...e.message, created_at_display: toDisplayTz(e.message.created_at) };
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    } catch { /* closed */ }
  };
  dispatchEvents.on("task", handler);
  req.on("close", () => { clearInterval(heartbeat); dispatchEvents.off("task", handler); });
});

// ── Dashboard auth (JWT cookie) ────────────────────────────────────
//
// /api/login takes {handle, password}, verifies the bcrypt hash from
// the users table, and mints a short-lived JWT into an HttpOnly cookie.
// Dashboard credentials (password) are intentionally separate from MCP
// credentials (bearer token) — losing one shouldn't grant the other.

app.post("/api/login", express.json(), async (req, res) => {
  const handle =
    req.body && typeof req.body.handle === "string" ? req.body.handle.trim() : "";
  const password =
    req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!handle || !password) {
    return res.status(400).json({ error: "請輸入帳號與密碼" });
  }
  const user = getUserByHandle(handle);
  // verifyPassword burns equivalent CPU when user/hash is missing, so
  // attackers can't enumerate handles by timing the response.
  const ok = await verifyPassword(password, user ? user.password_hash : null);
  if (!user || !ok) {
    return res.status(401).json({ error: "帳號或密碼錯誤" });
  }
  touchUser(user.handle, req.ip);
  const jwt = signJwt(user.handle);
  res.cookie(JWT_COOKIE, jwt, cookieOptions());
  res.json({ ok: true, handle: user.handle });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(JWT_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.get("/api/whoami", requireJwt, (req, res) => {
  res.json({ handle: req.user.handle });
});

app.post("/api/change-password", requireJwt, express.json(), async (req, res) => {
  const current =
    req.body && typeof req.body.current_password === "string"
      ? req.body.current_password
      : "";
  const next =
    req.body && typeof req.body.new_password === "string" ? req.body.new_password : "";
  if (!current || !next) {
    return res.status(400).json({ error: "請輸入目前密碼與新密碼" });
  }
  if (next.length < 8) {
    return res.status(400).json({ error: "新密碼至少需 8 個字元" });
  }
  if (next === current) {
    return res.status(400).json({ error: "新密碼必須與目前密碼不同" });
  }
  // Identity comes from the JWT, never from the request body — a user
  // can only change their own password.
  const user = getUserByHandle(req.user.handle);
  const ok = user && (await verifyPassword(current, user.password_hash));
  if (!ok) {
    return res.status(401).json({ error: "目前密碼錯誤" });
  }
  const hash = await hashPassword(next);
  setUserPasswordHash(user.handle, hash);
  res.json({ ok: true });
});

// ── JSON API for the dashboard ─────────────────────────────────────
// Gated by JWT cookie. The MCP endpoints above stay on bearer auth.

app.get("/api/tasks", requireJwt, (req, res) => {
  const tasks = listTasks({ all: true, limit: 100 });
  res.json(tasks);
});

app.get("/api/presence", requireJwt, (req, res) => {
  res.json(getLivePresence());
});

// Option E — dashboard polls this to check for unacknowledged outbound
// completions. Does NOT advance the "seen" timestamp, so polling alone
// won't dismiss the badge.
app.get("/api/recent-completions", requireJwt, (req, res) => {
  const rows = getPendingCompletions(req.user.handle);
  res.json(rows);
});

// Option E — explicit "I've seen these" ack from the dashboard.
// Clicking the completions badge / closing the drawer POSTs here.
app.post("/api/recent-completions/ack", requireJwt, (req, res) => {
  markCompletionsSeen(req.user.handle);
  res.json({ ok: true });
});

app.get("/api/tasks/:id", requireJwt, (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "找不到任務" });
  res.json(task);
});

// ── Dashboard ──────────────────────────────────────────────────────

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
const loginHtml = readFileSync(join(__dirname, "login.html"), "utf-8");

app.get("/login", (req, res) => {
  res.type("html").send(loginHtml);
});

app.get("/", requireJwt, (req, res) => {
  res.type("html").send(dashboardHtml);
});

// ── Start ──────────────────────────────────────────────────────────

app.listen(PORT, BIND, () => {
  const p = String(PORT).padEnd(5);
  console.log(`
╔══════════════════════════════════════════════════╗
║          dispatch-mcp server running             ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  MCP endpoint:  http://0.0.0.0:${p}/sse        ║
║  Dashboard:     http://0.0.0.0:${p}/           ║
║                                                  ║
║  Manage users: node src/admin.js add <handle>    ║
║  All MCP connections require a bearer token.     ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
