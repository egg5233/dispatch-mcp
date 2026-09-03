// Display-timezone helpers shared by server.js (message rendering) and
// store.js (human-facing task ids like T-YYYYMMDD-NN).
//
// Timestamps are STORED as UTC (SQLite datetime('now')). Only agent-facing
// surfaces render them in the fleet's wall-clock zone, with an explicit
// offset suffix so nobody mistakes a UTC string for local time.
export const DISPLAY_TZ = process.env.DISPATCH_TZ || "Asia/Taipei";
export const DISPLAY_TZ_SUFFIX = process.env.DISPATCH_TZ_SUFFIX || "+08";

export function toDisplayTz(utcStr) {
  if (!utcStr || typeof utcStr !== "string") return utcStr;
  const d = new Date(utcStr.replace(" ", "T") + "Z"); // stored value is UTC
  if (isNaN(d.getTime())) return utcStr;
  // sv-SE locale yields an ISO-like "YYYY-MM-DD HH:MM:SS"
  return d.toLocaleString("sv-SE", { timeZone: DISPLAY_TZ }) + DISPLAY_TZ_SUFFIX;
}

export function localizeMessages(msgs) {
  return msgs.map((m) => ({ ...m, created_at: toDisplayTz(m.created_at) }));
}

// "YYYYMMDD" in the display zone — used for task ids.
export function localDateStamp(date = new Date()) {
  return date.toLocaleString("sv-SE", { timeZone: DISPLAY_TZ }).slice(0, 10).replace(/-/g, "");
}

// SQLite-compatible UTC "YYYY-MM-DD HH:MM:SS".
export function utcNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}
