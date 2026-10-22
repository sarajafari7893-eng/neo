// ── v9.0 PUMP/DUMP RADAR — independent flow-tracking engine ──────────────
// Operator mandate 2026-09-12: «تحقیق و جستجوی عمیق ممیزی برای نحوه شناسایی
// و ردیابی جریانات پامپی و دامپی انجام بده، یک ماژول و موتور مستقل کامل و
// هوشمند براش بساز و تا زمانی که ۵ ردیابی موفق نداشته اجازه ارسال سیگنال
// ندارد، بعد از تایید میتواند سیگنال هایی با کارت اختصاصی pump با dump
// داشته باشد»
//
// RESEARCH SUMMARY (codebase audit + market microstructure literature):
//  · Pump/dump flows leave a measurable fingerprint chain: (1) velocity —
//    unlevered 1m/5m price displacement far above the symbol's own baseline;
//    (2) volume ignition — 1m quote-volume bursts ≥3× the rolling median;
//    (3) derivatives confirmation — OI delta (new money vs deleveraging
//    squeeze), CVD net-taker USD, taker buy/sell ratio, whale prints, and
//    forced-liquidation fuel (shorts liquidated fuel pumps, longs fuel dumps).
//  · The existing stack already measures every ingredient separately
//    (flow.ts, liquidations.ts, volOnset.ts, trigger bus L1/L3) but never
//    chained them into a pump/dump classifier with accountable tracking.
//
// ARCHITECTURE (independent module — zero coupling into scoring/gates):
//  STAGE 1 (every tick, in-memory): per-symbol tape of (t, price, quoteVol).
//    Computes vel1m/vel5m + 1m quote-volume burst vs the symbol's own median.
//  STAGE 2 (candidate only, 45s/symbol throttle): fetchFlowMetrics +
//    liquidationPressure → evidence-weighted conviction score 0..100.
//  DECLARE (score ≥ 62): PumpTrack row + the success criterion FIXED at
//    declaration (+2.0% unlevered MFE from anchor within 90min) — honest,
//    no post-hoc re-scoring. Event mirrors to Telegram (PUMP_RADAR).
//  TRACK (15s/track): MFE/MAE + phase machine ONSET→EXTENSION→EXHAUSTION;
//    resolves SUCCESS on criterion hit, FAILURE at horizon/collapse.
// v10.16 (deep-audit 3-a P1 pump-leak fix, task 4-c): the stage-1 tape IGNORES
//    sim-source prices (random-walk drift must never create fake velocity),
//    and updateTrack resolves a track whose symbol has no live price by the
//    CLOCK at the same 90min horizon — outcome EXPIRED / phase RESOLVED /
//    note "clock-expired: no live price (v10.16)" — instead of freezing
//    forever when a symbol leaves the universe or the feed degrades
//    (GENIUSUSDT stuck in EXHAUSTION for 22h).
//  LEARNING GATE: signals FORBIDDEN until ≥5 tracks resolved SUCCESS
//    (operator's exact number). After unlock, fresh ONSET tracks with
//    score ≥ 78 propose deploys through deploySignal's FULL normal gate
//    stack — the radar only nominates, the engine still judges. Signals
//    carry the dedicated PUMP/DUMP card cohort tags.
//
// v9.2 UNFILTERED DIRECT EMISSION (operator mandate 2026-09-13 20:06Z:
// «من شرط ورود مستقیم رو دادم، بررسی کن و بدون هیچ فیلتری سیگنال را صادر کن»)
//  · Diagnosis: authority=direct was BANKED but v9.1 still filtered through
//    the radar's own 78-conviction deploy floor + 20min spacing + max-2-open
//    — of 17 declared tracks only 2 ever spawned a card (LSK 72 / VTHO 76
//    vetoed hours after the operator granted direct authority).
//  · Fix: authority="direct" → EVERY declared track (score ≥ 62 declare
//    floor = the detection itself) emits its dedicated card 1:1, immediately.
//    Learning gate, 78 floor, spacing and max-open are ALL bypassed.
//  · What stays HARD: deploySignal's honesty rails (feed-fresh guard,
//    sim-price ban) — a pump/dump card must never be born from stale or
//    invented prices (operator's own honesty doctrine). One card per track
//    (spawnedSignal flag) and the 45min per-symbol redeclare cooldown keep
//    the 1:1 detection→card mapping honest, not filtered.
import { db } from "./db";
import { fetchFlowMetrics } from "./flow";
import { liquidationPressure } from "./liquidations";
import type { PumpEngineStatus, PumpTrackDTO } from "./api-types";

// ── rules (single source of truth — surfaced in status) ──────────────────
export const PUMP_RULES = {
  tapeWindowMs: 30 * 60_000, // in-memory tape length per symbol
  vel1mMinPct: 0.35, // fresh ignition — unlevered 1m velocity %
  vel5mMinPct: 1.1, // sustained displacement — unlevered 5m %
  volBurstMinX: 3, // 1m quote-vol ≥ 3× the symbol's own 30m median
  volFloorUsd1m: 30_000, // ignore micro-tape noise below $30k/min
  warmPoints: 55, // ≈4.5min of 5s ticks needed before vel5m is honest
  scoreDeclare: 62, // conviction floor to declare a track
  scoreDeploy: 78, // conviction floor to propose a signal (post-unlock)
  confirmTtlMs: 45_000, // stage-2 throttle per symbol
  horizonMin: 90, // track resolution window
  successMovePct: 2.0, // MFE from anchor ≥ +2.0% unlevered → SUCCESS
  collapseMaePct: 4.0, // MAE ≥ 4% against the thesis → early FAILURE
  extendPct: 1.2, // continuation beyond anchor → EXTENSION phase
  exhaustRetraceFrac: 0.5, // 50% retrace of the favorable leg → EXHAUSTION
  redeCooldownMs: 45 * 60_000, // per-symbol re-declaration cooldown
  activeCap: 12, // max concurrent open tracks
  signalSpacingMs: 20 * 60_000, // min spacing between radar-nominated signals
  signalMaxActive: 2, // max concurrent OPEN radar-spawned signals
  requiredSuccesses: 5, // operator learning gate — the exact number mandated
  trackUpdateMs: 15_000, // DB write throttle per open track
} as const;

