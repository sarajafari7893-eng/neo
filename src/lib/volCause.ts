// ── FlowRadar Neo VOL-CAUSE forensics (server-only) ────────────────────────
// Operator request 2026-09-07: «با تحقیق و جستجوی عمیق دلایل شکل گیری
// Top volatility در MARKET MATRIX رو یاد بگیر و در سیستم برای ردیابی و
// یادگیری و استفاده پیاده کن» — WHY do the top-|Δ24h| movers (the MARKET
// MATRIX "Top volatility" board) actually move?
//
// RESEARCH BASIS (web research round 2026-09-07, distilled):
//   1. WHALE-PUSH       — large players accumulate quietly (OI rises) then hit
//                         the tape aggressively (taker CVD aligned with the
//                         move); footprint = OI Δ↑ + CVD↑ same sign as move.
//   2. LIQUIDATION CASCADE — one forced closure pushes price enough to trigger
//                         the next; visible as a burst of liquidation notional
//                         on the side that is being flushed.
//   3. FUNDING-SQUEEZE  — extreme funding marks crowded leverage; the crowded
//                         side becomes cascade fuel when price moves against it.
//   4. OI-SURGE         — OI surges backing a move = NEW positions, not
//                         day-trading noise → continuation fuel (per OI research).
//   5. UNWIND           — OI dropping hard while price moves = deleveraging,
//                         trend fuel draining.
//   6. CROWD-FLUSH      — retail crowd positioned heavily one way gets flushed
//                         (contrarian crowd input, already measured per symbol).
//   7. VOL-ONSET        — our own measured 15m eruption bar (leading, in-system).
//   8. THIN-TAPE        — small open-interest book: modest flow produces
//                         outsized |Δ24h| (weekend/off-hours amplifies).
//   9. SESSION-THIN     — liquidity drains in off-session hours / weekends.
//
// PIPELINE: capture (top-|Δ24h| entries, 6h dedupe) → attribute (transparent
// rule weights) → settle (real fwd 2h/6h returns from futures klines) →
// learn (per-cause expectancy + continuation rate → EngineSetting
// "volcause.study") → use (engine reads volCauseBoost at deploy; learned
// continuation profiles nudge conviction/sizing ONLY after n ≥ 30 ·
// cont ≥ 55% · |mean fwd6h| ≥ 0.12% — otherwise telemetry-only, vote 0).

import { db } from "@/lib/db";
import { fetchFlowMetrics } from "@/lib/flow";
import { liquidationPressure } from "@/lib/liquidations";
import { getOnsetBoard } from "@/lib/volOnset";
import { fetchFuturesKlines, type Candle } from "@/lib/market-feed";

// ── taxonomy ────────────────────────────────────────────────────────────────
export const VOL_CAUSES = [
  "WHALE-PUSH",
  "LIQ-CASCADE",
  "FUNDING-SQUEEZE",
  "OI-SURGE",
  "UNWIND",
  "CROWD-FLUSH",
  "VOL-ONSET",
  "THIN-TAPE",
  "SESSION-THIN",
  "MOMENTUM-CARRY",
  "MIXED",
] as const;
export type VolCause = (typeof VOL_CAUSES)[number];

export interface CauseAttribution {
  cause: VolCause;
  weight: number; // normalized 0-100 share of the explanation
  note: string;
}

interface FactorSnapshot {
  symbol: string;
  change24h: number;
  price: number;
  oiDelta10m: number | null;
  oiDelta1h: number | null;
  oiValueUsd: number | null;
  cvdPct: number | null;
  takerRatio: number | null;
  crowdLS: number | null;
  funding8h: number | null;
  liqUsd1h: number | null;
  liqDominant: "LONGS" | "SHORTS" | null;
  onsetScore: number | null;
  hourUtc: number;
  session: "ASIA" | "EUROPE" | "US" | "WEEKEND";
}

// ── session classification (UTC) ────────────────────────────────────────────
export function sessionOf(d: Date): FactorSnapshot["session"] {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return "WEEKEND";
  const h = d.getUTCHours();
  if (h >= 13 && h < 21) return "US";
  if (h >= 7 && h < 13) return "EUROPE";
  return "ASIA";
}

