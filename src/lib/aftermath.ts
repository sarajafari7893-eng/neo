// ── NEXUS//SIGNALS EXPIRED-signal lifecycle (server-only, v4.6) ──
// Answers the operator question: "what happens to EXPIRED signals?"
//
// 1) TTL-EXTENSION (AI decision at expiry): when a signal reaches its TTL the
//    engine re-measures the trade NOW. If the position is NET-positive AND a
//    fresh order-flow assessment still CONFIRMS the direction, the TTL is
//    extended ONCE by 50% of the original window — the runner gets room to
//    work instead of being force-closed on a technicality. Deterministic
//    rules (no LLM guessing), every extension audited to the TERMINAL.
// 2) AFTERMATH WATCH: every EXPIRED signal is monitored for 4h after expiry —
//    post-expiry TP1/TP2/TP3 and SL touches, max favorable excursion (MFE)
//    and max adverse excursion (MAE) in margin-%. Sampled each engine tick
//    (~4s resolution — a cross-and-revert between ticks can be missed; the
//    event text says so). Result recorded on the signal row.
// 3) TTL LEARNING: aftermath outcomes feed back into deployment — per
//    strategy, the post-expiry continuation rate (share of expired signals
//    that went on to hit TP1) recalibrates the TTL window:
//      n ≥ 8 watched · rate ≥ 75% → TTL ×1.5 (exits too early)
//                    · rate ≥ 60% → TTL ×1.25
//                    · rate ≤ 25% → TTL ×0.8 (windows run long)
//    Boosts persist in EngineSetting("ttl-learning") and apply to every new
//    deployment of that strategy. No simulation — realized post-expiry
//    behavior only.
//
// EXPIRED PnL (accounting): an expired signal is closed AT the expiry price
// with the full NET model (taker ×2 + funding swap) — it counts in equity,
// the equity curve, avg PnL and the memory gate. It is not a "win" for
// win-rate purposes (win = TP1/TP2/TP3) and the AFTERMATH chip on the card
// now shows what the setup did AFTER the engine stepped away.

import { db } from "@/lib/db";
import type { Signal } from "@prisma/client";
import { assessFlow } from "@/lib/flow";
import { fetchKlines } from "@/lib/market-feed";
import { feeBreakdown } from "@/lib/accounting";

export const AFTERMATH_WATCH_MS = 4 * 3600_000; // 4h post-expiry monitor
export const TTL_LEARN_MIN = 8; // settled aftermath observations before a boost applies

/* ── shared helpers (mirror engine's computePnl — kept local to avoid the
 * engine↔aftermath import cycle; identical arithmetic) ── */

function movePct(price: number, s: Signal): number {
  const dir = s.direction === "LONG" ? 1 : -1;
  return ((price - s.entryPrice) / s.entryPrice) * dir * s.leverage * 100;
}

async function logEvent(
  signalId: string | null,
  symbol: string | null,
  type: string,
  level: string,
  message: string
): Promise<void> {
  await db.signalEvent.create({ data: { signalId, symbol, type, level, message } });
}

const nx = (s: Signal) => `[NX-${String(s.serial).padStart(3, "0")}]`;

/* ── aftermath record ─────────────────────────────────────────── */

export interface AftermathRecord {
  baselinePct: number; // NET pnl % at expiry
  mfePct: number; // max favorable excursion since expiry (margin-%)
  maePct: number; // max adverse excursion since expiry (margin-%)
  tp1HitAt: number | null;
  tp2HitAt: number | null;
  tp3HitAt: number | null;
  slHitAt: number | null;
  startedAt: number; // expiry epoch ms
  watchedMinutes: number;
  endedAt: number | null;
  verdict: string | null;
  retro?: boolean; // v4.8: reconstructed for pre-v4.6 rows (no 4h watch ran — price snapshot only)
}

function blankAftermath(baselinePct: number, startedAt: number): AftermathRecord {
  return {
    baselinePct: Number(baselinePct.toFixed(2)),
    mfePct: 0,
    maePct: 0,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    slHitAt: null,
    startedAt,
    watchedMinutes: 0,
    endedAt: null,
    verdict: null,
  };
}

export function parseAftermath(json: string | null): AftermathRecord | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as AftermathRecord;
  } catch {
    return null;
  }
}

/* ── 1) TTL extension at expiry ──────────────────────────────── */

/**
 * Called the moment a signal's TTL elapses. Returns the extended window
 * (ttlMinutes, expiresAt) when the AI gate grants an extension, or null when
 * the signal should expire now. Rules (ALL must hold):
 *   · ttlExtensions === 0 (one extension max)
 *   · NET PnL at expiry > +1.0% of margin (fees included — thesis is working)
 *   · fresh flow re-assessment CONFIRMS the direction (score ≥ +5)
 * Flow unavailable ⇒ no extension (honest: cannot justify it with data).
 */
