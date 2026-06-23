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
} from "./store.js";
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
      body: z.string().describe("The message text."),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Priority hint."),
    },
    async ({ to, body, priority }) => {
      if (to && to !== "all" && !getUserByHandle(to)) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify(
              {
                delivered: false,
                error: `unknown recipient handle '${to}' — message NOT delivered. Known handles: ${listUsers()
                  .map((u) => u.handle)
                  .join(", ")}`,
              },
              null,
              2
            ),
          }],
        };
      }
      const message = sendMessage({
        from_user: identity,
        to_user: to || null,
        body,
        priority: priority || "normal",
      });
      emitMessageEvent(message, identity);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            { delivered: true, to: to || "(broadcast)", id: message.id },
            null,
            2
          ),
        }],
      };
    }
  );

  // ── my_messages ────────────────────────────────────────────────
  server.tool(
    "my_messages",
    "Drain your unread messages (directed to you or broadcast). Each message is returned once — reading it marks it delivered. Call this when your watcher pokes you, or at the start of a session.",
    {},
    async () => {
      const messages = pullUnreadMessages(identity);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "📭 No unread messages." }] };
      }
      const lines = [`📬 ${messages.length} unread message(s):`];
      for (const m of messages) {
        const pri = m.priority && m.priority !== "normal" ? ` [${m.priority}]` : "";
        const scope = m.to_user ? "" : " (broadcast)";
        lines.push(`  • from ${m.from_user}${scope}${pri} @ ${m.created_at}`);
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

// ── Plain HTTP message API (for the shell CLI) ─────────────────────
//
// dispatch-send / dispatch-recv talk to these. Bearer-authed, identity
// from the token. Same store + event bus as the MCP tools, so an
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

app.post("/msg/send", express.json(), (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const { to, body, priority } = req.body || {};
  if (!body || typeof body !== "string") {
    res.status(400).json({ error: "body (string) is required" });
    return;
  }
  // Reject directed messages to unknown handles — otherwise the message is
  // silently stored under a recipient nobody polls and is never delivered.
  if (to && to !== "all" && !getUserByHandle(to)) {
    res.status(404).json({
      delivered: false,
      error: `unknown recipient handle '${to}' — message NOT delivered. Known handles: ${listUsers()
        .map((u) => u.handle)
        .join(", ")}`,
    });
    return;
  }
  const message = sendMessage({
    from_user: identity,
    to_user: to || null,
    body,
    priority: priority || "normal",
  });
  emitMessageEvent(message, identity);
  res.json({ delivered: true, id: message.id, to: to || "(broadcast)" });
});

app.get("/msg/recv", (req, res) => {
  const identity = httpIdentity(req, res);
  if (!identity) return;
  const messages = pullUnreadMessages(identity);
  res.json({ handle: identity, count: messages.length, messages });
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

app.listen(PORT, "0.0.0.0", () => {
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