// ── v12.1 TASK-48 ① R6 RADAR LANE — SUCCESS-renom revival (operator mandate
// «پیشنهادها را کامل و مهندسی اجرا کن») ──
// Task-47 forensics: the radar→signal conversion is NOT dead code — it is a
// 100% VETO RATE. 48h funnel: 119 declared / 60 SUCCESS renoms reached
// deploySignal and EVERY ONE was refused by the four cohort-blind MOOD gates
// (R1 SHORT-GUARD "HTF board not aligned", regime CHOP ladder, MEMORY-GATE
// realized<25%, dynamic MIN_SCORE "best |score| 0 vs eff 27"). Last link
// CTSIUSDT 2026-10-09 ≈ when the mood-gate stack hardened. Revival design:
// ONLY the SUCCESS-confirmed re-nomination cohort (v11.1's data-proven
// performance filter — renom cards historically +25.1% avg in the gated era)
// rides a NARROWER authority: the four mood gates are bypassed, every
// PHYSICAL gate stays live (ONSET-RETEST CHASE+FADE, LIQUIDITY-FLOOR,
// PHANTOM-FEED, STALE-ANCHOR, CHASE-PRICE 1.5% anchored at track peak,
// DEPEG, SYMBOL-CAP, REENTRY-LOCKOUT, STRAT-PAUSE, QUAD-SHORT, FLOW veto +
// the new BOTTOM-FADE/V-REVERSAL Task-48 guards), plus lane-specific rails:
// daily cap, max-open 2, spacing 20min, R6-LANE tag for cohort audit, and
// AUTO-DEMOTE when the settled lane cohort (n≥30) fails the v10.18 probation
// criteria (WR < baseline OR avgPnl ≤ 0) — the lane shuts itself off on
// evidence, exactly like the direct-authority era was retired on evidence.
export const RADAR_LANE_DEFAULTS = {
  enabled: true,
  dailyCap: 4, // max R6-LANE deploys per UTC day — bounded blast radius
  probationN: 30, // settled lane cards before the auto-demote verdict can fire
} as const;

interface RadarLaneCfg { enabled: boolean; dailyCap: number; probationN: number }

async function getRadarLaneCfg(): Promise<RadarLaneCfg> {
  const cfg: RadarLaneCfg = { ...RADAR_LANE_DEFAULTS };
  try {
    const row = await db.engineSetting.findUnique({ where: { key: "radar-lane" } });
    if (row) {
      const p = JSON.parse(row.value) as Partial<RadarLaneCfg>;
      if (p.enabled === false) cfg.enabled = false;
      if (typeof p.dailyCap === "number") cfg.dailyCap = Math.max(0, Math.min(20, Math.floor(p.dailyCap)));
      if (typeof p.probationN === "number") cfg.probationN = Math.max(10, Math.min(200, Math.floor(p.probationN)));
    }
  } catch { /* fail-open: defaults */ }
  return cfg;
}

/** Auto-demote: settled R6-LANE cohort fails probation → lane self-disables.
 *  Mirrors the v10.18 retirement doctrine — modes die on evidence, not opinion. */
async function radarLaneProbationCheck(cfg: RadarLaneCfg): Promise<{ ok: boolean; note: string }> {
  try {
    const rows = await db.signal.findMany({
      where: { tags: { contains: "R6-LANE" } },
      select: { status: true, reachedTp: true, pnlPercent: true, marginUsd: true, closedAt: true },
    });
    const settled = rows.filter((r) => r.closedAt);
    if (settled.length < cfg.probationN) return { ok: true, note: `probation pending — ${settled.length}/${cfg.probationN} settled` };
    const wins = settled.filter((r) => r.reachedTp >= 1 || ["TP1", "TP2", "TP3"].includes(r.status)).length;
    const wr = (wins / settled.length) * 100;
    const avgPnl = settled.reduce((a, r) => a + r.pnlPercent, 0) / settled.length;
    // baseline = non-lane settled book over the same window (approx: all-time
    // tp-proven book minus lane rows — the v10.18 endpoint's cohort logic)
    const all = await db.signal.findMany({ where: { closedAt: { not: null } }, select: { tags: true, reachedTp: true, status: true } });
    const nonLane = all.filter((r) => !(r.tags ?? "").includes("R6-LANE"));
    const nlWins = nonLane.filter((r) => r.reachedTp >= 1 || ["TP1", "TP2", "TP3"].includes(r.status)).length;
    const baselineWr = nonLane.length ? (nlWins / nonLane.length) * 100 : 0;
    if (wr < baselineWr || avgPnl <= 0) {
      await db.engineSetting.upsert({
        where: { key: "radar-lane" },
        create: { key: "radar-lane", value: JSON.stringify({ ...cfg, enabled: false, demotedAt: new Date().toISOString(), demoteReason: `probation fail n=${settled.length} WR ${wr.toFixed(1)}% vs baseline ${baselineWr.toFixed(1)}% avgPnl ${avgPnl.toFixed(2)}%` }) },
        update: { value: JSON.stringify({ ...cfg, enabled: false, demotedAt: new Date().toISOString(), demoteReason: `probation fail n=${settled.length} WR ${wr.toFixed(1)}% vs baseline ${baselineWr.toFixed(1)}% avgPnl ${avgPnl.toFixed(2)}%` }) },
      }).catch(() => undefined);
      return { ok: false, note: `AUTO-DEMOTED — n=${settled.length} WR ${wr.toFixed(1)}% < baseline ${baselineWr.toFixed(1)}% or avgPnl ${avgPnl.toFixed(2)}% ≤ 0 (v10.18 probation doctrine)` };
    }
    return { ok: true, note: `probation PASS — n=${settled.length} WR ${wr.toFixed(1)}% vs baseline ${baselineWr.toFixed(1)}%, avgPnl ${avgPnl.toFixed(2)}%` };
  } catch {
    return { ok: true, note: "probation check failed-open" };
  }
}

// lane daily counter (memory; UTC-day keyed — restart resets to a conservative 0,
// DB recount below re-arms it after every boot)
const laneDay = { key: "", count: 0 };

// ── in-memory tape ────────────────────────────────────────────────────────
interface TapePoint {
  t: number;
  p: number;
  qv: number; // cumulative 24h quote volume (USD)
}
const tape = new Map<string, TapePoint[]>();
const volSamples = new Map<string, Array<{ t: number; dv: number }>>(); // 1m quote-vol deltas

const lastConfirmAt = new Map<string, number>(); // stage-2 throttle
const lastResolveAt = new Map<string, number>(); // re-declaration cooldown
const lastSignalAt = { v: 0 }; // global radar-signal spacing