// ── attribution: transparent rule weights (research-derived) ────────────────
function attributeCauses(f: FactorSnapshot): { causes: CauseAttribution[]; primary: VolCause } {
  const up = f.change24h >= 0;
  const dirSign = up ? 1 : -1;
  const raw: Array<{ cause: VolCause; w: number; note: string }> = [];

  // 1) WHALE-PUSH — OI rising while aggressive takers push the same way
  const oi = f.oiDelta1h;
  const cvd = f.cvdPct;
  if (oi !== null && cvd !== null && oi >= 1.5 && Math.abs(cvd) >= 2 && Math.sign(cvd) === dirSign) {
    const w = 26 + Math.min(18, oi * 4 + (Math.abs(cvd) - 2) * 2);
    raw.push({
      cause: "WHALE-PUSH",
      w,
      note: `OI +${oi.toFixed(1)}%/1h with taker CVD ${cvd >= 0 ? "+" : ""}${cvd.toFixed(1)}% flowing ${up ? "into" : "against"} the move — large-player accumulation footprint`,
    });
  }
  // 2) OI-SURGE — fresh positions backing the move (continuation fuel)
  if (oi !== null && oi >= 3) {
    raw.push({
      cause: "OI-SURGE",
      w: 12 + Math.min(14, (oi - 3) * 2.5),
      note: `open interest surged +${oi.toFixed(1)}%/1h — new positions, not noise, backing the move`,
    });
  }
  // 3) UNWIND — deleveraging: OI draining while price moves
  if (oi !== null && oi <= -2) {
    raw.push({
      cause: "UNWIND",
      w: 14 + Math.min(14, Math.abs(oi) * 2.5),
      note: `open interest unwinding ${oi.toFixed(1)}%/1h — forced de-risking driving the tape, fuel draining`,
    });
  }
  // 4) LIQ-CASCADE — liquidation burst on the flushed side
  if (f.liqUsd1h !== null && f.liqUsd1h >= 200_000) {
    const flushed = f.liqDominant ?? (up ? "SHORTS" : "LONGS");
    const aligned = (up && flushed === "SHORTS") || (!up && flushed === "LONGS");
    raw.push({
      cause: "LIQ-CASCADE",
      w: (16 + Math.min(20, f.liqUsd1h / 50_000)) * (aligned ? 1 : 0.5),
      note: `$${Math.round(f.liqUsd1h / 1000)}k liquidated/10m window, ${flushed === "LONGS" ? "longs" : "shorts"} flushed — cascade mechanics in play`,
    });
  }
  // 5) FUNDING-SQUEEZE — crowded leverage as cascade fuel
  if (f.funding8h !== null && Math.abs(f.funding8h) >= 0.0005) {
    const crowded = f.funding8h > 0 ? "LONGS" : "SHORTS";
    // the crowded side becomes fuel when the move runs AGAINST it
    const isFuel = (!up && crowded === "LONGS") || (up && crowded === "SHORTS");
    raw.push({
      cause: "FUNDING-SQUEEZE",
      w: (10 + Math.min(14, (Math.abs(f.funding8h) - 0.0005) * 12_000)) * (isFuel ? 1 : 0.6),
      note: `funding ${(f.funding8h * 100).toFixed(3)}%/8h — ${crowded === "LONGS" ? "longs" : "shorts"} pay to stay crowded; ${isFuel ? "they are the squeeze fuel here" : "crowd aligned with the move (momentum carry)"}`,
    });
  }
  // 6) CROWD-FLUSH — retail crowd on the wrong side
  if (f.crowdLS !== null && ((!up && f.crowdLS >= 2) || (up && f.crowdLS <= 0.8))) {
    raw.push({
      cause: "CROWD-FLUSH",
      w: 12,
      note: `retail crowd ${f.crowdLS >= 1 ? "long-biased" : "short-biased"} (L/S ${f.crowdLS.toFixed(2)}) caught on the wrong side — flush fuel`,
    });
  }
  // 7) VOL-ONSET — our measured eruption bar
  if (f.onsetScore !== null && f.onsetScore >= 30) {
    raw.push({
      cause: "VOL-ONSET",
      w: 10 + Math.min(16, f.onsetScore * 0.2),
      note: `15m eruption bar on the radar (onset score ${f.onsetScore}/100) — measured displacement onset`,
    });
  }
  // 8) THIN-TAPE — small book amplifies flow
  if (f.oiValueUsd !== null && f.oiValueUsd < 30_000_000) {
    raw.push({ cause: "THIN-TAPE", w: 10, note: `open interest only $${(f.oiValueUsd / 1e6).toFixed(1)}M — a thin book amplifies every order` });
  }
  // 9) SESSION-THIN — off-hours / weekend liquidity
  if (f.session === "WEEKEND" || f.hourUtc >= 21 || f.hourUtc < 5) {
    raw.push({ cause: "SESSION-THIN", w: 6, note: f.session === "WEEKEND" ? "weekend liquidity drain amplifies moves" : `thin ${f.session === "ASIA" ? "pre-Asia" : "late-US"} hours (${String(f.hourUtc).padStart(2, "0")}:00 UTC)` });
  }
  // fallback
  if (raw.length === 0) {
    raw.push({ cause: "MOMENTUM-CARRY", w: 20, note: "no single dominant footprint — directional drift carried by steady flow" });
  }

  const total = raw.reduce((a, r) => a + r.w, 0);
  const causes: CauseAttribution[] = raw
    .sort((a, b) => b.w - a.w)
    .slice(0, 4)
    .map((r) => ({ cause: r.cause, weight: Math.round((r.w / total) * 100), note: r.note }));
  const top = causes[0]!;
  return { causes, primary: top.weight >= 18 ? top.cause : "MIXED" };
}

