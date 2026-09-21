// ── FlowRadar Neo v10.13+v10.14 NEAR-MISS EVIDENCE PROGRAM (server-only) ──
// Operator APPROVE 2026-09-18T18:58Z (bridge msg 861802415: «تایید پیشنهاد
// سوپروایزر کامل و مهندسی انجام بده») + operator APPROVE 2026-09-19T08:56Z
// (bridge msg 861802419: «پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده») —
// implements the supervisor paper-tier proposals as ONE evidence program,
// ZERO live risk (paper only, no orders, no EngineSetting writes, no gate
// changes):
//
//   Tier S (SCORE-NEAR-MISS, supervisor proposal msg 3677): scan-batch
//   candidates rejected ONLY by the score gate with |adjScore| in
//   [0.85, 1.0)×effMin (gap ∈ [−0.15×effMin, 0)). Top-1 per sweep (closest
//   to the gate buys the most evidence). Paper geometry mirrors the engine
//   (SL 2×ATR-class, strategy RR ladder, SV paper margin).
//
//   Tier B (BARRIER-NEAR-MISS, supervisor proposal 2026-09-18T18:53Z): the
//   drought diagnosis proved the binding constraint moved from MIN_SCORE
//   (relieved 40→35 at 16:43Z) to the VOL-SCALED VERTICAL BARRIER (cap 240m
//   rejecting ETHUSDT LONG t1r 252-432m). When a candidate is rejected by
//   the barrier with projected 1R-touch t1r ∈ (cap, 1.5×cap] — i.e. a
//   hypothetical 1.5×cap barrier would have carried it — capture a paper
//   trade with the ENGINE-IDENTICAL ladder built just above the skip point
//   and ttlMinutes = the hypothetical barrier min(1.5×cap, t1r × mult).
//   Settle outcomes answer "is the barrier cap over-tight?" from measured
//   outcomes, not opinion.
//   v10.14 (BARRIER-CAP-NEAR-MISS, supervisor proposal 2026-09-19T06:51Z,
//   approved 2026-09-19T08:56Z msg 861802419): with the REGIME-ADAPTIVE cap
//   live (volBarrierAdaptive=1), every call passes the EFFECTIVE cap — the
//   band (effCap, 1.5×effCap] and the hypothetical barrier now ride the
//   adaptive policy, and each capture carries volPctile + capUsed + baseCap
//   metadata so the cohort can be split fixed-cap vs adaptive-cap: the
//   counterfactual audit trail of the widening itself ("did the relaxation
//   admit winners, or censored rows?").
//
//   Tier G (GATE-NEAR-MISS, supervisor proposal msg 3920 2026-09-19T03:00Z,
//   approved 2026-09-19T08:56Z msg 861802419): candidates that PASSED the
//   score gate but were suppressed by the MEMORY gate (realized-edge
//   profit-first filter) — captured paper with engine-identical geometry so
//   the gate's OPPORTUNITY COST is measured, not assumed. Decision rule
//   (per proposal): ≥30 settled GATE cohort with NEGATIVE counterfactual
//   expectancy vindicates the −2% floor (keep gate); POSITIVE expectancy →
//   file advisor KNOB_ADJUST upgrading the memory-gate statistic to the
//   SQN-style R-normalized score (expectancy(R)/std(R) × √N — Van Tharp SQN,
//   computed and surfaced per arm below; meta-labeling doctrine requires the
//   FILTER itself to be evidence-validated). The live gate decision rules
//   are UNCHANGED until that evidence lands.
//
// LITERATURE: Hudson & Thames meta-labeling + MDPI 2024 (enhanced GA triple
// barrier) — meta-labels on triple-barrier time-expiry samples improve signal
// efficacy; this module produces exactly those labels (barrier-rejected
// cohorts labelled by hypothetical-barrier outcomes) for the next calibration.
//
// RAILS (anti-flood + honesty):
//  · daily capture cap 8 per tier (per UTC day)
//  · dedup 120min per tier|symbol|direction
//  · max 16 concurrent open papers per tier (drop new when full)
//  · rolling-30 settled arms per tier + Wilson-LB95 (same math as SV arms)
//  · persistence .data/near-miss.jsonl (SV jsonl pattern); in-memory rings;
//    7d prune for settled rows
//  · FAIL-OPEN everywhere: never throws into the scan/deploy path

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { feeBreakdown, ladderWeightedMove, LADDER_TRANCHES } from "@/lib/accounting";
import { fetchKlines } from "@/lib/market-feed";
import { buildSnapshot } from "@/lib/indicators";
import { getGateSettings } from "@/lib/gate-settings";
import { ARM_EPOCH, wilsonLB, getShadowVetoConfig, type FenceCandidate } from "@/lib/shadow-veto";