// ── v11.1 NOMINATION FUNNEL COUNTERS (operator: «چرا ردیابی‌ها تبدیل به سیگنال نمی‌شود؟») ──
// Every silent drop in the nomination funnel is now counted and surfaced in
// the pump status block (/api/pulse → pump.nomination). Before v11.1 the
// spacing/maxActive floors dropped candidates with NO event and NO counter —
// DB audit (2026-10-04): gated-era 457 tracks → 208 SUCCESS, but only 45 ever
// passed the one-shot 78 deploy floor (163 SUCCESS tracks permanently missed).
const nomStats = {
  declared: 0, // tracks declared (stage-2 confirmation passed)
  learningHeld: 0, // nominations blocked by the learning gate
  belowDeployFloor: 0, // declare-time conviction < 78 (one-shot floor)
  spacingDrop: 0, // dropped by the 20min global spacing floor
  maxActiveDrop: 0, // dropped by the max-open radar cards floor
  nominated: 0, // declare-time nominations that reached deploySignal
  deployed: 0, // declare-time nominations that became signals
  engineVetoed: 0, // deploySignal refused (full gate stack)
  successResolutions: 0, // tracks resolving SUCCESS
  renomSkippedHasCard: 0, // SUCCESS renom skipped — track already has its card
  renomAttempts: 0, // SUCCESS-confirmed re-nominations that reached the gates
  renomDeployed: 0, // SUCCESS-confirmed re-nominations deployed
  renomSpacingDrop: 0, // SUCCESS renoms dropped by spacing
  renomMaxActiveDrop: 0, // SUCCESS renoms dropped by max-open
  // v12.1 R6 RADAR LANE counters
  laneAttempts: 0, // SUCCESS renoms that reached the lane rails
  laneCapDrop: 0, // dropped by the daily cap / lane disabled
  laneProbationNote: "", // last probation verdict note
  laneDeployed: 0, // lane deploys that became signals
  laneVetoed: 0, // lane deploys refused by the (still-live) physical gates
};
let openTracks = new Map<string, TrackState>(); // symbol → live track
let lastTrackSweepAt = 0;
let lastSyncAt = 0; // DB reconcile cursor — heals multi-bundle/restart divergence
let lastLaneProbationAt = 0; // v12.1 lane probation check throttle (10min)
let memo: { at: number; v: PumpEngineStatus } | null = null;
let booted = false;

interface TrackState {
  id: string;
  symbol: string;
  kind: "PUMP" | "DUMP";
  phase: string;
  anchor: number;
  peak: number;
  mfe: number;
  mae: number;
  score: number;
  detectedAt: number;
  lastWriteAt: number;
  spawnedSignal: boolean;
}

export interface PumpCandidate {
  symbol: string;
  kind: "PUMP" | "DUMP";
  vel1m: number;
  vel5m: number;
  burstX: number;
  price: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** v10.16 — asset rows the engine feeds the radar (source lets us reject sim prices). */
export type PumpAsset = { symbol: string; price: number; volume24h: number; source?: string };

/** Stage 1 — feed the tape + screen for velocity/volume candidates. Cheap. */
export function pumpScreen(assets: PumpAsset[]): PumpCandidate[] {
  const now = Date.now();
  const out: PumpCandidate[] = [];
  for (const a of assets) {
    if (!a.price || a.price <= 0) continue;
    // v10.16 P1 PUMP-LEAK — never ingest sim-source prices into the tape: the
    // random-walk drift fallback would fabricate velocity/volume bursts and
    // declare pump tracks from invented prices.
    if (a.source === "sim") continue;
    let ring = tape.get(a.symbol);
    if (!ring) {
      ring = [];
      tape.set(a.symbol, ring);
    }
    ring.push({ t: now, p: a.price, qv: a.volume24h });
    while (ring.length && now - ring[0]!.t > PUMP_RULES.tapeWindowMs) ring.shift();

    // 1m quote-volume delta samples (minute-bucketed) for the burst baseline
    let vs = volSamples.get(a.symbol);
    if (!vs) {
      vs = [];
      volSamples.set(a.symbol, vs);
    }
    const lastS = vs[vs.length - 1];
    if (!lastS || now - lastS.t >= 55_000) {
      const ref = ring.find((pt) => now - pt.t <= 65_000) ?? ring[0]!;
      const dv = Math.max(0, a.volume24h - ref.qv);
      vs.push({ t: now, dv });
      while (vs.length > 32) vs.shift();
    }

    if (ring.length < PUMP_RULES.warmPoints) continue; // honest warmup after restart

    const at = (ms: number): TapePoint | null => {
      let best: TapePoint | null = null;
      let bestDev = Number.POSITIVE_INFINITY;
      for (const pt of ring!) {
        const dev = Math.abs(pt.t - (now - ms));
        if (dev < bestDev) {
          bestDev = dev;
          best = pt;
        }
      }
      return bestDev <= 15_000 ? best : null;
    };
    const p1 = at(60_000);
    const p5 = at(300_000);
    if (!p1 || !p5) continue;

    const vel1m = ((a.price - p1.p) / p1.p) * 100;
    const vel5m = ((a.price - p5.p) / p5.p) * 100;
    const dvNow = Math.max(0, a.volume24h - p1.qv);
    const base = median(vs.map((s) => s.dv).slice(0, -1));
    const burstX = base >= 1_000 ? dvNow / base : 0;
    if (dvNow < PUMP_RULES.volFloorUsd1m) continue;

    const kind: "PUMP" | "DUMP" = vel5m > 0 ? "PUMP" : "DUMP";
    const av1 = Math.abs(vel1m);
    const av5 = Math.abs(vel5m);
    if (av5 < PUMP_RULES.vel5mMinPct || av1 < PUMP_RULES.vel1mMinPct || burstX < PUMP_RULES.volBurstMinX) continue;
    if (openTracks.has(a.symbol)) continue;
    if (now - (lastResolveAt.get(a.symbol) ?? 0) < PUMP_RULES.redeCooldownMs) continue;
    out.push({ symbol: a.symbol, kind, vel1m, vel5m, burstX, price: a.price });
  }
  // strongest first (5m displacement × burst)
  return out.sort((a, b) => Math.abs(b.vel5m) * b.burstX - Math.abs(a.vel5m) * a.burstX).slice(0, 3);
}

// ── stage 2 — evidence-weighted conviction ───────────────────────────────
export interface PumpEvidence {
  oiDelta10m: number | null;
  cvdUsd60s: number | null;
  takerRatio: number | null;
  funding8h: number | null;
  whaleUsd5m: number | null;
  whaleSideAligned: boolean;
  liqUsd10m: number | null;
  liqSideAligned: boolean;
}

export async function gatherEvidence(c: PumpCandidate): Promise<{ score: number; ev: PumpEvidence }> {
  const sign = c.kind === "PUMP" ? 1 : -1;
  let score = 0;
  // velocity core (≤45)
  score += Math.min(27, (Math.abs(c.vel5m) / PUMP_RULES.vel5mMinPct) * 12);
  score += Math.min(18, (Math.abs(c.vel1m) / PUMP_RULES.vel1mMinPct) * 9);
  // volume burst (≤15)
  score += Math.min(15, (c.burstX / PUMP_RULES.volBurstMinX) * 8);

  const ev: PumpEvidence = {
    oiDelta10m: null, cvdUsd60s: null, takerRatio: null, funding8h: null,
    whaleUsd5m: null, whaleSideAligned: false, liqUsd10m: null, liqSideAligned: false,
  };
  try {
    const [flow, liq] = await Promise.all([fetchFlowMetrics(c.symbol), liquidationPressure(c.symbol)]);
    if (flow) {
      ev.oiDelta10m = flow.oiDelta10m;
      ev.cvdUsd60s = flow.cvdUsd60s;
      ev.takerRatio = flow.takerRatio;
      ev.funding8h = flow.funding8h;
      if (flow.oiDelta10m !== null) {
        // OI rising WITH the move = fresh money (strongest); falling = deleveraging squeeze (real, weaker)
        if (flow.oiDelta10m * sign > 0) score += 12;
        else if (flow.oiDelta10m < 0) score += 6;
      }
      if (flow.cvdUsd60s !== null && flow.cvdUsd60s * sign > 0) {
        score += flow.cvdUsd60s * sign >= 200_000 ? 15 : 12;
      }
      if (flow.takerRatio !== null && flow.takerRatio * sign > 1) score += flow.takerRatio * sign >= 1.15 ? 8 : 5;
      if (flow.whalePrint5m && flow.whalePrint5m.totalUsd >= 250_000) {
        ev.whaleUsd5m = flow.whalePrint5m.totalUsd;
        ev.whaleSideAligned = flow.whalePrint5m.buyUsd >= flow.whalePrint5m.sellUsd ? sign > 0 : sign < 0;
        if (ev.whaleSideAligned) score += 8;
      }
      // funding tailwind: not already paying the crowd to be on our side's neck
      if (flow.funding8h !== null && flow.funding8h * sign <= 0.02) score += 4;
    }
    if (liq) {
      ev.liqUsd10m = liq.usd10m;
      // forced-liquidation fuel: shorts liquidated → pump fuel; longs → dump fuel
      const fuel = sign > 0 ? liq.shortsUsd10m : liq.longsUsd10m;
      ev.liqSideAligned = fuel >= 100_000;
      if (ev.liqSideAligned) score += 6;
    }
  } catch {
    /* evidence unavailable — velocity/volume core still stands, honest score */
  }
  return { score: Math.min(100, Math.round(score)), ev };
}

// ── module lifecycle ─────────────────────────────────────────────────────

async function ensureBooted(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    const rows = await db.pumpTrack.findMany({ where: { phase: { not: "RESOLVED" } } });
    openTracks = new Map(
      rows.map((r) => [
        r.symbol,
        {
          id: r.id, symbol: r.symbol, kind: r.kind as "PUMP" | "DUMP", phase: r.phase,
          anchor: r.anchorPrice, peak: r.peakPrice, mfe: r.mfePct, mae: r.maePct,
          score: r.score, detectedAt: r.detectedAt.getTime(), lastWriteAt: 0, spawnedSignal: !!r.signalId,
        },
      ]),
    );
  } catch {
    /* first boot — empty */
  }
}

