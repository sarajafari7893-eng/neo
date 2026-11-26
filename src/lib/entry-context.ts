// ── v12.1 TASK-48 ENTRY-CONTEXT — bottom-fade + V-reversal deploy context ──
// Operator mandate 2026-10-19: «پیشنهادها را کامل و مهندسی اجرا کن» — the four
// Task-47 APRUSDT/BRUSDT forensics proposals, items ③+④. Pure decision math
// (unit-replayable) + one DB-tape reader (engine's own PricePoint history).
//
// EVIDENCE BASE (scripts/verify-task48-guards.ts, Tehran 10-18 book):
//   deep stops  — NX-2770 APR SHORT: RSI 18.0 oversold, entry 23% of ±30min
//                 range, price had ALREADY bounced +3.71% off the local low
//                 (the inverse-V pump leg began at 09:35); NX-2779 BRU SHORT:
//                 %B −0.01 below lower band, entry 25% of range; NX-2769 BTW
//                 SHORT: %B −0.25 stretched, entry 19% of range.
//   winners     — 14/14 recent +9..+70% SHORT winners carried RSI 30.2–47.3,
//                 %B 0.03–0.53, bounce-off-low ≤ 0.92% — the guards below are
//                 tuned to separate exactly these two cohorts (verified 0
//                 false blocks on the winner control set).
// Doctrine: the guards NEVER block operator-forced deploys; RAW-CAL capture
// rides through tagged (same audited-override doctrine as LIQUIDITY-FLOOR /
// PHANTOM-FEED / REENTRY-LOCKOUT). Fail-open on internal error — a context
// guard must never wedge the deploy path.

import { db } from "./db";
import { rsi, bollingerPercentB } from "./indicators";

export interface BottomFadeCfg {
  enabled: boolean;
  /** entry must sit in the BOTTOM x% of the ±30min local range (height of range, 0=low) */
  bottomPct: number;
  /** RSI(14, 15m closes) at or below → oversold-stretch leg of the AND */
  rsiMax: number;
  /** %B(20,2, 15m closes) at or below → band-stretch leg of the OR */
  bbMax: number;
  /** local range window in minutes */
  rangeMinutes: number;
}

export interface VRevCfg {
  enabled: boolean;
  /** bounce off the local low ≥ this % → young V-reversal in progress */
  bouncePct: number;
  /** require a material range — a V inside a tight ribbon is noise */
  minRangePct: number;
  /** LONG-mirror enforcement: false = shadow-only (journaled, never blocks) */
  enforceLongMirror: boolean;
  rangeMinutes: number;
}

export const BOTTOM_FADE_DEFAULTS: BottomFadeCfg = {
  enabled: true,
  bottomPct: 30,
  rsiMax: 25,
  bbMax: 0,
  rangeMinutes: 30,
};

export const VREV_DEFAULTS: VRevCfg = {
  enabled: true,
  bouncePct: 1.5,
  minRangePct: 2.5,
  enforceLongMirror: false, // v12.1: SHORT-bias breaker enforced; LONG side shadow (STABLE-REGIME doctrine)
  rangeMinutes: 30,
};

export interface TapeCtx {
  ok: boolean;
  points: number;
  lo: number;
  hi: number;
  heightPct: number; // (hi-lo)/lo ×100 — range materiality
  entryHeightPct: number; // 0 = entry AT the low, 100 = AT the high
  bounceOffLowPct: number; // (entry-lo)/lo ×100
  dropOffHighPct: number; // (entry-hi)/hi ×100 (negative below the high)
}

export const EMPTY_CTX: TapeCtx = { ok: false, points: 0, lo: 0, hi: 0, heightPct: 0, entryHeightPct: 50, bounceOffLowPct: 0, dropOffHighPct: 0 };

