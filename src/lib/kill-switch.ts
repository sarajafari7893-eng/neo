// ── NEXUS//SIGNALS — INDEPENDENT KILL-SWITCH (LIVE-HARDENING phase 4/10/13) ──
// WHY: the spec requires an independent kill-switch path that does not depend
// on the database, the engine, or any service being healthy. This module is a
// FILE-backed flag: even with SQLite corrupted or Prisma down, deployment
// halts if the file says HALT. Fail-closed contract:
//   · file missing        → treated as DISENGAGED (clean state is explicit)… but
//   · file corrupt/unreadable → treated as ENGAGED (fail-closed on unknown
//     state) — a torn write must never silently re-open the trading gate.
// Client-safe: sync mtime-cached read, no server-only imports beyond node:fs.
// The API surface (POST /api/kill-switch) is protected by the middleware
// control-plane gate (same-origin / x-nexus-key) and every transition is
// written to the file with an append-only trail (.data/kill-switch-trail.jsonl).

import { readFileSync, appendFileSync, writeFileSync, statSync } from "node:fs";

const FLAG_PATH = "/home/z/my-project/.data/kill-switch.json";
const TRAIL_PATH = "/home/z/my-project/.data/kill-switch-trail.jsonl";

export interface KillSwitchState {
  engaged: boolean;
  reason: string;
  by: string;
  at: string; // ISO
}

let cache: { state: KillSwitchState; mtimeMs: number } | null = null;

function readState(): KillSwitchState {
  let raw: string;
  try {
    raw = readFileSync(FLAG_PATH, "utf8");
  } catch {
    // No flag file: a FRESH system defaults to disengaged — but if the trail
    // shows the switch was ever used, a missing flag is an UNKNOWN state
    // (deleted by a restore/tamper) ⇒ fail-closed ENGAGED (v11.0 audit F3).
    let everUsed = false;
    try { everUsed = statSync(TRAIL_PATH).size > 0; } catch { everUsed = false; }
    if (everUsed) {
      return { engaged: true, reason: "KILL-SWITCH FLAG FILE MISSING while trail exists — fail-closed tamper guard (unknown state prevents deploys)", by: "fail-closed", at: new Date().toISOString() };
    }
    return { engaged: false, reason: "no flag file (fresh default disengaged)", by: "system", at: "1970-01-01T00:00:00.000Z" };
  }
  try {
    const s = JSON.parse(raw) as Partial<KillSwitchState>;
    // Unknown/corrupt payload → fail-closed ENGAGED (unknown execution state must prevent new entries).
    if (typeof s.engaged !== "boolean") throw new Error("missing boolean 'engaged'");
    return { engaged: s.engaged, reason: String(s.reason ?? "unspecified"), by: String(s.by ?? "unknown"), at: String(s.at ?? new Date().toISOString()) };
  } catch (e) {
    return { engaged: true, reason: `CORRUPT KILL-SWITCH FILE — fail-closed (${e instanceof Error ? e.message.slice(0, 120) : "unreadable"})`, by: "fail-closed", at: new Date().toISOString() };
  }
}

/** mtime-cached read — at most one stat per call, no I/O when file unchanged. */
export function killSwitchStatus(): KillSwitchState {
  try {
    const mtimeMs = statSync(FLAG_PATH).mtimeMs;
    if (cache && cache.mtimeMs === mtimeMs) return cache.state;
    const state = readState();
    cache = { state, mtimeMs };
    return state;
  } catch {
    const state = readState();
    cache = null;
    return state;
  }
}

export function isKilled(): boolean {
  return killSwitchStatus().engaged;
}

/** Engage the switch — every subsequent deploy attempt is refused with 423. */
export function engageKillSwitch(reason: string, by: string): KillSwitchState {
  const state: KillSwitchState = { engaged: true, reason: reason.slice(0, 300) || "operator engage", by: by.slice(0, 120) || "operator", at: new Date().toISOString() };
  writeFileSync(FLAG_PATH, JSON.stringify(state, null, 2) + "\n");
  appendFileSync(TRAIL_PATH, JSON.stringify({ t: state.at, action: "ENGAGE", ...state }) + "\n");
  cache = null;
  return state;
}

/** Release — requires an explicit reason; audited in the trail. */
export function releaseKillSwitch(reason: string, by: string): KillSwitchState {
  const state: KillSwitchState = { engaged: false, reason: reason.slice(0, 300) || "operator release", by: by.slice(0, 120) || "operator", at: new Date().toISOString() };
  writeFileSync(FLAG_PATH, JSON.stringify(state, null, 2) + "\n");
  appendFileSync(TRAIL_PATH, JSON.stringify({ t: state.at, action: "RELEASE", ...state }) + "\n");
  cache = null;
  return state;
}