const fmtEvidence = (ev: PumpEvidence): string => {
  const parts: string[] = [];
  if (ev.oiDelta10m !== null) parts.push(`OI ${ev.oiDelta10m >= 0 ? "+" : ""}${ev.oiDelta10m.toFixed(2)}%/10m`);
  if (ev.cvdUsd60s !== null) parts.push(`CVD ${ev.cvdUsd60s >= 0 ? "+" : ""}$${Math.round(Math.abs(ev.cvdUsd60s) / 1000)}K/60s`);
  if (ev.takerRatio !== null) parts.push(`taker ${ev.takerRatio.toFixed(2)}`);
  if (ev.whaleSideAligned) parts.push(`whale $${Math.round((ev.whaleUsd5m ?? 0) / 1000)}K/5m`);
  if (ev.liqSideAligned) parts.push(`liq-fuel $${Math.round((ev.liqUsd10m ?? 0) / 1000)}K/10m`);
  return parts.join(" · ");
};

/** Reconcile in-memory open tracks with the DB (1/min — heal for restarts
 *  and Next dev's per-route module bundles: a track created in one instance
 *  must be tracked by every instance that runs the tick). */
async function syncOpenTracks(now: number): Promise<void> {
  if (now - lastSyncAt < 60_000) return;
  lastSyncAt = now;
  try {
    const rows = await db.pumpTrack.findMany({ where: { phase: { not: "RESOLVED" } } });
    const rowIds = new Set(rows.map((r) => r.id));
    for (const [sym, t] of [...openTracks.entries()]) {
      if (!rowIds.has(t.id)) openTracks.delete(sym); // resolved elsewhere
    }
    for (const r of rows) {
      if (openTracks.has(r.symbol)) continue; // memory copy is fresher
      openTracks.set(r.symbol, {
        id: r.id, symbol: r.symbol, kind: r.kind as "PUMP" | "DUMP", phase: r.phase,
        anchor: r.anchorPrice, peak: r.peakPrice, mfe: r.mfePct, mae: r.maePct,
        score: r.score, detectedAt: r.detectedAt.getTime(), lastWriteAt: 0, spawnedSignal: !!r.signalId,
      });
    }
  } catch {
    /* reconcile is best-effort */
  }
}

