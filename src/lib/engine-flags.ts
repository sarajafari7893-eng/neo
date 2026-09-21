// ── v10.18 PHASED CONSOLIDATION FLAGS (operator option A, 2026-09-24) ──────
// Single flip-point for the three-phase system consolidation ordered by the
// operator after the ARCHITECTURE ADVISORY (ADVISORY-20260924-matrix-radar):
//   radarPrimary     — PUMP/DUMP RADAR is the primary detection source; its
//                      emissions ride the FULL gate stack (no authority bypass)
//                      while the legacy random auto-spawn stays retired.
//   legacyAutoSpawn  — the pre-v10.18 random full-universe spawn loop
//                      (AI-SWING-era candidate factory). false = retired.
//   sensorBusDormant — peripheral sensor bus (smart-money flow matrix, whale
//                      tape, vol-onset radar, vol-cause capture) demoted to
//                      dormant: display + telemetry capture off, components
//                      kept in code. Gate-critical inputs stay live.
// Client-safe: static JSON + no server APIs (the AI CORE dormant strip reads
// the same flags so the UI never contradicts engine behavior).
import flagsJson from "@/config/engine-flags.json";

export interface EngineFlags {
  radarPrimary: boolean;
  legacyAutoSpawn: boolean;
  sensorBusDormant: boolean;
}

let cached: EngineFlags | null = null;

export function engineFlags(): EngineFlags {
  if (cached) return cached;
  try {
    const f = flagsJson as Partial<EngineFlags> & { _comment?: string };
    cached = {
      radarPrimary: f.radarPrimary ?? true,
      legacyAutoSpawn: f.legacyAutoSpawn ?? false,
      sensorBusDormant: f.sensorBusDormant ?? true,
    };
  } catch {
    // The config ships with the repo — fail-open to the operator mandate so a
    // torn read can never silently resurrect the retired legacy paths.
    cached = { radarPrimary: true, legacyAutoSpawn: false, sensorBusDormant: true };
  }
  return cached;
}