/** Pure ±rangeMinutes window context from a tape (t ascending, p>0). */
export function computeTapeContext(
  points: Array<{ t: number; p: number }>,
  entry: number,
  nowMs: number,
  rangeMinutes = 30,
): TapeCtx {
  const from = nowMs - (rangeMinutes + 2) * 60_000;
  const to = nowMs + 5 * 60_000;
  const win = points.filter((pt) => pt.t >= from && pt.t <= to && pt.p > 0);
  if (win.length < 4 || !(entry > 0)) return { ...EMPTY_CTX };
  const lo = Math.min(...win.map((pt) => pt.p));
  const hi = Math.max(...win.map((pt) => pt.p));
  if (!(hi > lo) || lo <= 0) return { ...EMPTY_CTX, points: win.length };
  const heightPct = ((hi - lo) / lo) * 100;
  const entryHeightPct = ((entry - lo) / (hi - lo)) * 100;
  return {
    ok: true,
    points: win.length,
    lo,
    hi,
    heightPct,
    entryHeightPct,
    bounceOffLowPct: ((entry - lo) / lo) * 100,
    dropOffHighPct: ((entry - hi) / hi) * 100,
  };
}

export interface GuardVerdict {
  blocked: boolean;
  shadow: boolean; // journaled as would-block but NOT enforcing
  reason: string;
  rsi14: number | null;
  bbB: number | null;
}

/**
 * ③ BOTTOM-FADE — refuse SHORT when the entry sells the bottom of the local
 * range INTO oversold/band-stretched conditions (the support-fade class where
 * mean-reversion bounces are born: APR 09:16 / BRU 10:49 forensics).
 * LONG mirror intentionally not implemented — the LONG book is governed by
 * the EQ-100 CHOP ledger + V-REV shadow instead.
 */
export function bottomFadeVerdict(
  ctx: TapeCtx,
  closes15m: number[] | null | undefined,
  direction: "LONG" | "SHORT",
  cfg: BottomFadeCfg,
): GuardVerdict {
  const rsi14 = closes15m && closes15m.length >= 15 ? rsi(closes15m) : null;
  const bbB = closes15m && closes15m.length >= 20 ? bollingerPercentB(closes15m) : null;
  if (!cfg.enabled || direction !== "SHORT" || !ctx.ok) {
    return { blocked: false, shadow: false, reason: "", rsi14, bbB };
  }
  if (ctx.entryHeightPct > cfg.bottomPct) {
    return { blocked: false, shadow: false, reason: "", rsi14, bbB };
  }
  const oversold = rsi14 !== null && rsi14 <= cfg.rsiMax;
  const stretched = bbB !== null && bbB <= cfg.bbMax;
  if (!oversold && !stretched) {
    return { blocked: false, shadow: false, reason: "", rsi14, bbB };
  }
  return {
    blocked: true,
    shadow: false,
    reason: `selling the bottom ${(cfg.bottomPct).toFixed(0)}% of the ±${cfg.rangeMinutes}m range (entry at ${ctx.entryHeightPct.toFixed(0)}% height, range ${(ctx.heightPct).toFixed(1)}%) with ${oversold ? `RSI ${rsi14!.toFixed(1)} ≤ ${cfg.rsiMax}` : `%B ${bbB!.toFixed(2)} ≤ ${cfg.bbMax}`} — support-fade class (Task-48 evidence: NX-2770 RSI 18 / NX-2779 %B −0.01 / NX-2769 %B −0.25 = −$18.42 combined)`,
    rsi14,
    bbB,
  };
}

/**
 * ④ V-REVERSAL — refuse SHORT while a YOUNG violent bounce is running off the
 * local low (entering short 1.5%+ above the ±30min low = selling the first leg
 * of a V; APR inverse-V forensics: the +3.71% bounce at 09:16 became +21% by
 * 09:55). The LONG mirror runs SHADOW-ONLY by default (journaled would-blocks
 // ground-truth the cohort before it ever refuses a knife-catch long).
 */