// ── types ─────────────────────────────────────────────────────

export type NMTier = "SCORE" | "BARRIER" | "GATE";

export interface NMOutcome {
  status: string; // TP1/TP2/TP3/SL/EXPIRED
  pnlPercent: number; // margin-relative NET (engine contract)
  pnlUsd: number;
  win: boolean; // pnlPercent > 0 || reachedTp ≥ 1 (engine win rule)
  closedAt: number;
}

export interface NMCapture {
  id: string; // NM-xxxx
  tier: NMTier;
  at: number;
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entry: number;
  stop: number; // effective (trailed) stop
  initialStop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  leverage: number;
  marginUsd: number;
  slDistPct: number;
  rr: number;
  ttlMinutes: number; // hypothetical barrier (tier B) / band draw (tier S)
  t1rMin: number | null; // tier B — projected 1R touch (the rejected quantity)
  scoreGap: number | null; // tier S — |adjScore| − effMin (negative)
  status: "OPEN" | "TP1" | "TP2" | "TP3" | "SL" | "EXPIRED";
  reachedTp: number; // 0..3 — TP-proven ledger
  maxPnlPercent: number;
  pnlPercent: number;
  pnlUsd: number;
  outcome: NMOutcome | null;
  closeNote: string | null;
  epoch: string; // ARM_EPOCH stamp — regime-aligned cohorting
  // v10.14 tier-B regime metadata — the BARRIER-CAP-NEAR-MISS audit trail:
  volPctile: number | null; // realized-vol percentile at reject (null = feed fail / fixed-cap era)
  capUsed: number | null; // EFFECTIVE cap the reject was measured against (adaptive)
  baseCap: number | null; // operator knob volBarrierCapMin (the fixed base)
  gateReason: string | null; // tier G — the memory-gate suppression reason
}

export interface NMArmRow {
  id: "nm-score" | "nm-barrier" | "nm-gate";
  label: string;
  n: number;
  wins: number;
  winRatePct: number | null;
  wilsonLB: number | null;
  netUsd: number;
  target: number;
  epoch: string;
  // v10.14 — SQN-style R-normalized statistics (supervisor proposal msg 3920):
  // R proxy per settled paper = pnlPercent / (slDistPct × 100 × leverage)
  // (margin-relative NET over the levered 1R distance). SQN is scale-free so
  // the ratio mean(R)/std(R) is invariant to the proxy's unit — robust to the
  // heavy-tail SL rows that distort raw mean-% gates.
  sqn: number | null; // √N × mean(R)/std(R), population std (ddof 0)
  sqnTrim: number | null; // same on a 10%-trimmed R series (outlier-hardened)
  meanR: number | null; // counterfactual expectancy in R
  expPct: number | null; // counterfactual expectancy in % of margin (mean pnlPercent)
}

// ── config / rails ────────────────────────────────────────────

const DAILY_CAP_PER_TIER = 8; // ~8/day per tier (supervisor estimate, anti-spam)
const DEDUP_MS = 120 * 60_000; // 2h per tier|symbol|direction
const MAX_OPEN_PER_TIER = 16;
const MAX_ROWS = 400; // ring cap
const SETTLED_TTL_MS = 7 * 24 * 3600_000; // 7d prune for settled rows
const BARRIER_BAND_MULT = 1.5; // capture band = (cap, 1.5×cap]
const ROLLING = 30; // rolling-30 settled per arm (v10.10 SV semantics)

// mirror of engine.ts deploySignal constants (engine owns the canonical
// values; kept in sync — score-tier paper geometry only)
const RR_BASE: Record<string, number> = { "AI-SCALP": 2.1, "MEAN-REVERT": 2.4, MOMENTUM: 2.8, BREAKOUT: 3.1, "AI-SWING": 3.4 };
const TTL_BY_STRATEGY: Record<string, [number, number]> = {
  "AI-SCALP": [60, 90],
  BREAKOUT: [90, 150],
  MOMENTUM: [90, 150],
  "MEAN-REVERT": [60, 120],
  "AI-SWING": [180, 300],
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "near-miss.jsonl");

// ── store ─────────────────────────────────────────────────────