export async function maybeExtendTtl(
  s: Signal,
  price: number,
  priceMap1hPct: number
): Promise<{ ttlMinutes: number; expiresAt: Date } | null> {
  try {
    if (s.ttlExtensions >= 1) return null;

    const minutesHeld = (Date.now() - s.createdAt.getTime()) / 60_000;
    const grossPct = movePct(price, s);
    const fb = feeBreakdown({ marginUsd: s.marginUsd, leverage: s.leverage, grossPct, minutesHeld });
    if (fb.netPct <= 1.0) return null; // not clearly working — expire honestly

    const flow = await assessFlow(s.symbol, s.direction === "SHORT" ? "SHORT" : "LONG", priceMap1hPct);
    if (!flow || flow.verdict !== "CONFIRMS" || flow.score < 5) return null;

    const extMin = Math.max(15, Math.round(s.ttlMinutes * 0.5)); // +50% of the original window
    const ttlMinutes = s.ttlMinutes + extMin;
    const expiresAt = new Date(Date.now() + extMin * 60_000);

    await db.signal.update({
      where: { id: s.id },
      data: { ttlMinutes, expiresAt, ttlExtensions: s.ttlExtensions + 1 },
    });
    await logEvent(
      s.id,
      s.symbol,
      "TTL-EXTEND",
      "ai",
      `${nx(s)} TTL EXTENDED +${extMin}m (50%) — NET ${fb.netPct >= 0 ? "+" : ""}${fb.netPct.toFixed(2)}% at expiry and flow re-check CONFIRMS +${flow.score}/25; letting the runner work (one extension max)`
    );
    return { ttlMinutes, expiresAt };
  } catch {
    return null; // extension is advisory — never block resolution
  }
}

/** 1h price move for the flow re-check — 4×15m candles back. */
export async function price1hPctFor(symbol: string): Promise<number> {
  try {
    const candles = await fetchKlines(symbol, "15m", 5);
    if (!candles || candles.length < 5) return 0;
    const last = candles[candles.length - 1].close;
    const base = candles[0].close;
    return base > 0 ? ((last - base) / base) * 100 : 0;
  } catch {
    return 0;
  }
}

/* ── 2) aftermath monitor (engine tick) ──────────────────────── */

function verdictOf(st: AftermathRecord): string {
  if (st.tp3HitAt) return "RAN→TP3";
  if (st.tp2HitAt) return "CONTINUED→TP2";
  if (st.tp1HitAt) return "CONTINUED→TP1";
  if (st.slHitAt) return "REVERSED→SL";
  if (st.mfePct >= 1.5) return "DRIFTED+";
  if (st.maePct <= -1.5) return "DRIFTED−";
  return "FLAT";
}

/**
 * Advance the post-expiry watch for every EXPIRED signal still WATCHING.
 * Called once per engine tick with the live price map.
 */
export async function monitorAftermath(priceMap: Map<string, number>): Promise<void> {
  let watching: Signal[];
  try {
    watching = await db.signal.findMany({
      where: { status: "EXPIRED", aftermathStatus: "WATCHING" },
    });
  } catch {
    return;
  }
  if (watching.length === 0) return;

  const now = Date.now();
  for (const s of watching) {
    const price = priceMap.get(s.symbol);
    if (!price) continue;

    const st = parseAftermath(s.aftermathJson) ?? blankAftermath(s.pnlPercent, s.closedAt?.getTime() ?? now);
    const isLong = s.direction === "LONG";
    const post = movePct(price, s);

    st.mfePct = Math.max(st.mfePct, Number(post.toFixed(2)));
    st.maePct = Math.min(st.maePct, Number(post.toFixed(2)));

    const crossedTp1 = isLong ? price >= s.tp1 : price <= s.tp1;
    const crossedTp2 = isLong ? price >= s.tp2 : price <= s.tp2;
    const crossedTp3 = isLong ? price >= s.tp3 : price <= s.tp3;
    const crossedSl = isLong ? price <= s.stopLoss : price >= s.stopLoss;

    let announced = false;
    if (!st.tp1HitAt && crossedTp1) {
      st.tp1HitAt = now;
      announced = true;
    }
    if (!st.tp2HitAt && crossedTp2) st.tp2HitAt = now;
    if (!st.tp3HitAt && crossedTp3) st.tp3HitAt = now;
    if (!st.slHitAt && crossedSl) st.slHitAt = now;

    const elapsed = now - st.startedAt;
    st.watchedMinutes = Math.round(elapsed / 60_000);

    const done = Boolean(st.tp3HitAt || st.slHitAt) || elapsed >= AFTERMATH_WATCH_MS;

    try {
      if (done) {
        st.endedAt = now;
        st.verdict = verdictOf(st);
        await db.signal.update({
          where: { id: s.id },
          data: { aftermathStatus: "DONE", aftermathJson: JSON.stringify(st) },
        });
        const mfe = `${st.mfePct >= 0 ? "+" : ""}${st.mfePct.toFixed(1)}%`;
        const mae = `${st.maePct >= 0 ? "+" : ""}${st.maePct.toFixed(1)}%`;
        await logEvent(
          s.id,
          s.symbol,
          "AFTERMATH",
          st.tp1HitAt ? "info" : "warn",
          `${nx(s)} AFTERMATH (${s.symbol} ${s.direction}, expired ${fmtPct(st.baselinePct)}): ${st.verdict} — post-expiry watch ${st.watchedMinutes}m, TP1 ${st.tp1HitAt ? "hit" : "never"}, MFE ${mfe} / MAE ${mae} (tick-sampled). ${st.tp1HitAt ? "The setup kept working after TTL — TTL learning notes it." : "TTL cut it without follow-through — no continuation credit."}`
        );
      } else {
        await db.signal.update({
          where: { id: s.id },
          data: { aftermathJson: JSON.stringify(st) },
        });
        if (announced) {
          await logEvent(
            s.id,
            s.symbol,
            "AFTERMATH",
            "info",
            `${nx(s)} post-expiry watch: TP1 touched ${st.watchedMinutes}m after TTL (post-expiry MFE +${st.mfePct.toFixed(1)}%) — outcome feeds TTL learning`
          );
        }
      }
    } catch {
      /* advisory — next tick retries */
    }
  }

  await recomputeTtlLearning();
}