export function vRevVerdict(ctx: TapeCtx, direction: "LONG" | "SHORT", cfg: VRevCfg): GuardVerdict {
  if (!cfg.enabled || !ctx.ok) return { blocked: false, shadow: false, reason: "", rsi14: null, bbB: null };
  const rangeMaterial = ctx.heightPct >= cfg.minRangePct;
  if (!rangeMaterial) return { blocked: false, shadow: false, reason: "", rsi14: null, bbB: null };
  if (direction === "SHORT") {
    if (ctx.bounceOffLowPct >= cfg.bouncePct) {
      return {
        blocked: true,
        shadow: false,
        reason: `young V-reversal — price already bounced +${ctx.bounceOffLowPct.toFixed(2)}% off the ±${cfg.rangeMinutes}m low (entry at ${ctx.entryHeightPct.toFixed(0)}% of a ${(ctx.heightPct).toFixed(1)}% range) — shorting the first leg of a V (Task-48 evidence: NX-2770 bounced +3.71% at entry → +21% pump within 39m)`,
        rsi14: null,
        bbB: null,
      };
    }
    return { blocked: false, shadow: false, reason: "", rsi14: null, bbB: null };
  }
  // LONG mirror — shadow only unless enforceLongMirror is enabled
  if (Math.abs(ctx.dropOffHighPct) >= cfg.bouncePct) {
    return {
      blocked: cfg.enforceLongMirror,
      shadow: !cfg.enforceLongMirror,
      reason: `[${cfg.enforceLongMirror ? "ENFORCED" : "SHADOW"}] V-collapse mirror — price already dropped ${ctx.dropOffHighPct.toFixed(2)}% off the ±${cfg.rangeMinutes}m high (entry at ${ctx.entryHeightPct.toFixed(0)}% of a ${(ctx.heightPct).toFixed(1)}% range) — buying the first leg of an inverse-V`,
      rsi14: null,
      bbB: null,
    };
  }
  return { blocked: false, shadow: false, reason: "", rsi14: null, bbB: null };
}

// ── DB tape reader (30s memo — deploy path only, never the tick loop) ───────
interface CtxMemoEntry { at: number; lo: number; hi: number; points: number; ok: boolean }
const ctxMemo = new Map<string, CtxMemoEntry>();
const CTX_MEMO_TTL = 30_000;

/** ±rangeMinutes PricePoint window for one symbol — the same DB tape the
 *  PHANTOM-FEED gate reads. Never throws; ok=false on any problem. */
export async function getDeployTapeContext(symbol: string, entry: number, rangeMinutes = 30): Promise<TapeCtx> {
  const key = `${symbol}|${rangeMinutes}`;
  const hit = ctxMemo.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CTX_MEMO_TTL && hit.ok) {
    // lo/hi are entry-independent — recompute only the entry-relative geometry
    if (!(hit.hi > hit.lo)) return { ...EMPTY_CTX, points: hit.points };
    const heightPct = ((hit.hi - hit.lo) / hit.lo) * 100;
    return {
      ok: true,
      points: hit.points,
      lo: hit.lo,
      hi: hit.hi,
      heightPct,
      entryHeightPct: ((entry - hit.lo) / (hit.hi - hit.lo)) * 100,
      bounceOffLowPct: ((entry - hit.lo) / hit.lo) * 100,
      dropOffHighPct: ((entry - hit.hi) / hit.hi) * 100,
    };
  }
  try {
    const rows = await db.pricePoint.findMany({
      where: { symbol, createdAt: { gte: new Date(now - (rangeMinutes + 3) * 60_000) } },
      orderBy: { createdAt: "asc" },
      select: { price: true, createdAt: true },
    });
    const ctx = computeTapeContext(rows.map((r) => ({ t: r.createdAt.getTime(), p: r.price })), entry, now, rangeMinutes);
    ctxMemo.set(key, { at: now, lo: ctx.lo, hi: ctx.hi, points: ctx.points, ok: ctx.ok });
    return ctx;
  } catch {
    return { ...EMPTY_CTX };
  }
}