let rows: NMCapture[] = [];
let seq = 0;
let loaded = false;
let loadPromise: Promise<void> | null = null;
const lastCapAt = new Map<string, number>(); // tier|symbol|direction → ts
const dayCount = new Map<string, number>(); // tier|YYYYMMDD → count

async function persist(rec: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(DATA_FILE, JSON.stringify(rec) + "\n", "utf8");
  } catch {
    /* evidence persistence must never break the scan */
  }
}

async function load(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const st = await stat(DATA_FILE).catch(() => null);
      if (st?.size) {
        const txt = await readFile(DATA_FILE, "utf8");
        for (const line of txt.split("\n")) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line) as { k: string; v: NMCapture | { id: string; status: string; reachedTp: number; pnlPercent: number; pnlUsd: number; outcome: NMOutcome; closeNote: string } };
            if (j.k === "c") {
              const cap = j.v as NMCapture;
              if (!rows.some((r) => r.id === cap.id)) rows.push(cap);
              const n = Number(cap.id.replace("NM-", ""));
              if (Number.isFinite(n) && n > seq) seq = n;
            } else if (j.k === "pc") {
              const p = j.v as { id: string; status: string; reachedTp: number; pnlPercent: number; pnlUsd: number; outcome: NMOutcome; closeNote: string };
              const r = rows.find((x) => x.id === p.id);
              if (r && !r.outcome) {
                r.status = p.status as NMCapture["status"];
                r.reachedTp = p.reachedTp;
                r.pnlPercent = p.pnlPercent;
                r.pnlUsd = p.pnlUsd;
                r.outcome = p.outcome;
                r.closeNote = p.closeNote;
              }
            }
          } catch {
            /* skip malformed line */
          }
        }
      }
    } catch {
      /* start empty */
    }
    // v10.14 backfill — pre-v10.14 rows predate the regime/decision metadata
    for (const r of rows) {
      if (r.volPctile === undefined) r.volPctile = null;
      if (r.capUsed === undefined) r.capUsed = null;
      if (r.baseCap === undefined) r.baseCap = null;
      if (r.gateReason === undefined) r.gateReason = null;
    }
    loaded = true;
  })();
  return loadPromise;
}

function trimRows(): void {
  if (rows.length <= MAX_ROWS) return;
  const settledOld = rows.filter((r) => r.outcome && Date.now() - (r.outcome.closedAt || r.at) > SETTLED_TTL_MS);
  for (const r of settledOld.sort((a, b) => (a.outcome?.closedAt || 0) - (b.outcome?.closedAt || 0))) {
    if (rows.length <= MAX_ROWS) break;
    rows = rows.filter((x) => x.id !== r.id);
  }
  while (rows.length > MAX_ROWS) rows.shift();
}

const dayKey = (d = new Date()): string => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

function railsOk(tier: NMTier, symbol: string, direction: string, openInTier: number): boolean {
  const dk = `${tier}|${dayKey()}`;
  if ((dayCount.get(dk) ?? 0) >= DAILY_CAP_PER_TIER) return false;
  const key = `${tier}|${symbol}|${direction}`;
  const last = lastCapAt.get(key) ?? 0;
  if (Date.now() - last < DEDUP_MS) return false;
  if (openInTier >= MAX_OPEN_PER_TIER) return false;
  return true;
}

function markRails(tier: NMTier, symbol: string, direction: string): void {
  lastCapAt.set(`${tier}|${symbol}|${direction}`, Date.now());
  const dk = `${tier}|${dayKey()}`;
  dayCount.set(dk, (dayCount.get(dk) ?? 0) + 1);
}

const movePctAt = (p: NMCapture, px: number): number => ((px - p.entry) / p.entry) * (p.direction === "LONG" ? 1 : -1) * 100;

// ── tier B: barrier near-miss (engine VOL-BARRIER skip point) ──

export interface BarrierMissCtx {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  entry: number;
  stopLoss: number; // initial (pre-trail) stop — engine-identical
  tp1: number;
  tp2: number;
  tp3: number;
  slDistPct: number;
  rr: number;
  t1rMin: number; // projected 1R touch that exceeded the cap
  capMin: number; // EFFECTIVE cap (v10.14: adaptive cap when volBarrierAdaptive=1, else gate.volBarrierCapMin)
  volBarrierMult: number; // gate.volBarrierMult (headroom multiplier)
  volPctile?: number | null; // v10.14 realized-vol percentile at reject (regime metadata)
  baseCap?: number | null; // v10.14 the fixed base knob (volBarrierCapMin)
}