const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/* ── 2b) legacy backfill (v4.8) ─────────────────────────────────
 * EXPIRED rows created before the v4.6 aftermath system have
 * aftermathStatus = null — no strip, no dialog block, invisible tracking.
 * The 4h watch window has long passed for those, so MFE/MAE cannot be
 * reconstructed honestly. We record a RETRO snapshot instead: where price
 * stands NOW vs the original levels, flagged retro:true so the UI labels it
 * truthfully ("legacy — no 4h watch") instead of implying measured data.
 * Idempotent: only touches rows with aftermathStatus null. */
export async function backfillLegacyAftermath(): Promise<number> {
  try {
    const legacyRows = await db.signal.findMany({
      where: { status: "EXPIRED" },
    });
    const legacy = legacyRows.filter((s) => s.aftermathStatus === "NONE"); // pre-v4.6 rows carry the schema default
    if (legacy.length === 0) return 0;
    const assets = await db.marketAsset.findMany({ select: { symbol: true, price: true } });
    const priceMap = new Map(assets.map((a) => [a.symbol, a.price] as const));
    const now = Date.now();
    let n = 0;
    for (const s of legacy) {
      const price = priceMap.get(s.symbol);
      if (!price) continue;
      const isLong = s.direction === "LONG";
      const startedAt = s.closedAt?.getTime() ?? s.expiresAt?.getTime() ?? now;
      const post = movePct(price, s);
      const rec: AftermathRecord = {
        baselinePct: Number((s.pnlPercent ?? 0).toFixed(2)),
        mfePct: post > 0 ? Number(post.toFixed(2)) : 0,
        maePct: post < 0 ? Number(post.toFixed(2)) : 0,
        tp1HitAt: null,
        tp2HitAt: null,
        tp3HitAt: null,
        slHitAt: null,
        startedAt,
        watchedMinutes: 0,
        endedAt: now,
        verdict: null,
        retro: true,
      };
      // RETRO verdict from where price stands NOW vs the original levels
      const pastTp3 = isLong ? price >= s.tp3 : price <= s.tp3;
      const pastTp2 = isLong ? price >= s.tp2 : price <= s.tp2;
      const pastTp1 = isLong ? price >= s.tp1 : price <= s.tp1;
      const pastSl = isLong ? price <= s.stopLoss : price >= s.stopLoss;
      if (pastSl) rec.slHitAt = startedAt; // timestamps are unknowable — marked retro by the flag
      else if (pastTp1) rec.tp1HitAt = startedAt;
      rec.verdict = pastSl ? "RETRO·PAST-SL" : pastTp3 ? "RETRO·PAST-TP3" : pastTp2 ? "RETRO·PAST-TP2" : pastTp1 ? "RETRO·PAST-TP1" : post >= 0.5 ? "RETRO·DRIFT+" : post <= -0.5 ? "RETRO·DRIFT−" : "RETRO·FLAT";
      try {
        await db.signal.update({
          where: { id: s.id },
          data: { aftermathStatus: "DONE", aftermathJson: JSON.stringify(rec) },
        });
        n++;
      } catch {
        /* advisory */
      }
    }
    if (n > 0) {
      await logEvent(
        null,
        null,
        "ENGINE",
        "info",
        `AFTERMATH BACKFILL: ${n} legacy EXPIRED signal${n > 1 ? "s" : ""} had no post-expiry record (created before the v4.6 watch) — RETRO price snapshots recorded, clearly labelled; the 4h MFE/MAE watch itself cannot be reconstructed honestly`
      );
    }
    return n;
  } catch {
    return 0;
  }
}

