/**
 * NEXUS//SIGNALS — independent kill-switch (LIVE-HARDENING Phase 4).
 *
 * Path-independence: reads a dedicated flag file (.data/execution/kill-switch.json)
 * that strategy/engine code does not own. Even if the engine is wedged, the
 * operator (or watchdog) flipping this file blocks every new entry at the
 * entryGate — the gate consults THIS module, not engine state.
 *
 * Fail-closed semantics:
 *  · missing file            → clean (never engaged) — normal fresh boot
 *  · unreadable/corrupt file → ENGAGED (fail closed) until operator repairs
 *  · engaged.engaged === true → ENGAGED
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const KILL_SWITCH_PATH = "/home/z/my-project/.data/execution/kill-switch.json";

export interface KillSwitchState {
  engaged: boolean;
  at: string | null;
  by: string | null;
  reason: string | null;
  /** present when the file was unreadable — the switch then FAILS CLOSED */
  degraded?: boolean;
}

function clean(): KillSwitchState {
  return { engaged: false, at: null, by: null, reason: null };
}

export function readKillSwitch(path: string = KILL_SWITCH_PATH): KillSwitchState {
  if (!existsSync(path)) return clean();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as KillSwitchState;
    if (typeof parsed.engaged !== "boolean") {
      return { engaged: true, at: new Date().toISOString(), by: "system", reason: "corrupt kill-switch file (engaged flag not boolean) — fail closed", degraded: true };
    }
    return parsed;
  } catch {
    return { engaged: true, at: new Date().toISOString(), by: "system", reason: "unreadable kill-switch file — fail closed", degraded: true };
  }
}

export function engageKillSwitch(by: string, reason: string, path: string = KILL_SWITCH_PATH): KillSwitchState {
  const state: KillSwitchState = { engaged: true, at: new Date().toISOString(), by, reason };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}

export function releaseKillSwitch(by: string, path: string = KILL_SWITCH_PATH): KillSwitchState {
  const state: KillSwitchState = { engaged: false, at: new Date().toISOString(), by, reason: "released" };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
  return state;
}