/** Main entry — called from the engine tick with fresh asset prices. */
export async function pumpTick(assets: PumpAsset[]): Promise<void> {
  await ensureBooted();
  const now = Date.now();

  // 0) reconcile memory ↔ DB (1/min)
  await syncOpenTracks(now);

  // 1) track maintenance first — MFE/MAE + phase machine + resolution.
  // v10.16: tracks whose symbol has NO price row (left the universe) are no
  // longer silently skipped forever — updateTrack clock-expires them.
  if (now - lastTrackSweepAt >= 5_000 && openTracks.size > 0) {
    lastTrackSweepAt = now;
    const priceMap = new Map(assets.map((a) => [a.symbol, a.price]));
    const srcMap = new Map(assets.map((a) => [a.symbol, a.source ?? "live"]));
    for (const t of [...openTracks.values()]) {
      await updateTrack(t, priceMap.get(t.symbol) ?? null, srcMap.get(t.symbol) ?? null, now);
    }
  }

  // 2) stage-1 screen
  if (openTracks.size >= PUMP_RULES.activeCap) return;
  const cands = pumpScreen(assets);
  if (!cands.length) return;

  // 3) stage-2 confirm + declare
  for (const c of cands) {
    if (openTracks.has(c.symbol)) continue;
    const lc = lastConfirmAt.get(c.symbol) ?? 0;
    if (now - lc < PUMP_RULES.confirmTtlMs) continue;
    lastConfirmAt.set(c.symbol, now);
    const { score, ev } = await gatherEvidence(c);
    if (score < PUMP_RULES.scoreDeclare) continue;
    await declareTrack(c, score, ev, now);
  }
}

async function declareTrack(c: PumpCandidate, score: number, ev: PumpEvidence, now: number): Promise<void> {
  nomStats.declared++;
  const row = await db.pumpTrack.create({
    data: {
      symbol: c.symbol,
      kind: c.kind,
      phase: "ONSET",
      anchorPrice: c.price,
      peakPrice: c.price,
      vel1mPct: Number(c.vel1m.toFixed(3)),
      vel5mPct: Number(c.vel5m.toFixed(3)),
      volBurstX: Number(c.burstX.toFixed(2)),
      oiDelta10m: ev.oiDelta10m,
      cvdUsd60s: ev.cvdUsd60s,
      takerRatio: ev.takerRatio,
      funding8h: ev.funding8h,
      whaleUsd5m: ev.whaleUsd5m,
      liqUsd10m: ev.liqUsd10m,
      score,
      metricsJson: JSON.stringify({ ev, rules: { successMovePct: PUMP_RULES.successMovePct, horizonMin: PUMP_RULES.horizonMin } }),
    },
  });
  openTracks.set(c.symbol, {
    id: row.id, symbol: c.symbol, kind: c.kind, phase: "ONSET",
    anchor: c.price, peak: c.price, mfe: 0, mae: 0, score,
    detectedAt: now, lastWriteAt: 0, spawnedSignal: false,
  });
  const engine = await import("./engine");
  await engine.fireEvent(
    null,
    c.symbol,
    "PUMP_RADAR",
    "ai",
    `${c.kind} TRACK DECLARED — ${c.symbol} @ ${c.price} · conviction ${score}/100 · vel5m ${c.vel5m >= 0 ? "+" : ""}${c.vel5m.toFixed(2)}% · vel1m ${c.vel1m >= 0 ? "+" : ""}${c.vel1m.toFixed(2)}% · vol-burst ${c.burstX.toFixed(1)}× · ${fmtEvidence(ev) || "flow evidence warming"} — SUCCESS criterion fixed NOW: +${PUMP_RULES.successMovePct}% MFE from anchor within ${PUMP_RULES.horizonMin}min · gate ${await gateLine()}`,
  );
  // v9.2 — every declared track proposes its card; maybeSpawnSignal applies
  // the 78-floor ONLY in gated mode (direct = unfiltered emission).
  await maybeSpawnSignal(c.kind, c.symbol, score, row.id, now, c.price);
}

async function gateLine(): Promise<string> {
  const g = await pumpGateAllows();
  return g.unlocked
    ? `UNLOCKED (${g.successful}/${g.total} successes)`
    : `LOCKED ${g.successful}/${PUMP_RULES.requiredSuccesses} successes — signals forbidden`;
}

/** Shared resolution write — flips the track to RESOLVED, persists outcome,
 *  drops it from the open map, resets the redeclare cooldown and fires the
 *  event. Extracted in v10.16 so the clock-expiry path reuses it verbatim. */
async function resolveTrack(t: TrackState, outcome: "SUCCESS" | "FAILURE" | "EXPIRED", note: string, now: number): Promise<void> {
  t.phase = "RESOLVED";
  t.lastWriteAt = now;
  try {
    await db.pumpTrack.update({
      where: { id: t.id },
      data: {
        phase: t.phase,
        mfePct: Number(t.mfe.toFixed(3)),
        maePct: Number(t.mae.toFixed(3)),
        peakPrice: t.peak,
        outcome,
        resolvedAt: new Date(),
        successNote: note,
      },
    });
  } catch (e) {
    console.error("[pump-radar] track resolution failed:", e);
    return;
  }
  openTracks.delete(t.symbol);
  lastResolveAt.set(t.symbol, now);
  const engine = await import("./engine");
  await engine.fireEvent(
    null,
    t.symbol,
    outcome === "SUCCESS" ? "PUMP_RADAR" : "ENGINE",
    outcome === "SUCCESS" ? "success" : "info",
    `${t.kind} TRACK ${outcome} — ${t.symbol} ${outcome === "SUCCESS" ? "✓" : "✕"} · ${note} (MAE ${t.mae.toFixed(2)}%) · gate ${await gateLine()}`,
  );
}

