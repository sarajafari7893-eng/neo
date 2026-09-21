// ── FlowRadar Neo v9.6 — UI-CANARY (R5, shadow-first, server-only) ──────────
// Operator-approved module #3 (roadmap R5, mandate 2026-09-15). The operator
// asked for a VLM visual supervisor; the approved scope is a LIGHTER
// black-box watchdog: probe the dashboard's own data surfaces end-to-end
// (HTTP + payload-shape validation), grade a verdict, journal it, and escalate
// ONLY on persistent failure. This is the "canary in the cage" — cheap, loud
// when it must be, silent otherwise.
//
// CONTRACT:
//   · SHADOW: probes every ~15min (internally throttled), journals a ring of
//     snapshots, fires an ENGINE event ONLY on a verdict flip, never pages.
//   · ENGAGED: additionally pages Telegram (sendDirect, no '<' chars) after
//     3 consecutive RED verdicts, ≥6h between pages.
//   · Probes hit 127.0.0.1 (self) so no external dependency is added; every
//     probe is timeout-guarded (4s) and fail-open.
//
// Deterministic — no LLM call.

import { db } from "@/lib/db";
import { fireEvent } from "@/lib/engine";
import { sendDirect } from "@/lib/notify";
import { recordFourPack } from "@/lib/fourpack-journal"; // v10.8 — FOUR-PACK JSON journal doctrine

const KEY = "uicanary.state";
const CYCLE_MIN_MS = 15 * 60_000;
const TIMEOUT_MS = 4_000;
const RED_PAGE_STREAK = 3;
const PAGE_MIN_GAP_MS = 6 * 3600_000;
const HISTORY_CAP = 24;

export interface CanaryProbe {
  name: string;
  path: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  shapeOk: boolean;
  err: string | null;
}

export interface CanaryState {
  at: number;
  cycles: number;
  lastRunAt: string | null;
  probes: CanaryProbe[];
  verdict: "GREEN" | "AMBER" | "RED";
  redStreak: number;
  lastFlipAt: string | null;
  lastPageAt: string | null;
  history: Array<{ at: string; verdict: "GREEN" | "AMBER" | "RED" }>;
  line: string;
}

const EMPTY: CanaryState = {
  at: 0,
  cycles: 0,
  lastRunAt: null,
  probes: [],
  verdict: "GREEN",
  redStreak: 0,
  lastFlipAt: null,
  lastPageAt: null,
  history: [],
  line: "not run yet",
};

/** Probe table — the dashboard's load-bearing data surfaces. */
const PROBE_TABLE: Array<{ name: string; path: string; shape: (j: unknown) => boolean }> = [
  { name: "PULSE", path: "/api/pulse", shape: (j) => !!j && typeof j === "object" && "stats" in (j as object) },
  { name: "RAWCAL", path: "/api/rawcal", shape: (j) => !!j && typeof j === "object" && "armed" in (j as object) },
  { name: "FLOWS", path: "/api/flows", shape: () => true },
  { name: "AI-MEMORY", path: "/api/ai/memory", shape: () => true },
  { name: "BRIDGE", path: "/api/bridge/inbox", shape: () => true },
];

async function getState(): Promise<CanaryState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (row) return { ...EMPTY, ...(JSON.parse(row.value) as Partial<CanaryState>) };
  } catch {
    /* fresh */
  }
  return { ...EMPTY };
}

async function putState(next: CanaryState): Promise<void> {
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: JSON.stringify(next) }, update: { value: JSON.stringify(next) } });
}

function baseUrl(): string {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}`;
}

async function probeOne(p: (typeof PROBE_TABLE)[number]): Promise<CanaryProbe> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl()}${p.path}`, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const latencyMs = Date.now() - t0;
    let shapeOk = false;
    if (res.ok) {
      try {
        shapeOk = p.shape(await res.json());
      } catch {
        shapeOk = false;
      }
    }
    return { name: p.name, path: p.path, ok: res.ok, status: res.status, latencyMs, shapeOk, err: res.ok ? (shapeOk ? null : "shape") : `HTTP ${res.status}` };
  } catch (e) {
    return { name: p.name, path: p.path, ok: false, status: 0, latencyMs: Date.now() - t0, shapeOk: false, err: e instanceof Error ? e.message.slice(0, 60) : "fetch failed" };
  }
}