// ── capture: top-|Δ24h| entries (the MARKET MATRIX board), 6h dedupe ───────
const CAPTURE_TOP_N = 4;
const CAPTURE_THROTTLE_MS = 180_000; // 3min
const DEDUPE_WINDOW_MS = 6 * 3600_000;
const MIN_ABS_RET = 3.5; // |Δ24h| must clear this to be "top volatility" material
let lastCaptureAt = 0;
let captureRunning = false;

export async function captureTopVolCauses(): Promise<number> {
  if (captureRunning || Date.now() - lastCaptureAt < CAPTURE_THROTTLE_MS) return 0;
  captureRunning = true;
  lastCaptureAt = Date.now();
  try {
    const assets = await db.marketAsset.findMany({
      orderBy: { volume24h: "desc" },
      take: 60,
      select: { symbol: true, price: true, change24h: true },
    });
    const ranked = assets
      .filter((a) => Math.abs(a.change24h) >= MIN_ABS_RET)
      .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
      .slice(0, CAPTURE_TOP_N);
    if (ranked.length === 0) return 0;

    const since = new Date(Date.now() - DEDUPE_WINDOW_MS);
    const recent = await db.volCauseEvent.findMany({
      where: { detectedAt: { gte: since }, symbol: { in: ranked.map((r) => r.symbol) } },
      select: { symbol: true, direction: true },
    });
    // v12.11 — DIRECTION-AWARE dedupe (IRYS forensics): the old per-symbol 6h
    // key meant a captured +565% pump BLACKED OUT the following −77.4% collapse
    // (zero DOWN events for 6h). Dedupe is now (symbol, direction) — an UP
    // regime and a DOWN regime are separate events; rank-0 tick-plane rows
    // (TICK-ONSET) participate equally so the slow plane doesn't duplicate them.
    const recentSet = new Set(recent.map((r) => `${r.symbol}|${r.direction}`));
    const todo = ranked.filter((r) => !recentSet.has(`${r.symbol}|${r.change24h >= 0 ? "UP" : "DOWN"}`));
    if (todo.length === 0) return 0;

    // onset radar is cached (90s) — read once
    const onset = await getOnsetBoard().catch(() => null);
    const onsetMap = new Map((onset?.rows ?? []).map((r) => [r.symbol, r.score]));

    let created = 0;
    const now = new Date();
    for (const a of todo) {
      const [flow, liq] = await Promise.all([
        fetchFlowMetrics(a.symbol).catch(() => null),
        liquidationPressure(a.symbol).catch(() => null),
      ]);
      const liqUsd1h = liq ? liq.usd10m * 6 : null; // scale the 10m window to an hour-equivalent (honest: measured 10m × 6)
      const liqDominant = liq ? (liq.longsUsd10m >= liq.shortsUsd10m ? "LONGS" : "SHORTS") : null;
      const snap: FactorSnapshot = {
        symbol: a.symbol,
        change24h: a.change24h,
        price: a.price,
        oiDelta10m: flow?.oiDelta10m ?? null,
        oiDelta1h: flow?.oiDelta1h ?? null,
        oiValueUsd: flow?.oiValueUsd ?? null,
        cvdPct: flow?.cvdNetPctOfVol ?? null,
        takerRatio: flow?.takerRatio ?? null,
        crowdLS: flow?.crowdLongShort ?? null,
        funding8h: flow?.funding8h ?? null,
        liqUsd1h,
        liqDominant,
        onsetScore: onsetMap.get(a.symbol) ?? null,
        hourUtc: now.getUTCHours(),
        session: sessionOf(now),
      };
      const { causes, primary } = attributeCauses(snap);
      await db.volCauseEvent.create({
        data: {
          symbol: a.symbol,
          detectedAt: now,
          rank: ranked.indexOf(a) + 1,
          direction: a.change24h >= 0 ? "UP" : "DOWN",
          change24h: a.change24h,
          price: a.price,
          oiDelta10m: snap.oiDelta10m,
          oiDelta1h: snap.oiDelta1h,
          oiValueUsd: snap.oiValueUsd,
          cvdPct: snap.cvdPct,
          takerRatio: snap.takerRatio,
          crowdLS: snap.crowdLS,
          funding8h: snap.funding8h,
          liqUsd1h: snap.liqUsd1h,
          onsetScore: snap.onsetScore,
          hourUtc: snap.hourUtc,
          session: snap.session,
          causesJson: JSON.stringify(causes),
          primaryCause: primary,
        },
      });
      created++;
    }
    return created;
  } catch {
    return 0; // telemetry — never throws
  } finally {
    captureRunning = false;
  }
}