async function updateTrack(t: TrackState, price: number | null, src: string | null, now: number): Promise<void> {
  // ── v10.16 P1 PUMP-LEAK — no live price for this track's symbol (it left
  // the universe, or the feed degraded to sim): MFE/MAE/peak/phase must NOT
  // move on invented prices, but the CLOCK still runs — once the same horizon
  // constant used by the price-based resolution elapses, the track resolves
  // EXPIRED instead of freezing forever (GENIUSUSDT-class heal).
  const live = price !== null && price > 0 && src !== "sim";
  if (!live) {
    if ((now - t.detectedAt) / 60_000 < PUMP_RULES.horizonMin) return;
    await resolveTrack(t, "EXPIRED", "clock-expired: no live price (v10.16)", now);
    return;
  }

  const sign = t.kind === "PUMP" ? 1 : -1;
  const fav = ((price! - t.anchor) / t.anchor) * 100 * sign;
  t.mfe = Math.max(t.mfe, fav);
  t.mae = Math.max(t.mae, -fav);
  if (sign > 0) t.peak = Math.max(t.peak, price!);
  else t.peak = Math.min(t.peak, price!);

  // phase machine
  let phase = t.phase;
  if (t.phase === "ONSET" && t.mfe >= PUMP_RULES.extendPct) phase = "EXTENSION";
  else if (t.phase === "EXTENSION") {
    const leg = Math.max(t.mfe, 0.01);
    const retrace = ((sign > 0 ? t.peak - price! : price! - t.peak) / (t.peak || price!)) * 100;
    if (retrace >= PUMP_RULES.exhaustRetraceFrac * leg) phase = "EXHAUSTION";
  }

  // resolution
  const ageMin = (now - t.detectedAt) / 60_000;
  if (t.mfe >= PUMP_RULES.successMovePct) {
    await resolveTrack(t, "SUCCESS", `MFE +${t.mfe.toFixed(2)}% ≥ +${PUMP_RULES.successMovePct}% in ${ageMin.toFixed(0)}min — continuation validated`, now);
    // ── v11.1 SUCCESS-CONFIRMED RE-NOMINATION (data-proven performance filter) ──
    // DB audit 2026-10-04: tracks that converted to signals after a SUCCESS
    // outcome averaged +20.4% (mixed era, n=59) and +25.1% (gated era, n=7)
    // vs −14.8% for FAILURE-converted — the realized SUCCESS outcome IS the
    // performance filter. The one-shot declare-moment 78 floor permanently
    // missed 163/208 gated-era SUCCESS tracks (score only evaluated at the
    // detection instant, never re-visited). Nomination now gets a SECOND,
    // outcome-confirmed chance: still through the full engine gate stack,
    // still spacing/maxActive-capped, chase-cap anchored at the confirmation
    // point (track peak) instead of the detection anchor.
    await renominateSuccessTrack(t, now);
    return;
  }
  if (t.mae >= PUMP_RULES.collapseMaePct) {
    await resolveTrack(t, "FAILURE", `collapsed — MAE ${t.mae.toFixed(2)}% against the thesis (MFE was +${t.mfe.toFixed(2)}%)`, now);
    return;
  }
  if (ageMin >= PUMP_RULES.horizonMin) {
    await resolveTrack(t, "FAILURE", `horizon ${PUMP_RULES.horizonMin}min elapsed — MFE +${t.mfe.toFixed(2)}% never reached +${PUMP_RULES.successMovePct}%`, now);
    return;
  }

  const dirty = phase !== t.phase || now - t.lastWriteAt >= PUMP_RULES.trackUpdateMs;
  if (!dirty) return;
  t.phase = phase;
  t.lastWriteAt = now;
  try {
    await db.pumpTrack.update({
      where: { id: t.id },
      data: {
        phase: t.phase,
        mfePct: Number(t.mfe.toFixed(3)),
        maePct: Number(t.mae.toFixed(3)),
        peakPrice: t.peak,
      },
    });
  } catch (e) {
    console.error("[pump-radar] track update failed:", e);
    return;
  }
}

// ── LEARNING GATE (operator: 5 successful tracks before any signal) ──────
let gateMemo: { at: number; successful: number; failed: number; total: number } | null = null;

export async function pumpGateAllows(): Promise<{ unlocked: boolean; successful: number; failed: number; total: number; required: number; reason: string }> {
  if (!gateMemo || Date.now() - gateMemo.at >= 30_000) {
    const groups = await db.pumpTrack.groupBy({ by: ["outcome"], _count: { _all: true } });
    const get = (k: string) => groups.find((g) => g.outcome === k)?._count._all ?? 0;
    gateMemo = { at: Date.now(), successful: get("SUCCESS"), failed: get("FAILURE"), total: get("SUCCESS") + get("FAILURE") };
    if (gateMemo.successful >= PUMP_RULES.requiredSuccesses) {
      const cur = await db.engineSetting.findUnique({ where: { key: "pump.gate.unlockedAt" } }).catch(() => null);
      if (!cur) {
        await db.engineSetting.upsert({
          where: { key: "pump.gate.unlockedAt" },
          create: { key: "pump.gate.unlockedAt", value: new Date().toISOString() },
          update: { value: new Date().toISOString() },
        }).catch(() => undefined);
        const engine = await import("./engine");
        await engine
          .fireEvent(null, null, "PUMP_RADAR", "success", `PUMP/DUMP RADAR UNLOCKED — ${gateMemo.successful} successful tracks confirmed the detector; dedicated PUMP/DUMP signal cards now ARMED (all normal engine gates still apply to every deploy)`)
          .catch(() => undefined);
      }
    }
  }
  const unlocked = gateMemo.successful >= PUMP_RULES.requiredSuccesses;
  return {
    unlocked,
    successful: gateMemo.successful,
    failed: gateMemo.failed,
    total: gateMemo.total,
    required: PUMP_RULES.requiredSuccesses,
    reason: unlocked
      ? `radar confirmed — ${gateMemo.successful} successful tracks (≥${PUMP_RULES.requiredSuccesses})`
      : `signals forbidden until ${PUMP_RULES.requiredSuccesses} successful tracks — ${gateMemo.successful} so far (${gateMemo.total} resolved)`,
  };
}

// ── v9.1 DIRECT AUTHORITY → RETIRED v10.18 (operator option A, 2026-09-24:
// «کل سیستم بر پایه MARKET MATRIX و PUMP/DUMP RADAR، اما مهارشده») — the
// radar is the PRIMARY detection source of the consolidated system, but the
// unfiltered DIRECT emission mode (authorityBypass, live 2026-09-13 →
// 2026-09-24) is retired: clean-cohort evidence showed unfiltered pump
// emission UNDERPERFORMING the gated book (WR 10.8% vs 24.3%, avg −13.82%
// vs +8.66% over the last 7d). Every radar nomination now passes the FULL
// gate stack; the EngineSetting key below stays only as historical audit.
const AUTHORITY_KEY = "pump.authority";

export async function getPumpAuthority(): Promise<"direct" | "gated"> {
  // v10.18 honesty-by-construction: reports "gated" unconditionally so no
  // dashboard badge can ever narrate a mode that no longer exists in code.
  return "gated";
}

export async function setPumpAuthority(mode: "direct" | "gated"): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: AUTHORITY_KEY },
    create: { key: AUTHORITY_KEY, value: mode },
    update: { value: mode },
  });
}

/** v11.1 — second nomination chance at SUCCESS resolution. Only for tracks
 *  that never got their card (no signalId). The realized SUCCESS outcome
 *  replaces the declare-moment 78 conviction floor as the proven filter;
 *  spacing + max-open + the full engine gate stack still apply. */
async function renominateSuccessTrack(t: TrackState, now: number): Promise<void> {
  nomStats.successResolutions++;
  try {
    const row = await db.pumpTrack.findUnique({ where: { id: t.id }, select: { signalId: true } });
    if (!row) return;
    if (row.signalId) {
      nomStats.renomSkippedHasCard++;
      return;
    }
  } catch {
    return; // DB hiccup — never let the funnel heal break the radar loop
  }
  await maybeSpawnSignal(t.kind, t.symbol, t.score, t.id, now, t.anchor, {
    renom: true,
    // chase-cap anchor = confirmation point (the track's extreme), NOT the
    // detection anchor: post-SUCCESS the price is by definition ≥2% past the
    // anchor, so anchoring there would veto every re-nomination.
    renomRefPrice: t.peak,
  });
}

