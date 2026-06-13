// JWT-based auth for the dashboard (HTML at / and JSON at /api/*).
//
// Model: the user already has a bearer token (from `node src/admin.js add`).
// They POST it once to /api/login, we validate it against the users table,
// and we mint a short-lived JWT that rides in an HttpOnly cookie. All
// dashboard routes check that cookie via requireJwt.
//
// The MCP endpoints (/sse, /messages) keep using bearer auth — they're
// called by Claude Code, not by a browser, so cookies don't apply.

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { getSetting, setSetting } from "./store.js";

// ── Password hashing ───────────────────────────────────────────────

const BCRYPT_COST = 12;

// A real bcrypt hash computed once at startup. Used as a stand-in
// when login is attempted for a non-existent user, so the response
// time matches "wrong password" and attackers can't enumerate handles
// by looking at how fast /api/login fails.
const DUMMY_HASH = bcrypt.hashSync("__no_user__", BCRYPT_COST);

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain, hash) {
  if (!hash) {
    // Burn equivalent CPU so we don't leak existence via timing.
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export const JWT_COOKIE = "dispatch_jwt";
const TTL_SECONDS = 24 * 60 * 60; // 24h

// Secret resolution: env var wins (so ops can rotate without DB writes),
// otherwise a random secret is generated on first boot and persisted.
// Persisting matters — regenerating on every restart would invalidate
// every existing session and force everyone to log in again.
function resolveSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) {
    return process.env.JWT_SECRET;
  }
  const existing = getSetting("jwt_secret");
  if (existing) return existing;
  const generated = randomBytes(32).toString("hex");
  setSetting("jwt_secret", generated);
  return generated;
}

const SECRET = resolveSecret();

export function signJwt(handle) {
  return jwt.sign({ sub: handle }, SECRET, { expiresIn: TTL_SECONDS });
}

export function verifyJwt(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

// Inline cookie parsing — one fewer dependency than cookie-parser.
function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

export function extractJwt(req) {
  const cookies = parseCookies(req);
  return cookies[JWT_COOKIE] || null;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: TTL_SECONDS * 1000,
    // Enable Secure-only cookies when the server sits behind TLS.
    // Opt-in via env var so LAN deployments over plain HTTP still work.
    secure: process.env.JWT_COOKIE_SECURE === "1" || process.env.JWT_COOKIE_SECURE === "true",
  };
}

// Express middleware. /api/* routes always get JSON 401 so XHR clients
// can react sensibly; everything else (i.e. the dashboard HTML) gets a
// 302 redirect to /login. Path-based detection is more reliable than
// sniffing the Accept header — curl sends */* and would otherwise be
// misclassified as a browser.
export function requireJwt(req, res, next) {
  const token = extractJwt(req);
  const payload = token ? verifyJwt(token) : null;
  if (!payload) {
    if (req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "尚未登入" });
    }
    return res.redirect("/login");
  }
  req.user = { handle: payload.sub };
  next();
}

export const JWT_TTL_SECONDS = TTL_SECONDS;