/** Capture a paper trade for a candidate rejected by the VOL-SCALED BARRIER
 * whose projected 1R touch sits in (cap, 1.5×cap]. Hypothetical barrier TTL =
 * min(1.5×cap, t1r × mult) — the barrier the trade WOULD have ridden. Fire-
 * and-forget from engine.ts; never throws. */
export async function nearMissCaptureBarrier(ctx: BarrierMissCtx): Promise<void> {
  try {
    await load();
    if (!(ctx.t1rMin > ctx.capMin) || !(ctx.t1rMin <= ctx.capMin * BARRIER_BAND_MULT)) return;
    if (!Number.isFinite(ctx.entry) || ctx.entry <= 0 || !(ctx.rr > 0)) return;
    const openB = rows.filter((r) => r.tier === "BARRIER" && !r.outcome).length;
    if (!railsOk("BARRIER", ctx.symbol, ctx.direction, openB)) return;
    const cfg = await getShadowVetoConfig();
    const hypBarrier = Math.round(Math.min(ctx.capMin * BARRIER_BAND_MULT, ctx.t1rMin * ctx.volBarrierMult));
    if (!(hypBarrier > ctx.capMin)) return;
    const levRaw = Math.round(Math.min(20, Math.max(5, 60 / (ctx.slDistPct * 100))));
    seq++;
    const cap: NMCapture = {
      id: `NM-${String(seq).padStart(4, "0")}`,
      tier: "BARRIER",
      at: Date.now(),
      symbol: ctx.symbol,
      direction: ctx.direction,
      strategy: ctx.strategy,
      entry: Number(ctx.entry.toFixed(ctx.entry > 100 ? 2 : 6)),
      stop: Number(ctx.stopLoss.toFixed(ctx.entry > 100 ? 2 : 6)),
      initialStop: Number(ctx.stopLoss.toFixed(ctx.entry > 100 ? 2 : 6)),
      tp1: Number(ctx.tp1.toFixed(ctx.entry > 100 ? 2 : 6)),
      tp2: Number(ctx.tp2.toFixed(ctx.entry > 100 ? 2 : 6)),
      tp3: Number(ctx.tp3.toFixed(ctx.entry > 100 ? 2 : 6)),
      leverage: levRaw,
      marginUsd: cfg.paperMarginUsd,
      slDistPct: ctx.slDistPct,
      rr: ctx.rr,
      ttlMinutes: hypBarrier,
      t1rMin: Math.round(ctx.t1rMin),
      scoreGap: null,
      status: "OPEN",
      reachedTp: 0,
      maxPnlPercent: 0,
      pnlPercent: 0,
      pnlUsd: 0,
      outcome: null,
      closeNote: null,
      epoch: ARM_EPOCH,
      volPctile: ctx.volPctile ?? null,
      capUsed: ctx.capMin,
      baseCap: ctx.baseCap ?? ctx.capMin,
      gateReason: null,
    };
    rows.push(cap);
    trimRows();
    markRails("BARRIER", ctx.symbol, ctx.direction);
    void persist({ k: "c", v: cap });
    try {
      const { fireEvent } = await import("@/lib/engine");
      const regime = ctx.volPctile != null && ctx.capMin !== ctx.baseCap ? ` · regime p${Math.round(ctx.volPctile)} → adaptive cap ${ctx.capMin}m` : "";
      void fireEvent(null, ctx.symbol, "ENGINE", "info", `NEAR-MISS CAPTURE [BARRIER]: ${ctx.direction} ${ctx.symbol} ${ctx.strategy} paper NM-${String(seq).padStart(4, "0")} — t1r ${Math.round(ctx.t1rMin)}m rejected vs cap ${ctx.capMin}m → hypothetical barrier ${hypBarrier}m (ladder rr ${ctx.rr})${regime} · zero live risk`).catch(() => undefined);
    } catch {
      /* terminal event best-effort */
    }
  } catch {
    /* fail-open */
  }
}

// ── tier G: gate near-miss (memory-gate suppress point, engine.ts) ──

export interface GateMissCtx {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  reason: string; // memory-gate suppression reason (audited into the paper row)
}