// ── settle: real forward returns from futures klines ────────────────────────
const SETTLE_LOOKBACK_CANDLES = 14; // 1h candles → covers 14h

function priceAt(candles: Candle[], tMs: number): number | null {
  const c = candles.find((k) => k.openTime <= tMs && k.openTime + 3600_000 > tMs);
  return c ? c.close : null;
}

let lastSettleAt = 0;
let settleRunning = false;

export async function settlePendingVolCauses(): Promise<number> {
  if (settleRunning || Date.now() - lastSettleAt < 120_000) return 0;
  settleRunning = true;
  lastSettleAt = Date.now();
  try {
    const pending = await db.volCauseEvent.findMany({
      where: { settledAt: null, detectedAt: { lt: new Date(Date.now() - 2 * 3600_000) } },
      orderBy: { detectedAt: "asc" },
      take: 12,
    });
    let n = 0;
    for (const ev of pending) {
      let candles: Candle[] | null = null;
      try {
        candles = await fetchFuturesKlines(ev.symbol, "1h", SETTLE_LOOKBACK_CANDLES);
      } catch {
        continue; // keep pending — retry next round
      }
      if (!candles || candles.length === 0) continue;
      const t0 = ev.detectedAt.getTime();
      const p2 = priceAt(candles, t0 + 2 * 3600_000);
      const p6 = priceAt(candles, t0 + 6 * 3600_000);
      const ageOk = Date.now() - t0 >= 13 * 3600_000; // beyond kline window → settle with what we have
      if (p6 === null && !ageOk) continue;
      const base = ev.price;
      const data: { fwd2hPct?: number; fwd6hPct?: number; settledAt?: Date } = { settledAt: new Date() };
      if (p2 !== null) data.fwd2hPct = Number((((p2 - base) / base) * 100).toFixed(3));
      if (p6 !== null) data.fwd6hPct = Number((((p6 - base) / base) * 100).toFixed(3));
      await db.volCauseEvent.update({ where: { id: ev.id }, data });
      n++;
    }
    return n;
  } catch {
    return 0;
  } finally {
    settleRunning = false;
  }
}

// ── learn: per-cause expectancy + continuation rate → EngineSetting ─────────
export interface CauseStudy {
  cause: VolCause;
  n: number;
  meanFwd2h: number | null;
  meanFwd6h: number | null;
  continuationRatePct: number | null; // % of settled events where fwd6h extended in the event's own direction
  learnedAllowed: boolean; // n ≥ 30 · cont ≥ 55% · |mean fwd6h| ≥ 0.12
}