async function maybeSpawnSignal(
  kind: "PUMP" | "DUMP",
  symbol: string,
  score: number,
  trackId: string,
  now: number,
  anchorPrice: number,
  opts?: { renom?: boolean; renomRefPrice?: number },
): Promise<void> {
  const engine = await import("./engine");
  // ── v10.18 PHASE-2 CONSOLIDATION (operator option A, 2026-09-24) ──
  // The DIRECT-AUTHORITY bypass is RETIRED. The PUMP/DUMP RADAR is the
  // PRIMARY detection source of the consolidated system, but every emission
  // now passes the SAME gate stack as the rest of the book: learning gate +
  // 78 deploy floor + 20min spacing + max-open + the engine's full quality
  // gates (score/min_score, regime, dislocation, chase, DEGEN-STOP birth
  // guard). `authorityBypass` remains engine-internal for operator-forced
  // deploys and RAW-CAL capture only — the radar can no longer reach it.
  // Evidence basis: clean-cohort 7d ledger (post DEGEN/INVERTED exclusion)
  // pump WR 10.8% / avg −13.82% vs non-pump 24.3% / +8.66% — unfiltered
  // emission measurably UNDERPERFORMS the gated book. Acceptance gate for
  // the radar-primary era: GET /api/analytics/radar-probation (n≥30 settled
  // inside 14d, WR ≥ non-radar clean baseline, avgPnl > 0).
  {
    // v9.0 gated path — learning gate + 78 deploy floor + spacing + max-open
    const gate = await pumpGateAllows();
    if (!gate.unlocked) {
      nomStats.learningHeld++;
      await engine.fireEvent(null, symbol, "ENGINE", "info", `PUMP/DUMP RADAR: ${kind} ${symbol} scored ${score}/100 (deploy-grade) but the learning gate holds — ${gate.reason}`);
      return;
    }
    // v11.1: on the SUCCESS-confirmed re-nomination path the realized outcome
    // (MFE ≥ +2% validated within horizon) replaces the one-shot declare-moment
    // 78 conviction floor as the performance filter — that floor permanently
    // missed 163/208 gated-era SUCCESS tracks (funnel audit 2026-10-04).
    if (!opts?.renom && score < PUMP_RULES.scoreDeploy) {
      nomStats.belowDeployFloor++;
      return;
    }
    const now_ = Date.now();
    if (now_ - lastSignalAt.v < PUMP_RULES.signalSpacingMs) {
      if (opts?.renom) nomStats.renomSpacingDrop++;
      else nomStats.spacingDrop++;
      return;
    }
    const openRadar = await db.signal.count({ where: { tags: { contains: kind }, status: { in: ["ACTIVE", "TP1", "TP2"] } } });
    if (openRadar >= PUMP_RULES.signalMaxActive) {
      if (opts?.renom) nomStats.renomMaxActiveDrop++;
      else nomStats.maxActiveDrop++;
      return;
    }
    // ── v12.1 TASK-48 ① R6 RADAR LANE rails (renom cohort only) ──
    if (opts?.renom) {
      nomStats.laneAttempts++;
      const laneCfg = await getRadarLaneCfg();
      const todayKey = new Date().toISOString().slice(0, 10);
      if (laneDay.key !== todayKey) {
        // re-arm the in-memory daily counter from the DB after day roll / boot
        const c = await db.signal.count({ where: { tags: { contains: "R6-LANE" }, createdAt: { gte: new Date(`${todayKey}T00:00:00.000Z`) } } }).catch(() => 0);
        laneDay.key = todayKey;
        laneDay.count = c;
      }
      if (!laneCfg.enabled) {
        nomStats.laneCapDrop++;
        await engine.fireEvent(null, symbol, "ENGINE", "info", `PUMP/DUMP RADAR: ${kind} ${symbol} SUCCESS re-nom held — R6 LANE disabled (${(await db.engineSetting.findUnique({ where: { key: "radar-lane" } }).catch(() => null))?.value ?? "{}"})`);
        return;
      }
      if (laneDay.count >= laneCfg.dailyCap) {
        nomStats.laneCapDrop++;
        await engine.fireEvent(null, symbol, "ENGINE", "info", `PUMP/DUMP RADAR: ${kind} ${symbol} SUCCESS re-nom held — R6 LANE daily cap ${laneDay.count}/${laneCfg.dailyCap} (bounded blast radius)`);
        return;
      }
      // probation verdict — at most one check per 10min (two DB scans)
      if (now - lastLaneProbationAt >= 600_000) {
        lastLaneProbationAt = now;
        const prob = await radarLaneProbationCheck(laneCfg);
        nomStats.laneProbationNote = prob.note;
        if (!prob.ok) {
          nomStats.laneCapDrop++;
          const e2 = await import("./engine");
          await e2.fireEvent(null, null, "PUMP_RADAR", "warn", `R6 RADAR LANE AUTO-DEMOTED — ${prob.note} · lane disabled by evidence, SUCCESS renoms return to the strict gate stack`);
          return;
        }
      } else if (nomStats.laneProbationNote.startsWith("AUTO-DEMOTED")) {
        nomStats.laneCapDrop++;
        return;
      }
    }
    lastSignalAt.v = now_;
    if (opts?.renom) nomStats.renomAttempts++;
    else nomStats.nominated++;
  }
  // v9.2 comment RETIRED with the direct path (v10.18, see block above).
  // v9.3 R6-INFORMATIVE PACKAGE (operator mandate الف + anti-late-entry):
  //   · ttlMinutes 60–75 (vs the 180–300 AI-SWING default these cards inherit)
  //     → cards RESOLVE fast: fewer EXPIRED-no-touch censors, higher R6
  //     informative ratio, faster capital cycle.
  //   · ttlNoExtend → the dynamic expiry gate may NOT re-extend radar cards
  //     (an extension would reintroduce exactly the censoring R6 suffers from).
  //   · refPrice = track anchorPrice + chaseCapPct 1.5 → the deploy is refused
  //     if price already ran >1.5% past DETECTION — execution can no longer
  //     enter later than the radar saw the move (Duration-Lab: the fast-kill
  //     cohort never went green; they were cascade chases).
  // v9.3.1 ROUTING FIX (independent audit 2026-09-13 18:05 +08, DB evidence):
  //   focusSymbol was MISSING here — deploySignal ran a FULL-UNIVERSE scan and
  //   the authorityBypass fallback picked the strongest candidate of the WHOLE
  //   market, so cards were born on a DIFFERENT symbol than the detected flow
  //   (proven pairs: VTHOUSDT track → AAVEUSDT card NX-0129, STEEMUSDT track →
  //   ZECUSDT card NX-0136, METUSDT track → SOLUSDT card NX-0123). That is the
  //   literal "execution enters later (and elsewhere) than detection" defect,
  //   AND it poisoned the anchor-referenced chase cap: refPrice(anchor of X)
  //   vs entry(price of Y) is a cross-symbol ratio — nonsense drift that would
  //   either refuse every radar deploy or bless a wrong-symbol chase. With
  //   focusSymbol the pool IS the radar symbol, the 1:1 detection→card mapping
  //   holds on the right market, and chase-cap 1.5% measures the TRUE
  //   detection→fill drift of the detected flow.
  const res = await engine.deploySignal(symbol, kind === "PUMP" ? "LONG" : "SHORT", {
    triggerTag: "PUMP-RADAR",
    extraTags: [kind, ...(opts?.renom ? ["R6-LANE"] : [])],
    // v12.1 TASK-48 ①: the SUCCESS-renom cohort rides the R6 RADAR LANE —
    // the four cohort-blind MOOD gates (R1 SHORT-GUARD, regime CHOP ladder,
    // MEMORY-GATE, dynamic MIN_SCORE) are bypassed; every physical gate stays
    // live; lane rails (dailyCap/maxActive/spacing/probation) bound the
    // cohort. Declare-time nominations keep the strict path unchanged.
    radarLane: !!opts?.renom,
    // v10.18: NO authorityBypass — radar emissions ride the full gate stack.
    focusSymbol: symbol,
    ttlMinutes: 60 + Math.round(Math.random() * 15),
    ttlNoExtend: true,
    // v11.1: re-nominations anchor the chase cap at the SUCCESS confirmation
    // point (track peak); declare-time nominations keep the detection anchor.
    refPrice: opts?.renom ? (opts.renomRefPrice ?? anchorPrice) : anchorPrice,
    chaseCapPct: 1.5,
    // Task 79 FILL LEDGER — detection instant for the slippage/latency ledger
    detectedAt: (await db.pumpTrack.findUnique({ where: { id: trackId }, select: { detectedAt: true } }).catch(() => null))?.detectedAt?.getTime(),
  });
  if (res.signal) {
    if (opts?.renom) nomStats.renomDeployed++;
    else nomStats.deployed++;
    if (opts?.renom) {
      nomStats.laneDeployed++;
      laneDay.count += 1;
    }
    await db.pumpTrack.update({ where: { id: trackId }, data: { signalId: res.signal.id } }).catch(() => undefined);
    await engine.fireEvent(null, symbol, "PUMP_RADAR", "success", `${kind} RADAR DEPLOY${opts?.renom ? " (SUCCESS-CONFIRMED RE-NOMINATION v11.1 · R6 RADAR LANE — mood gates bypassed, physical gates + probation live)" : ""} — ${symbol} conviction ${score}/100 → NX-${String(res.signal.serial).padStart(4, "0")} deployed${opts?.renom ? " through the R6 lane" : " THROUGH THE FULL GATE STACK (radar-primary gated emission)"} with the dedicated ${kind} card`);
  } else if (res.error) {
    nomStats.engineVetoed++;
    if (opts?.renom) nomStats.laneVetoed++;
    await engine.fireEvent(null, symbol, "ENGINE", "info", `PUMP/DUMP RADAR: ${kind} ${symbol} nomination${opts?.renom ? " (SUCCESS re-nom · R6 LANE — physical gates still live)" : ""} VETOED by the engine gates — ${res.error.slice(0, 160)}`);
  }
}