/** v10.14 GATE-NEAR-MISS capture (supervisor proposal msg 3920, operator
 * APPROVE 2026-09-19T08:56Z msg 861802419): a candidate that PASSED the score
 * gate but was suppressed by the MEMORY gate becomes a paper trade with
 * engine-identical geometry (scoreGeometry — SL = slAtrMult × ATR, strategy
 * RR ladder, random-band TTL). The settled cohort measures the memory gate's
 * opportunity cost; ≥30 settles with positive counterfactual expectancy is
 * the advisor KNOB_ADJUST trigger for the SQN-based statistic upgrade.
 * Fire-and-forget from engine.ts; never throws. */
export async function nearMissCaptureGate(ctx: GateMissCtx): Promise<void> {
  try {
    await load();
    if (!ctx.symbol || !ctx.strategy) return;
    const openG = rows.filter((r) => r.tier === "GATE" && !r.outcome).length;
    if (!railsOk("GATE", ctx.symbol, ctx.direction, openG)) return;
    const geo = await scoreGeometry(ctx.symbol, ctx.direction, ctx.strategy);
    if (!geo) return;
    const cfg = await getShadowVetoConfig();
    seq++;
    const cap: NMCapture = {
      id: `NM-${String(seq).padStart(4, "0")}`,
      tier: "GATE",
      at: Date.now(),
      symbol: ctx.symbol,
      direction: ctx.direction,
      strategy: ctx.strategy,
      entry: geo.entry,
      stop: geo.initialStop,
      initialStop: geo.initialStop,
      tp1: geo.tp1,
      tp2: geo.tp2,
      tp3: geo.tp3,
      leverage: geo.leverage,
      marginUsd: cfg.paperMarginUsd,
      slDistPct: geo.slDistPct,
      rr: geo.rr,
      ttlMinutes: geo.ttlMinutes,
      t1rMin: null,
      scoreGap: null,
      status: "OPEN",
      reachedTp: 0,
      maxPnlPercent: 0,
      pnlPercent: 0,
      pnlUsd: 0,
      outcome: null,
      closeNote: null,
      epoch: ARM_EPOCH,
      volPctile: null,
      capUsed: null,
      baseCap: null,
      gateReason: (ctx.reason || "").slice(0, 240),
    };
    rows.push(cap);
    trimRows();
    markRails("GATE", ctx.symbol, ctx.direction);
    void persist({ k: "c", v: cap });
    try {
      const { fireEvent } = await import("@/lib/engine");
      void fireEvent(null, ctx.symbol, "ENGINE", "info", `NEAR-MISS CAPTURE [GATE]: ${ctx.direction} ${ctx.symbol} ${ctx.strategy} paper NM-${String(seq).padStart(4, "0")} — memory-gate suppressed (${(ctx.reason || "").slice(0, 120)}) → hypothetical admission, ladder rr ${geo.rr} · zero live risk`).catch(() => undefined);
    } catch {
      /* terminal event best-effort */
    }
  } catch {
    /* fail-open */
  }
}

// ── tier S: score near-miss (scan fence batches) ──────────────

async function scoreGeometry(symbol: string, direction: "LONG" | "SHORT", strategy: string): Promise<{ entry: number; initialStop: number; tp1: number; tp2: number; tp3: number; leverage: number; slDistPct: number; rr: number; ttlMinutes: number } | null> {
  try {
    const gate = await getGateSettings();
    const candles = await fetchKlines(symbol, "15m", 160).catch(() => null);
    const snap = candles ? buildSnapshot(symbol, candles) : null;
    const entry = snap?.price ?? 0;
    if (!entry) return null;
    const atrPct = snap?.atrPct ?? 1.5;
    const slDistPct = Math.min(5, Math.max(0.7, gate.slAtrMult * atrPct)) / 100;
    const levRaw = Math.round(Math.min(20, Math.max(5, 60 / (slDistPct * 100))));
    const leverage = gate.leveredRiskCap > 0 && slDistPct * 100 * levRaw > gate.leveredRiskCap ? Math.max(5, Math.floor(gate.leveredRiskCap / (slDistPct * 100))) : levRaw;
    const rr = RR_BASE[strategy] ?? 2.6;
    const tp2Mult = Math.min(2.2, Math.max(1.5, 1.2 + rr * 0.22));
    const [ttlMin, ttlMax] = TTL_BY_STRATEGY[strategy] ?? [90, 180];
    const isLong = direction === "LONG";
    const risk = entry * slDistPct;
    const fx = (v: number) => Number(v.toFixed(entry > 100 ? 2 : 6));
    return {
      entry: fx(entry),
      initialStop: fx(isLong ? entry - risk : entry + risk),
      tp1: fx(isLong ? entry + risk : entry - risk),
      tp2: fx(isLong ? entry + risk * tp2Mult : entry - risk * tp2Mult),
      tp3: fx(isLong ? entry + risk * rr : entry - risk * rr),
      leverage,
      slDistPct,
      rr,
      ttlMinutes: Math.round(ttlMin + Math.random() * (ttlMax - ttlMin)),
    };
  } catch {
    return null;
  }
}