/* ── 3) TTL learning (post-expiry continuation → TTL boost) ──── */

export interface TtlLearningRow {
  n: number;
  continued: number;
  rate: number; // 0..1 continuation rate
  boost: number; // TTL multiplier applied at deploy
  updatedAt: number;
}

interface StoredTtlLearning {
  version: number;
  strategies: Record<string, TtlLearningRow>;
}

const TTL_LEARNING_KEY = "ttl-learning";
let learningCache: Record<string, TtlLearningRow> | null = null;

export function boostForRate(n: number, rate: number): number {
  if (n < TTL_LEARN_MIN) return 1;
  if (rate >= 0.75) return 1.5;
  if (rate >= 0.6) return 1.25;
  if (rate <= 0.25) return 0.8;
  return 1;
}

/**
 * Recompute per-strategy continuation stats from all DONE aftermath records.
 * Cheap enough to run after every monitor pass; fires an audit event only
 * when a strategy's boost actually changes.
 */
async function recomputeTtlLearning(): Promise<void> {
  try {
    const done = await db.signal.findMany({
      where: { status: "EXPIRED", aftermathStatus: "DONE" },
      select: { strategy: true, aftermathJson: true },
    });
    const acc = new Map<string, { n: number; continued: number }>();
    for (const r of done) {
      const st = parseAftermath(r.aftermathJson);
      if (!st) continue;
      const e = acc.get(r.strategy) ?? { n: 0, continued: 0 };
      e.n += 1;
      if (st.tp1HitAt) e.continued += 1;
      acc.set(r.strategy, e);
    }

    const storedRow = await db.engineSetting.findUnique({ where: { key: TTL_LEARNING_KEY } });
    const prev: Record<string, TtlLearningRow> = storedRow
      ? ((JSON.parse(storedRow.value) as StoredTtlLearning).strategies ?? {})
      : {};

    const next: Record<string, TtlLearningRow> = {};
    for (const [strategy, e] of acc) {
      const rate = e.n > 0 ? e.continued / e.n : 0;
      const boost = boostForRate(e.n, rate);
      next[strategy] = {
        n: e.n,
        continued: e.continued,
        rate: Math.round(rate * 100) / 100,
        boost,
        updatedAt: Date.now(),
      };
      const before = prev[strategy];
      if (before && before.boost !== boost) {
        await logEvent(
          null,
          null,
          "ENGINE",
          "ai",
          `TTL LEARNING: ${strategy} post-expiry continuation ${e.continued}/${e.n} (${Math.round(rate * 100)}%) — TTL window ${boost === 1 ? "back to ×1.00 baseline" : `×${before.boost.toFixed(2)} → ×${boost.toFixed(2)}`} for next deployments`
        );
      } else if (!before && boost !== 1 && e.n >= TTL_LEARN_MIN) {
        await logEvent(
          null,
          null,
          "ENGINE",
          "ai",
          `TTL LEARNING: ${strategy} post-expiry continuation ${e.continued}/${e.n} (${Math.round(rate * 100)}%) — TTL window ×${boost.toFixed(2)} for next deployments`
        );
      }
    }

    // keep strategies that no longer have DONE rows out of the payload
    if (storedRow) {
      await db.engineSetting.update({
        where: { key: TTL_LEARNING_KEY },
        data: { value: JSON.stringify({ version: 1, strategies: next } satisfies StoredTtlLearning) },
      });
    } else {
      await db.engineSetting.create({
        data: { key: TTL_LEARNING_KEY, value: JSON.stringify({ version: 1, strategies: next } satisfies StoredTtlLearning) },
      });
    }
    learningCache = next;
  } catch {
    /* advisory */
  }
}

/** TTL multiplier for a strategy (1.0 = baseline). Cached in-process. */
export async function getTtlBoost(strategy: string): Promise<number> {
  if (!learningCache) {
    try {
      const row = await db.engineSetting.findUnique({ where: { key: TTL_LEARNING_KEY } });
      learningCache = row ? ((JSON.parse(row.value) as StoredTtlLearning).strategies ?? {}) : {};
    } catch {
      return 1;
    }
  }
  return learningCache[strategy]?.boost ?? 1;
}

/** Learning snapshot for the API/UI (fresh read, cheap). */
export async function getTtlLearning(): Promise<Record<string, TtlLearningRow>> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: TTL_LEARNING_KEY } });
    return row ? ((JSON.parse(row.value) as StoredTtlLearning).strategies ?? {}) : {};
  } catch {
    return {};
  }
}