// ── status for the dashboard radar panel ─────────────────────────────────
const toDTO = (r: {
  id: string; symbol: string; kind: string; phase: string; outcome: string | null;
  anchorPrice: number; mfePct: number; maePct: number; score: number;
  vel5mPct: number | null; volBurstX: number | null;
  detectedAt: Date; resolvedAt: Date | null; successNote: string | null;
}): PumpTrackDTO => ({
  id: r.id,
  symbol: r.symbol,
  kind: r.kind === "PUMP" ? "PUMP" : "DUMP",
  phase: r.phase,
  outcome: r.outcome,
  anchorPrice: r.anchorPrice,
  mfePct: r.mfePct,
  maePct: r.maePct,
  score: r.score,
  vel5mPct: r.vel5mPct,
  volBurstX: r.volBurstX,
  detectedAt: r.detectedAt.toISOString(),
  resolvedAt: r.resolvedAt?.toISOString() ?? null,
  successNote: r.successNote,
});

export async function getPumpEngineStatus(): Promise<PumpEngineStatus> {
  if (memo && Date.now() - memo.at < 15_000) return memo.v;
  try {
    await ensureBooted();
    const gate = await pumpGateAllows();
    const authority = await getPumpAuthority();
    const [active, recent] = await Promise.all([
      db.pumpTrack.findMany({ where: { phase: { not: "RESOLVED" } }, orderBy: { detectedAt: "desc" }, take: 8 }),
      db.pumpTrack.findMany({ where: { outcome: { not: null } }, orderBy: { resolvedAt: "desc" }, take: 6 }),
    ]);
    const unlockedRow = await db.engineSetting.findUnique({ where: { key: "pump.gate.unlockedAt" } }).catch(() => null);
    const v: PumpEngineStatus = {
      gate: {
        unlocked: gate.unlocked,
        successful: gate.successful,
        failed: gate.failed,
        total: gate.total,
        required: gate.required,
        unlockedAt: unlockedRow?.value ?? null,
      },
      authority,
      nomination: { ...nomStats },
      active: active.map(toDTO),
      recent: recent.map(toDTO),
      tapeSymbols: tape.size,
      warm: tape.size > 0 && [...tape.values()].every((r) => r.length >= PUMP_RULES.warmPoints || r.length === 0),
    };
    memo = { at: Date.now(), v };
    return v;
  } catch {
    return {
      gate: { unlocked: false, successful: 0, failed: 0, total: 0, required: PUMP_RULES.requiredSuccesses, unlockedAt: null },
      authority: "gated",
      nomination: { ...nomStats },
      active: [],
      recent: [],
      tapeSymbols: tape.size,
      warm: false,
    };
  }
}