/** Offer a scan fence batch to the SCORE near-miss tier: rejects with gap =
 * |adjScore| − effMin ∈ [−0.15×effMin, 0) (|adjScore| ≥ 0.85×effMin — the
 * 0.85-1.0× band from supervisor proposal msg 3677). Top-1 per call (closest
 * to the gate), self-budgeted, deduped, never throws. */
export async function nearMissCaptureScore(batch: FenceCandidate[]): Promise<void> {
  try {
    await load();
    if (!Array.isArray(batch) || batch.length === 0) return;
    const band = batch
      .filter((c) => c && !c.passed && Number.isFinite(c.score) && Number.isFinite(c.effMin) && c.effMin > 0)
      .map((c) => ({ c, gap: Math.abs(c.score) - c.effMin, bandFloor: -0.15 * c.effMin }))
      .filter(({ gap, bandFloor }) => gap < 0 && gap >= bandFloor)
      .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)); // closest to gate first
    if (band.length === 0) return;
    const openS = rows.filter((r) => r.tier === "SCORE" && !r.outcome).length;
    const cand = band[0]!;
    if (!railsOk("SCORE", cand.c.symbol, cand.c.direction, openS)) return;
    const geo = await scoreGeometry(cand.c.symbol, cand.c.direction, cand.c.strategy);
    if (!geo) return;
    const cfg = await getShadowVetoConfig();
    seq++;
    const cap: NMCapture = {
      id: `NM-${String(seq).padStart(4, "0")}`,
      tier: "SCORE",
      at: Date.now(),
      symbol: cand.c.symbol,
      direction: cand.c.direction,
      strategy: cand.c.strategy,
      entry: geo.entry,
      stop: geo.initialStop,
      initialStop: geo.initialStop,
      tp1: geo.tp1,
      tp2: geo.tp2,
      tp3: geo.tp3,
      leverage: geo.leverage,
      marginUsd: cfg.paperMarginUsd,
      slDistPct: geo.slDistPct,
      rr: geo.rr,
      ttlMinutes: geo.ttlMinutes,
      t1rMin: null,
      scoreGap: Number(cand.gap.toFixed(1)),
      status: "OPEN",
      reachedTp: 0,
      maxPnlPercent: 0,
      pnlPercent: 0,
      pnlUsd: 0,
      outcome: null,
      closeNote: null,
      epoch: ARM_EPOCH,
      volPctile: null,
      capUsed: null,
      baseCap: null,
      gateReason: null,
    };
    rows.push(cap);
    trimRows();
    markRails("SCORE", cand.c.symbol, cand.c.direction);
    void persist({ k: "c", v: cap });
    try {
      const { fireEvent } = await import("@/lib/engine");
      void fireEvent(null, cand.c.symbol, "ENGINE", "info", `NEAR-MISS CAPTURE [SCORE]: ${cand.c.direction} ${cand.c.symbol} ${cand.c.strategy} paper NM-${String(seq).padStart(4, "0")} — |score| ${Math.abs(cand.c.score).toFixed(0)} vs eff ${cand.c.effMin.toFixed(0)} (gap ${cand.gap.toFixed(1)}, band 0.85-1.0×) → paper ladder rr ${geo.rr} · zero live risk`).catch(() => undefined);
    } catch {
      /* terminal event best-effort */
    }
  } catch {
    /* fail-open */
  }
}

// ── sweep (engine tick) — identical resolver semantics to SV papers ──

export function nearMissOpenCount(): number {
  let open = 0;
  for (const p of rows) if (!p.outcome) open++;
  return open;
}