export interface VolCauseStudy {
  at: number;
  settled: number;
  causes: CauseStudy[];
  verdict: string;
}

const STUDY_KEY = "volcause.study";
let studyCache: { at: number; study: VolCauseStudy | null } | null = null;
const STUDY_CACHE_TTL = 300_000;

export const LEARN_GATE = { minN: 30, minContPct: 55, minAbsFwd: 0.12 };

export async function learnVolCauses(force = false): Promise<VolCauseStudy | null> {
  if (!force && studyCache && Date.now() - studyCache.at < STUDY_CACHE_TTL) return studyCache.study;
  try {
    const settled = await db.volCauseEvent.findMany({
      where: { fwd6hPct: { not: null } },
      select: { causesJson: true, primaryCause: true, direction: true, fwd2hPct: true, fwd6hPct: true },
    });
    const byCause = new Map<VolCause, { n: number; s2: number; s6: number; cont: number }>();
    const add = (cause: VolCause, f2: number | null, f6: number, cont: boolean) => {
      const e = byCause.get(cause) ?? { n: 0, s2: 0, s6: 0, cont: 0 };
      e.n++;
      e.s2 += f2 ?? 0;
      e.s6 += f6;
      if (cont) e.cont++;
      byCause.set(cause, e);
    };
    for (const ev of settled) {
      const f6 = ev.fwd6hPct ?? 0;
      const cont = ev.direction === "UP" ? f6 > 0 : f6 < 0;
      add(ev.primaryCause as VolCause, ev.fwd2hPct, f6, cont);
      // also credit attributed causes with meaningful weight
      try {
        const causes = JSON.parse(ev.causesJson) as CauseAttribution[];
        for (const c of causes) {
          if (c.cause !== ev.primaryCause && c.weight >= 15) add(c.cause as VolCause, ev.fwd2hPct, f6, cont);
        }
      } catch {
        /* single bad row must not kill the study */
      }
    }
    const causes: CauseStudy[] = [...byCause.entries()]
      .map(([cause, e]) => {
        const meanFwd6h = Number((e.s6 / e.n).toFixed(3));
        return {
          cause,
          n: e.n,
          meanFwd2h: e.n > 0 ? Number((e.s2 / e.n).toFixed(3)) : null,
          meanFwd6h,
          continuationRatePct: Math.round((e.cont / e.n) * 100),
          learnedAllowed: e.n >= LEARN_GATE.minN && (e.cont / e.n) * 100 >= LEARN_GATE.minContPct && Math.abs(meanFwd6h) >= LEARN_GATE.minAbsFwd,
        };
      })
      .sort((a, b) => b.n - a.n);
    const allowed = causes.filter((c) => c.learnedAllowed);
    const study: VolCauseStudy = {
      at: Date.now(),
      settled: settled.length,
      causes,
      verdict:
        settled.length === 0
          ? "NO SETTLED EVENTS YET — the loop settles each capture with real 2h/6h forward returns"
          : allowed.length > 0
            ? `LEARNED CONTINUATION PROFILES ACTIVE: ${allowed.map((c) => `${c.cause} (n=${c.n}, cont ${c.continuationRatePct}%)`).join(", ")} — engine may nudge conviction/sizing on fresh matching events`
            : `TELEMETRY-ONLY — no cause has cleared the learned gate (n ≥ ${LEARN_GATE.minN} · cont ≥ ${LEARN_GATE.minContPct}% · |fwd6h| ≥ ${LEARN_GATE.minAbsFwd}%)`,
    };
    await db.engineSetting.upsert({
      where: { key: STUDY_KEY },
      create: { key: STUDY_KEY, value: JSON.stringify(study) },
      update: { value: JSON.stringify(study) },
    });
    studyCache = { at: Date.now(), study };
    return study;
  } catch {
    return studyCache?.study ?? null;
  }
}

async function loadStudy(): Promise<VolCauseStudy | null> {
  if (studyCache && Date.now() - studyCache.at < STUDY_CACHE_TTL) return studyCache.study;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: STUDY_KEY } });
    if (!row) return null;
    const study = JSON.parse(row.value) as VolCauseStudy;
    studyCache = { at: Date.now(), study };
    return study;
  } catch {
    return null;
  }
}

