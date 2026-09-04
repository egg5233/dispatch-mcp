// Task → markdown mirror (dispatch v2 P2). Every state change of a
// message-created task (T-YYYYMMDD-NN) rewrites
//   <DISPATCH_TASKS_DIR>/T-YYYYMMDD-NN[-slug].md
// with the frontmatter the coordination/ tree uses (title/type/task/agent/
// date/git/status) plus the task's report timeline. Best-effort: a write
// failure is logged and never fails the request that triggered it.
import { mkdirSync, writeFileSync, readdirSync, renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { toDisplayTz } from "./tz.js";

// Fallback directory for tasks that belong to no project (or to a project
// without a coordination_dir): DISPATCH_TASKS_DIR, else <data dir>/tasks.
// Every registered project mirrors into its own coordination_dir/tasks/.
const DATA_DIR = process.env.DISPATCH_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "data");
export const TASKS_DIR = process.env.DISPATCH_TASKS_DIR || join(DATA_DIR, "tasks");

// Multi-project (T-20260903-20): a task mirrors into its project's
// coordination/tasks/. Tasks without a project (or a project without a
// coordination_dir) keep using TASKS_DIR, i.e. exactly the pre-project path.
export function tasksDirForProject(project) {
  if (project && project.coordination_dir) return join(String(project.coordination_dir), "tasks");
  return TASKS_DIR;
}

// Unicode-aware slug: letters and digits of any script survive (a Chinese
// title stays readable), everything else collapses to "-", ≤ 40 code points.
function slug(title) {
  const s = String(title || "")
    .toLowerCase()
    .replace(/…/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return [...s].slice(0, 40).join("").replace(/-+$/g, "");
}

function yamlStr(v) {
  if (v === null || v === undefined) return '""';
  const s = String(v);
  return JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars
}

export function renderTaskMarkdown(task, health, thread) {
  const fm = [
    ["title", task.title],
    ["type", "task"],
    ["task", task.id],
    ["agent", task.claimed_by || task.to_user || ""],
    ["date", toDisplayTz(task.created_at).slice(0, 10)],
    ["git", task.head_commit ? `${task.head_branch || ""} @ ${task.head_commit}` : ""],
    ["status", task.status],
    ["from", task.from_user],
    ["to", task.to_user || ""],
    ["priority", task.priority],
    ["ack_required", task.ack_required ? "true" : "false"],
    ["acked_at", toDisplayTz(task.acked_at) || ""],
    ["thread", task.thread_id || ""],
    ["updated", toDisplayTz(task.updated_at)],
    ["mirror", "dispatch-mcp (auto-generated; edits here are overwritten)"],
  ];
  const lines = ["---"];
  for (const [k, v] of fm) lines.push(`${k}: ${yamlStr(v)}`);
  lines.push("---", "", `# ${task.id} — ${task.title}`, "");
  lines.push(task.description || "", "");
  if (task.documents && task.documents.length) {
    lines.push("## Attachments", "");
    for (const d of task.documents) lines.push(`- ${typeof d === "string" ? d : d.path}`);
    lines.push("");
  }
  lines.push("## Timeline", "");
  lines.push(`- ${toDisplayTz(task.created_at)}  created by ${task.from_user} → ${task.to_user || "(anyone)"}`);
  if (task.acked_at) lines.push(`- ${toDisplayTz(task.acked_at)}  acked by ${task.claimed_by || task.to_user || "?"}`);
  for (const r of health.reports || []) {
    lines.push(`- ${toDisplayTz(r.created_at)}  report [${(r.state || "").toUpperCase()}] by ${r.from_user}: ${String(r.summary || "").replace(/\s+/g, " ")}`);
  }
  if (task.status === "closed" || task.status === "cancelled") {
    lines.push(`- ${toDisplayTz(task.updated_at)}  ${task.status}${task.result ? ": " + String(task.result).replace(/\s+/g, " ") : ""}`);
  }
  if (health.flags && health.flags.length) {
    lines.push("", "## Flags", "");
    for (const f of health.flags) lines.push(`- ${f}`);
  }
  if (thread && thread.messages && thread.messages.length) {
    lines.push("", "## Thread", "");
    for (const m of thread.messages) {
      lines.push(`- ${toDisplayTz(m.created_at)}  ${m.id}  ${m.from_user} → ${m.to_user || "all"}  <${m.type}> ${m.priority}${m.state ? " [" + m.state.toUpperCase() + "]" : ""}: ${String(m.body).replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function taskFilename(task) {
  const sl = slug(task.title);
  return `${task.id}${sl ? "-" + sl : ""}.md`;
}

export function writeTaskMirror(task, health, thread, dir = TASKS_DIR) {
  if (!task || !/^T-\d{8}-\d+$/.test(task.id)) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const name = taskFilename(task);
    // an older file for the same id with a different slug is renamed, not duplicated
    for (const f of readdirSync(dir)) {
      if (f !== name && f.startsWith(task.id) && f.endsWith(".md")) {
        try { renameSync(join(dir, f), join(dir, name)); } catch { /* ignore */ }
      }
    }
    const path = join(dir, name);
    const tmp = path + ".tmp";
    writeFileSync(tmp, renderTaskMarkdown(task, health, thread));
    renameSync(tmp, path);
    return path;
  } catch (e) {
    console.error(`[mirror] ${task.id}: ${e.message}`);
    return null;
  }
}

export function mirrorExists() {
  return existsSync(TASKS_DIR);
}