export async function nearMissSweep(priceMap: Map<string, number>): Promise<number> {
  try {
    if (rows.length === 0) return 0;
    const now = Date.now();
    let closed = 0;
    for (const p of rows) {
      if (p.outcome) continue;
      const price = priceMap.get(p.symbol);
      if (!price) continue;
      const isLong = p.direction === "LONG";
      const hitSl = isLong ? price <= p.stop : price >= p.stop;
      const hitTp1 = isLong ? price >= p.tp1 : price <= p.tp1;
      const hitTp2 = isLong ? price >= p.tp2 : price <= p.tp2;
      const hitTp3 = isLong ? price >= p.tp3 : price <= p.tp3;
      if (hitSl) {
        closeCapture(p, "SL", movePctAt(p, p.stop), now, `stopped @ ${p.stop} (trailed)`);
        closed++;
      } else if (hitTp3) {
        p.reachedTp = 3;
        closeCapture(p, "TP3", movePctAt(p, p.tp3), now, `final target ${p.rr.toFixed(1)}R secured`);
        closed++;
      } else if (hitTp2 && p.reachedTp < 2) {
        p.reachedTp = 2;
        p.status = "TP2";
        p.stop = p.tp1; // trail to TP1 — +1R locked (engine semantics)
      } else if (hitTp1 && p.reachedTp < 1) {
        p.reachedTp = Math.max(p.reachedTp, 1);
        p.status = "TP1";
        p.stop = p.entry; // breakeven trail (engine semantics)
      } else if (now > p.at + p.ttlMinutes * 60_000) {
        closeCapture(p, "EXPIRED", movePctAt(p, price), now, `hypothetical barrier ${p.ttlMinutes}m elapsed at mark`);
        closed++;
      }
      p.maxPnlPercent = Math.max(p.maxPnlPercent, Number((movePctAt(p, price) * p.leverage).toFixed(2)));
    }
    return closed;
  } catch {
    return 0;
  }
}

/** Tranche-aware close — identical math to the real resolver (v6.6) and SV
 * closePaper: rung ladders with trailing, tranche-weighted closes, fees. */
function closeCapture(p: NMCapture, status: NMCapture["status"], exitMovePct: number, closedAt: number, note: string): void {
  const rung = (px: number) => movePctAt(p, px);
  const grossPct = p.reachedTp >= 1 ? ladderWeightedMove([{ weight: LADDER_TRANCHES.tp1, movePct: rung(p.tp1) }, ...(p.reachedTp >= 2 ? [{ weight: LADDER_TRANCHES.tp2, movePct: rung(p.tp2) }] : []), { weight: LADDER_TRANCHES.runner, movePct: status === "TP3" ? rung(p.tp3) : exitMovePct }]) : exitMovePct;
  const heldMin = Math.max(0, (closedAt - p.at) / 60_000);
  const fb = feeBreakdown(p.marginUsd, p.leverage, grossPct, heldMin);
  p.status = status;
  p.pnlPercent = Number(fb.netPct.toFixed(2));
  p.pnlUsd = Number(fb.netUsd.toFixed(3));
  p.outcome = {
    status,
    pnlPercent: p.pnlPercent,
    pnlUsd: p.pnlUsd,
    win: p.pnlPercent > 0 || p.reachedTp >= 1,
    closedAt,
  };
  p.closeNote = note;
  void persist({ k: "pc", v: { id: p.id, status: p.status, reachedTp: p.reachedTp, pnlPercent: p.pnlPercent, pnlUsd: p.pnlUsd, stop: p.stop, outcome: p.outcome, closeNote: note } });
}

// ── arms + state (API feed) ───────────────────────────────────

/** v10.14 — SQN-style R statistics on a settled paper cohort (msg 3920 spec):
 * R proxy = pnlPercent / (slDistPct × 100 × leverage) — margin-relative NET
 * over the levered 1R. SQN = √N × mean(R)/std(R) (population std); sqnTrim
 * drops the top/bottom 10% of the R series (outlier-hardened variant). All
 * null-safe: fewer than 5 settled rows → nulls. */
function sqnStats(caps: NMCapture[]): { sqn: number | null; sqnTrim: number | null; meanR: number | null; expPct: number | null } {
  const settled = caps.filter((r) => r.outcome);
  if (settled.length < 5) return { sqn: null, sqnTrim: null, meanR: null, expPct: null };
  const rs = settled.map((r) => (r.slDistPct > 0 && r.leverage > 0 ? r.pnlPercent / (r.slDistPct * 100 * r.leverage) : 0));
  const n = rs.length;
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n); // population (ddof 0)
  const sqn = sd > 0 ? Math.sqrt(n) * (mean / sd) : null;
  const sorted = [...rs].sort((a, b) => a - b);
  const k = Math.floor(n * 0.1); // 10% trim each side
  const trim = k > 0 && n - 2 * k >= 5 ? sorted.slice(k, n - k) : sorted;
  const tm = trim.reduce((a, b) => a + b, 0) / trim.length;
  const tsd = Math.sqrt(trim.reduce((a, b) => a + (b - tm) * (b - tm), 0) / trim.length);
  const sqnTrim = tsd > 0 ? Math.sqrt(trim.length) * (tm / tsd) : null;
  const expPct = settled.reduce((a, r) => a + (r.pnlPercent || 0), 0) / n;
  return { sqn: sqn === null ? null : Number(sqn.toFixed(2)), sqnTrim: sqnTrim === null ? null : Number(sqnTrim.toFixed(2)), meanR: Number(mean.toFixed(3)), expPct: Number(expPct.toFixed(2)) };
}