// ── use: engine hook — learned continuation profile → small boost ──────────
export interface VolCauseBoost {
  boost: number; // conviction/sizing points (0 = telemetry only)
  cause: VolCause | null;
  basis: string;
  detail: string | null;
}

export async function volCauseBoost(symbol: string, direction: "LONG" | "SHORT"): Promise<VolCauseBoost> {
  try {
    const ev = await db.volCauseEvent.findFirst({
      where: { symbol, detectedAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) } },
      orderBy: { detectedAt: "desc" },
    });
    if (!ev) return { boost: 0, cause: null, basis: "NO-RECENT-EVENT", detail: null };
    const study = await loadStudy();
    const attr = (JSON.parse(ev.causesJson) as CauseAttribution[]).filter((c) => c.weight >= 25).map((c) => c.cause as VolCause);
    const candidates = [ev.primaryCause as VolCause, ...attr].filter((c, i, arr) => arr.indexOf(c) === i);
    const eventDir = ev.direction === "UP" ? "LONG" : "SHORT";
    for (const cause of candidates) {
      const cs = study?.causes.find((c) => c.cause === cause);
      if (cs?.learnedAllowed && direction === eventDir) {
        const boost = Math.max(2, Math.min(4, Math.round(Math.abs(cs.meanFwd6h ?? 0) * 10)));
        return {
          boost,
          cause,
          basis: "LEARNED-CONTINUATION",
          detail: `${cause} continuation profile n=${cs.n} · mean fwd6h ${cs.meanFwd6h !== null ? `${cs.meanFwd6h >= 0 ? "+" : ""}${cs.meanFwd6h}%` : "—"} · cont ${cs.continuationRatePct}%`,
        };
      }
    }
    return {
      boost: 0,
      cause: (candidates[0] ?? null) as VolCause | null,
      basis: "TELEMETRY-ONLY",
      detail: `recent top-vol event (${candidates[0] ?? "MIXED"}) — learned gate not cleared for this profile yet`,
    };
  } catch {
    return { boost: 0, cause: null, basis: "UNAVAILABLE", detail: null };
  }
}

// ── board for the API/UI ────────────────────────────────────────────────────
export async function getVolCauseBoard() {
  const [events, total, unsettled, study] = await Promise.all([
    db.volCauseEvent.findMany({ orderBy: { detectedAt: "desc" }, take: 24 }),
    db.volCauseEvent.count(),
    db.volCauseEvent.count({ where: { settledAt: null } }),
    loadStudy(),
  ]);
  return {
    computedAt: Date.now(),
    rules: {
      capture: `top-${CAPTURE_TOP_N} of MARKET MATRIX (|Δ24h| ≥ ${MIN_ABS_RET}%), 6h dedupe per symbol`,
      settle: "real fwd 2h/6h returns from 1h futures klines",
      learnGate: `n ≥ ${LEARN_GATE.minN} · continuation ≥ ${LEARN_GATE.minContPct}% · |mean fwd6h| ≥ ${LEARN_GATE.minAbsFwd}%`,
      engineUse: "learned profiles nudge conviction (+2..4) and sizing (×1.15) at deploy; otherwise telemetry-only vote 0",
    },
    totals: { total, unsettled },
    study,
    events: events.map((e) => ({
      id: e.id,
      symbol: e.symbol,
      detectedAt: e.detectedAt.toISOString(),
      rank: e.rank,
      direction: e.direction,
      change24h: e.change24h,
      price: e.price,
      oiDelta10m: e.oiDelta10m,
      oiDelta1h: e.oiDelta1h,
      cvdPct: e.cvdPct,
      crowdLS: e.crowdLS,
      funding8h: e.funding8h,
      liqUsd1h: e.liqUsd1h,
      onsetScore: e.onsetScore,
      session: e.session,
      causes: JSON.parse(e.causesJson || "[]") as CauseAttribution[],
      primaryCause: e.primaryCause,
      fwd2hPct: e.fwd2hPct,
      fwd6hPct: e.fwd6hPct,
      settled: e.settledAt !== null,
    })),
  };
}
export type VolCauseBoardDTO = Awaited<ReturnType<typeof getVolCauseBoard>>;
