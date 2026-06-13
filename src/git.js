// Server-side git helpers. Each registered repo has a bare clone at
// data/repos/<sanitized-name>.git, which dispatch-mcp uses to verify
// commits, compute diff stats, and read file contents at specific
// revisions. The server never has a working tree — bare clones are
// enough for all our verification needs.
//
// Security: every git invocation uses execFile (not exec) and passes
// user-controlled values as separate argv entries, so the shell never
// interprets them. Repo names are sanitized before being used in paths.

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  addRepo as storeAddRepo,
  getRepo,
  listRepos as storeListRepos,
  removeRepo as storeRemoveRepo,
  touchRepoFetched,
} from "./store.js";

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPOS_DIR = resolve(join(__dirname, "..", "data", "repos"));
mkdirSync(REPOS_DIR, { recursive: true });

// ── Name sanitization ──────────────────────────────────────────────

// Strict allowlist: letters, digits, dash, underscore. Anything else
// is a user error — reject loudly rather than silently normalizing,
// so the operator notices before they rely on a weird name.
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function assertValidName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new Error(
      `Invalid repo name '${name}'. Use letters, digits, dash, or underscore only.`
    );
  }
}

function clonePathFor(name) {
  assertValidName(name);
  return join(REPOS_DIR, `${name}.git`);
}

// ── Thin wrapper around execFile with git ──────────────────────────

async function git(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      // Limit output to something sane so a runaway command doesn't
      // eat all our memory. 10 MB is enough for any realistic diff.
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { stdout, stderr };
  } catch (e) {
    // Normalize execFile errors so callers get a useful message.
    const err = new Error(
      `git ${args.join(" ")} failed: ${e.stderr || e.message}`.trim()
    );
    err.code = e.code;
    err.stderr = e.stderr;
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────

export async function registerRepo(name, remoteUrl) {
  assertValidName(name);
  if (!remoteUrl || typeof remoteUrl !== "string") {
    throw new Error("remoteUrl is required");
  }
  const existing = getRepo(name);
  if (existing) {
    throw new Error(`Repo '${name}' is already registered`);
  }
  const clonePath = clonePathFor(name);
  if (existsSync(clonePath)) {
    throw new Error(
      `Clone directory ${clonePath} already exists. Remove it first or pick a different name.`
    );
  }
  // Bare clone into data/repos/<name>.git
  await git(["clone", "--bare", "--quiet", remoteUrl, clonePath]);
  // Enable fetching of all branches via `git fetch` without arguments
  await git([
    "-C",
    clonePath,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  return storeAddRepo(name, remoteUrl, clonePath);
}

export async function unregisterRepo(name) {
  assertValidName(name);
  const repo = getRepo(name);
  if (!repo) return false;
  // Delete the DB row first so nothing new can reference this repo,
  // then remove the clone directory.
  storeRemoveRepo(name);
  if (existsSync(repo.clone_path)) {
    // Use rm -rf via node fs. Shelling out would be simpler but we
    // avoid an external process.
    const { rmSync } = await import("fs");
    rmSync(repo.clone_path, { recursive: true, force: true });
  }
  return true;
}

export async function fetchRepo(name) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  await git(["-C", repo.clone_path, "fetch", "--quiet", "origin"]);
  touchRepoFetched(name);
}

export async function verifyCommit(name, commit) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  if (!/^[a-f0-9]{4,40}$/i.test(commit)) {
    return false;
  }
  try {
    await git(["-C", repo.clone_path, "cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Verify that `commit` exists; if not, fetch and try once more. This is
// the usual entry point for tools that need to accept a commit from a
// client — the client may have pushed to the remote moments ago and the
// server's bare clone hasn't seen it yet.
export async function verifyCommitWithFetch(name, commit) {
  if (await verifyCommit(name, commit)) return true;
  try {
    await fetchRepo(name);
  } catch {
    return false;
  }
  return verifyCommit(name, commit);
}

export async function resolveRef(name, ref) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  try {
    const { stdout } = await git(["-C", repo.clone_path, "rev-parse", ref]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getDiffStats(name, base, head) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  try {
    const { stdout } = await git([
      "-C",
      repo.clone_path,
      "diff",
      "--shortstat",
      `${base}...${head}`,
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function getDiffFiles(name, base, head) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  try {
    const { stdout } = await git([
      "-C",
      repo.clone_path,
      "diff",
      "--name-status",
      `${base}...${head}`,
    ]);
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [status, ...parts] = line.split(/\s+/);
        return { status, path: parts.join(" ") };
      });
  } catch {
    return [];
  }
}

export async function getFileAtCommit(name, commit, path) {
  const repo = getRepo(name);
  if (!repo) throw new Error(`Unknown repo: ${name}`);
  try {
    const { stdout } = await git([
      "-C",
      repo.clone_path,
      "show",
      `${commit}:${path}`,
    ]);
    return stdout;
  } catch {
    return null;
  }
}

export function listRepos() {
  return storeListRepos();
}

export { REPOS_DIR };