function armRow(id: NMArmRow["id"], label: string, caps: NMCapture[]): NMArmRow {
  const settled = caps.filter((r) => r.outcome).slice(-ROLLING); // most recent 30 settled
  const wins = settled.filter((r) => r.outcome!.win).length;
  const n = settled.length;
  const sq = sqnStats(settled);
  return {
    id,
    label,
    n,
    wins,
    winRatePct: n > 0 ? Number(((wins / n) * 100).toFixed(1)) : null,
    wilsonLB: wilsonLB(wins, n),
    netUsd: Number(settled.reduce((a, r) => a + (r.pnlUsd || 0), 0).toFixed(2)),
    target: 30,
    epoch: ARM_EPOCH,
    sqn: sq.sqn,
    sqnTrim: sq.sqnTrim,
    meanR: sq.meanR,
    expPct: sq.expPct,
  };
}

export interface NearMissState {
  ts: number;
  epoch: string;
  caps: { dailyScore: number; dailyBarrier: number; dailyGate: number; dailyCap: number; dedupMin: number; maxOpenPerTier: number; bandMult: number };
  arms: NMArmRow[];
  open: { score: number; barrier: number; gate: number };
  // v10.14 GATE-NEAR-MISS decision block (msg 3920 rule): the settled GATE
  // cohort decides the memory-gate statistic upgrade — negative counterfactual
  // expectancy at n≥30 vindicates the gate; positive files the advisor
  // KNOB_ADJUST. ready = cohort complete; verdict set only when ready.
  gateDecision: { n: number; expPct: number | null; sqn: number | null; sqnTrim: number | null; ready: boolean; verdict: "KEEP_GATE" | "FILE_KNOB_ADJUST" | null };
  recent: NMCapture[]; // newest 20, redacted to decision-relevant fields
}

export async function nearMissState(): Promise<NearMissState> {
  await load();
  const dk = dayKey();
  const gateArm = armRow("nm-gate", "NEAR-MISS · gate-blocked cohort (memory-gate suppressed, hypothetical admission)", rows.filter((r) => r.tier === "GATE"));
  const gateReady = gateArm.n >= 30;
  return {
    ts: Date.now(),
    epoch: ARM_EPOCH,
    caps: { dailyScore: dayCount.get(`SCORE|${dk}`) ?? 0, dailyBarrier: dayCount.get(`BARRIER|${dk}`) ?? 0, dailyGate: dayCount.get(`GATE|${dk}`) ?? 0, dailyCap: DAILY_CAP_PER_TIER, dedupMin: DEDUP_MS / 60_000, maxOpenPerTier: MAX_OPEN_PER_TIER, bandMult: BARRIER_BAND_MULT },
    arms: [armRow("nm-score", "NEAR-MISS · score band 0.85-1.0×effMin (paper, hypothetical admission)", rows.filter((r) => r.tier === "SCORE")), armRow("nm-barrier", "NEAR-MISS · barrier band t1r (cap, 1.5×cap] (paper, hypothetical 1.5×cap barrier — cap is regime-adaptive when volBarrierAdaptive=1)", rows.filter((r) => r.tier === "BARRIER")), gateArm],
    open: { score: rows.filter((r) => r.tier === "SCORE" && !r.outcome).length, barrier: rows.filter((r) => r.tier === "BARRIER" && !r.outcome).length, gate: rows.filter((r) => r.tier === "GATE" && !r.outcome).length },
    gateDecision: { n: gateArm.n, expPct: gateArm.expPct, sqn: gateArm.sqn, sqnTrim: gateArm.sqnTrim, ready: gateReady, verdict: !gateReady ? null : (gateArm.expPct ?? 0) > 0 ? "FILE_KNOB_ADJUST" : "KEEP_GATE" },
    recent: [...rows]
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((r) => ({ ...r })),
  };
}

export async function nearMissReady(): Promise<void> {
  await load();
}