export async function runCanary(mode: "SHADOW" | "ENGAGED"): Promise<CanaryState> {
  const prev = await getState();
  const probes: CanaryProbe[] = [];
  for (const p of PROBE_TABLE) probes.push(await probeOne(p));

  const failed = probes.filter((x) => !x.ok || !x.shapeOk);
  const maxLat = Math.max(0, ...probes.map((x) => x.latencyMs));
  let verdict: CanaryState["verdict"];
  if (failed.length === 0 && maxLat < 1500) verdict = "GREEN";
  else if (probes.find((x) => x.name === "PULSE" && (!x.ok || !x.shapeOk)) || failed.length >= 2) verdict = "RED";
  else verdict = "AMBER";

  const bad = failed.map((x) => `${x.name}(${x.err ?? "?"})`).join(", ");
  const line = verdict === "GREEN" ? `all ${probes.length} surfaces ok, max latency ${maxLat}ms` : `${verdict}: ${bad || `slow ${maxLat}ms`}`;

  const flipped = verdict !== prev.verdict;
  const redStreak = verdict === "RED" ? prev.redStreak + 1 : 0;

  const state: CanaryState = {
    at: Date.now(),
    cycles: prev.cycles + 1,
    lastRunAt: new Date().toISOString(),
    probes,
    verdict,
    redStreak,
    lastFlipAt: flipped ? new Date().toISOString() : prev.lastFlipAt,
    lastPageAt: prev.lastPageAt,
    history: [{ at: new Date().toISOString(), verdict }, ...prev.history].slice(0, HISTORY_CAP),
    line,
  };

  if (flipped && prev.cycles > 0) {
    void fireEvent(null, null, verdict === "RED" ? "SYSTEM" : "ENGINE", verdict === "GREEN" ? "success" : "warn", `UI-CANARY verdict ${prev.verdict} → ${verdict} — ${line}`).catch(() => undefined);
  }
  // v10.8 journal doctrine — every probe pass + flip lands in the JSON journal
  void recordFourPack("r5-ui-canary", flipped ? "flip" : "cycle", line, { maxLatencyMs: maxLat, failed: failed.length, probes: probes.map((x) => ({ name: x.name, ok: x.ok && x.shapeOk, latencyMs: x.latencyMs })) }, verdict).catch(() => undefined);

  if (mode === "ENGAGED" && redStreak >= RED_PAGE_STREAK) {
    const gapOk = !state.lastPageAt || Date.now() - new Date(state.lastPageAt).getTime() >= PAGE_MIN_GAP_MS;
    if (gapOk) {
      const txt = `UI-CANARY RED x${redStreak} — ${line}. Probes: ${probes.map((x) => `${x.name} ${x.ok && x.shapeOk ? "ok" : "FAIL"}`).join(", ")}. Dashboard data plane degraded — check dev.log.`;
      const r = await sendDirect(txt).catch(() => ({ ok: false }));
      if (r.ok) {
        state.lastPageAt = new Date().toISOString();
        void recordFourPack("r5-ui-canary", "page", `Telegram page sent — RED x${redStreak}: ${line}`, { redStreak }, verdict).catch(() => undefined);
      }
    }
  }

  await putState(state);
  return state;
}

export async function getCanaryState(): Promise<CanaryState> {
  return getState();
}

let lastRun = 0;
export async function maybeRunCanary(mode: "SHADOW" | "ENGAGED"): Promise<void> {
  if (Date.now() - lastRun < CYCLE_MIN_MS) return;
  lastRun = Date.now();
  await runCanary(mode).catch(() => undefined);
}
