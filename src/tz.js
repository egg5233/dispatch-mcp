// Display-timezone helpers shared by server.js (message rendering) and
// store.js (human-facing task ids like T-YYYYMMDD-NN).
//
// Timestamps are STORED as UTC (SQLite datetime('now')). Only agent-facing
// surfaces render them in the fleet's wall-clock zone, with an explicit
// offset suffix so nobody mistakes a UTC string for local time.
// Defaults are host-neutral: the zone is the server host's own zone
// (override with DISPATCH_TZ, e.g. a fleet whose operator lives elsewhere)
// and the suffix is derived from that zone's UTC offset at the timestamp in
// question (override with DISPATCH_TZ_SUFFIX to pin a fixed label).
function hostZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
export const DISPLAY_TZ = process.env.DISPATCH_TZ || hostZone();

// "+08", "-05", "+05:30" for `tz` at instant `d`.
export function offsetSuffix(tz = DISPLAY_TZ, d = new Date()) {
  if (process.env.DISPATCH_TZ_SUFFIX) return process.env.DISPATCH_TZ_SUFFIX;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d);
    const name = (parts.find((p) => p.type === "timeZoneName") || {}).value || "GMT";
    const m = /GMT([+-]\d{2})(?::?(\d{2}))?/.exec(name);
    if (!m) return "+00";
    return m[2] && m[2] !== "00" ? `${m[1]}:${m[2]}` : m[1];
  } catch { return "+00"; }
}
export const DISPLAY_TZ_SUFFIX = offsetSuffix();

export function toDisplayTz(utcStr) {
  if (!utcStr || typeof utcStr !== "string") return utcStr;
  const d = new Date(utcStr.replace(" ", "T") + "Z"); // stored value is UTC
  if (isNaN(d.getTime())) return utcStr;
  // sv-SE locale yields an ISO-like "YYYY-MM-DD HH:MM:SS"
  return d.toLocaleString("sv-SE", { timeZone: DISPLAY_TZ }) + offsetSuffix(DISPLAY_TZ, d);
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
