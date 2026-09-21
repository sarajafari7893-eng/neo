// ── NEXUS//SIGNALS Engine v8.4 "R-PACKAGE — AUDIT CORRECTIVE ACTIONS R1–R7" (server-only) ──
// Real Binance tickers + 4-exchange consensus median · indicator confluence + order-flow
// double gate · memory gate (realized outcomes) · learned gate (backtest learner v4.8)
// · fee-aware NET accounting · EXPIRED afterlife tracking · serial identities (NX-xxxx)
// · factor-weight calibration hook · DYNAMIC flow-ranked universe (operator-tunable
//   scan domain — v5.1: tracked perps follow real market flows, not a fixed list).
// v8.4 (module-performance audit 2026-09-11, operator mandate «برنامه ۷ اقدام اصلاحی
//   را کامل و مهندسی انجام بده»): R1 SHORT-GUARD veto · R2 definitive BE @+1.5% price
//   + early time-exit · R3 calibration FROZEN at epoch-2 recalibration · R4 flow
//   VETO-ONLY (no positive scoring) · R5 research-shadow A/B ladder journal ·
//   R6 weight-freeze until epoch-2 n≥100 · R7 adverse/stalled early exit before SL.
// v10.15 (SUPERVISOR proposal 2026-09-19T10:54Z, operator APPROVE msg 861802422
//   «تایید پیشنهادهای سوپروایزر کامل و مهندسی انجام بده»): DISLOCATION-GATE —
//   cross-exchange venue-dislocation admission gate on the existing 4-venue
//   consensus telemetry; rolling-5-scan median ≥ skipBps (150) skips, ≥ warnBps
//   (50) admits at HALF margin tagged DISLOCATION-HALF; operator knobs
//   dislocationGate/dislocationWarnBps/dislocationSkipBps (clamped, audited).
// v10.16 (deep-audit 3-a fixes, task 4-c — operator APPROVE «اجرا بندهای 1 تا 8 +
//   یافته‌های P0 و P1 کامل و مهندسی»):
//   (1) P0-2 SETTLEMENT STALENESS GATE — resolveSignals/trackAfterlife refuse
//       any symbol whose current price is missing, sim-sourced, or >120s since
//       the last live tick; no SL/TP/BE/expiry decision is ever minted from
//       random-walk sim prices (rate-limited SETTLEMENT STALLED events).
//   (2) P1 FUTURES PRICE UNIFICATION — tickers primary = Binance USDT-M
//       /fapi/v1 (spot only overlays spot-only listings), klines perp-first
//       with per-symbol spot fallback, 4-venue consensus quotes real perps
//       (Binance futures batch, OKX SWAP, Bybit linear) + 90s venue health.
//   (3) P1 EVENT RETENTION + ARCHIVE — SignalEvent cap 20k → 80k (30d kept);
//       pruned rows are mirrored to .data/signal-events-archive.jsonl
//       (8MB rotation, archival never blocks pruning).
//   (4) P1 SERIAL RACE — nextSerial read-increment-write is serialized by a
//       promise-chain mutex on globalThis (shared across HMR bundles) with the
//       new UNIQUE(serial) DB backstop + one P2002 retry on fresh MAX(serial).
//   (5) P1 PUMP-LEAK — the radar tape ignores sim-source prices and tracks
//       clock-expire (EXPIRED) instead of freezing forever when their symbol
//       leaves the universe or the feed degrades (GENIUSUSDT-class heal).
// Invoked via /api/pulse (throttled).

import { db } from "@/lib/db";
import type { Signal, MarketAsset } from "@prisma/client";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"; // v10.16 — event archive sidecar
import { fetchTickers, fetchKlines, fetchFuturesUniverse, fetchFuturesSymbols, fetchFuturesPoolStats, getFeedStatus } from "@/lib/market-feed";
import { sweepConsensus } from "@/lib/multi-exchange";
import { buildSnapshot, scoreConfluence, type FactorWeights } from "@/lib/indicators";
import { fetchFlowMetrics, scoreFlow, getFlowStatus, ensureFlow, detectLiquiditySweep } from "@/lib/flow";
import { getLiquidationStatus } from "@/lib/liquidations";
import { getGateSettings, describeGate } from "@/lib/gate-settings";
import { getEffectiveWeights, refreshCalibration } from "@/lib/calibration";
import { learnedGateAllows, maybeAutoLearner } from "@/lib/backtest";
import { pumpTick } from "@/lib/pump-dump"; // v9.0 PUMP/DUMP RADAR (operator mandate 2026-09-12)
import { maybeRawCalDeploy } from "@/lib/raw-cal"; // v9.1 RAW-CAL capture mode (operator mandate 2026-09-13)
import { recordRawcalSnapshot, checkRawcalMilestones, checkRawcalStallAlarm } from "@/lib/rawcal-telemetry"; // v9.2 RAW-CAL pace monitor (operator mandate: rhythm + book-growth watching)
import { recordRawcalQuality } from "@/lib/rawcal-quality"; // v9.3 RAW-CAL sample quality lab — R6 data-health gate (operator mandate: healthy calibration data)
import { computePumpPerformance, persistPumpPerformance } from "@/lib/pump-performance"; // v9.1 radar performance → AI journal
// v6.2.1 (architecture review P1): the three heavy LLM agents (governor /
// supervisor / deep-learn) are DYNAMIC imports — their modules (and the AI
// bridge they pull in) no longer sit on the engine boot path. Cost only gets
// paid when the scheduler actually fires one of them; boot heap shrinks.
import { getRegimeCached, regimeRuling, btcSpilloverThrAdj, regimeTagOf, bumpRegimeTelemetry, peekRegime } from "@/lib/regime";
import { runTriggerCycle, canTriggerSpawn, markTriggerSpawn, isCounterCascadeSuppressed, isCrowdCut, getTriggerBusSummary } from "@/lib/triggers";
import { feeBreakdown, confidenceMargin, ACCOUNT_START_USD, LADDER_TRANCHES, ladderWeightedMove } from "@/lib/accounting";
import { evaluateTtlExtension, bumpTtlTelemetry, type TtlDecision } from "@/lib/ttl-gate";
import { lessonThrAdj } from "@/lib/lesson-gate";
import { relaySignalEvent, relayArmed, ensureAutoDiscover, sendDirect } from "@/lib/notify";
import { onsetTagFor } from "@/lib/volOnset";
import { volCauseBoost } from "@/lib/volCause";
import { peekSymbolFlow, maybeFlowScan, flowShiftTracking, type MtfRollup } from "@/lib/flow-scanner";
// v8.1 P1/P2 (operator mandate «P1 و P2 رو کامل اجرا کن»): OI/funding board,
// liquidation heatmap, volatility forecast and the risk overlay — all bounded
// modules with zero new network dependencies on the hot path.
import { maybeOiFundScan, getOiFundBoard } from "@/lib/oi-funding";
import { getLiqHeat, peekLiqHeat } from "@/lib/liq-heatmap";
// v8.1 P2 — the parallel webDevReview loop and this session CONVERGED on a
// single surface (vol-forecast.ts: getVolForecast/peekVolForecast/volGeometry/
// getVolBoard with the self-percentile EWMA/HAR row; risk-overlay.ts:
// getRiskState(symbol?, direction?) with union-merge clusters + join test).
// Both are bounded, self-percentile, closed-bars-only modules — integrated here.
import { getVolBoard, peekVolForecast, volGeometry } from "@/lib/vol-forecast";
import { getRiskState } from "@/lib/risk-overlay";
// v8.2 VERDICT-CORE (operator: «موتور گیج») — the central-core learning layer
// that studies the gate-journal ledger (capture lives in lib/gate-journal.ts).
import { maybeAutoVerdictLearn } from "@/lib/verdict";
// v8.2 GATE GAUGE (operator mandate): every threshold verdict, hard gate block
// and deployment is journaled with its FULL reason payload — the live gauge
// and the central AI core both study this ledger. Fire-and-forget, no SQLite.
import { recordGateSamples, recordGateBlock, recordGateDeploy, type GateSample, type ThrBreakdown } from "@/lib/gate-journal";
// v8.2 SHADOW-VETO (AI-core Phase 0, operator: «قدم بعدی پیشنهادی رو کامل و مهندسی
// انجام بده»): tiered-authority second opinion at the gate fence — shadow
// adjudication + would-have-won paper ledger + Wilson-LB A/B evidence.
// Fail-open everywhere; veto power only unlocks in evidence-gated mode=veto.
import { offerFenceAdjudication, shadowVetoDeployGate, shadowVetoObserve, linkRealDeploy, shadowPaperSweep, shadowPaperCount, closeRealOutcomes, retroLinkRealDeploys, maybeAutoPromote } from "@/lib/shadow-veto";
import { strategyWeightFor } from "@/lib/strategy-weights"; // v10.6 per-strategy sizing
import { probationFactorFor, probationEffMinBonus, probationStrategies } from "@/lib/strategy-probation"; // v10.11 STRAT-PROBATION (operator APPROVE 2026-09-17)
import { captureSvTelemetry } from "@/lib/sv-telemetry"; // v10.2 — arm feed wiring + JSON persistence (self-throttled, fail-open)
import { nearMissCaptureBarrier, nearMissCaptureGate, nearMissCaptureScore, nearMissSweep, nearMissOpenCount } from "@/lib/near-miss"; // v10.13 NEAR-MISS EVIDENCE PROGRAM (operator APPROVE 2026-09-18T18:58Z msg 861802415) + v10.14 GATE tier (operator APPROVE 2026-09-19T08:56Z msg 861802419) — paper-only, zero live risk
import { realizedVolPctile, adaptiveBarrierCap } from "@/lib/vol-percentile"; // v10.14 REGIME-ADAPTIVE BARRIER CAP (SUPERVISOR proposal 2026-09-19T06:51Z, operator APPROVE 2026-09-19T08:56Z msg 861802419)
import { buildResearchLadder, journalResearchShadowDeploy, settleResearchShadow } from "@/lib/research-shadow"; // v8.4 R5

// v10.16 — engine identity bumped with the deep-audit fix package (P0-2 gate,
// futures unification, event retention/archive, serial race, pump leak).
const ENGINE_VERSION = "NEXUS-LIVE v10.16";
const MIN_TICK_MS = 3500;
// v6.3: MAX_ACTIVE is now the governor-owned gate.maxActive knob (2–8, default 5)
// — the static constant only remains as the fallback if the gate read fails.
const MAX_ACTIVE_FALLBACK = 5;
const KLINE_ROTATION = 4;
const FLAVOR_CHANCE = 0.22;
const PURGE_HOURS = 48; // EXPIRED afterlife tracking window

let lastTick = 0;
let tickCount = 0;
let ticking = false;
let universeRefreshedAt = 0;
let flowCursor = 0; // v5.3: rotating slice cursor for flow-domain warmup
let calibLastAt = 0;
let lastLearnedGateEventAt = 0;
let lastStratGateEventAt = 0;
let lastFeedGuardEventAt = 0;
let lastShortGuardEventAt = 0; // v8.4 R1
let lastDislocationEventAt = 0; // v10.15 DISLOCATION-GATE event throttle

// v10.15 DISLOCATION-GATE — rolling-5-scan window of per-symbol venue
// dislocation readings (marketAsset.maxDevBps, refreshed every tick by the
// 4-venue consensus sweep). The guard decides on the window MEDIAN so a
// single-tick spike can neither skip a good candidate nor mask a persistent
// outlier venue. Ring is bounded (5/symbol, ≤64 tracked symbols) and
// fail-open: an unknown symbol with no history starts from its current
// reading only.
const dislocationRing = new Map<string, number[]>();
function rollingDislocationBps(symbol: string, curBps: number | null): number {
  const cur = curBps && Number.isFinite(curBps) ? curBps : 0;
  const ring = dislocationRing.get(symbol);
  const next = ring ? [...ring, cur].slice(-5) : [cur];
  dislocationRing.set(symbol, next);
  const sorted = [...next].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
let lastMembershipEventAt = 0;
let lastPoolSize = 0;
let regimeCursor = 0;
let lastSimBanEventAt = 0;
let lastRetestGateEventAt = 0;
let lastRiskBlockEventAt = 0;
let lastDecisiveEventAt = 0; // v10.6 decisive-excursion filter event throttle
let lastPruneAt = 0;

// ── v5.2 SELF-DRIVING HEARTBEAT — the engine must not depend on page polling ──
// Root-cause fix for the "Trigger Bus WARMING forever" + "Market Regimes empty"
// instability: tick() only advanced when a browser polled /api/pulse, so with
// no tab open the whole engine starved (trigger rotation, regime memo, learner,
// governor — everything). A server-side 4s interval now drives the engine
// autonomously; the first pulse (or keep-alive ping) arms it.
const g = globalThis as { __nexusHeartbeat?: ReturnType<typeof setInterval> };

let armedThisGeneration = false;

export function ensureHeartbeat(): void {
  if (armedThisGeneration) return;
  armedThisGeneration = true;
  // HMR safety: a stale interval from a previous module generation would keep
  // running OLD engine code forever — replace it on first call of this generation.
  if (g.__nexusHeartbeat) clearInterval(g.__nexusHeartbeat);
  g.__nexusHeartbeat = setInterval(() => {
    void tick().catch((e) => console.error("[heartbeat]", e));
  }, 4000);
  g.__nexusHeartbeat.unref?.(); // never hold the dev process open on shutdown
  console.log("[engine] self-driving heartbeat armed (4s) — engine is now autonomous");
  if (relayArmed()) {
    console.log("[engine] telegram relay ARMED — alertable events mirror to operator chat");
    void fireEvent(null, null, "SYSTEM", "info", "TELEGRAM RELAY ARMED — alertable engine events now mirror to the operator chat (env-gated outbound channel)").catch(() => undefined);
  }
}

const TTL_BY_STRATEGY: Record<string, [number, number]> = {
  "AI-SCALP": [60, 90],
  BREAKOUT: [90, 150],
  MOMENTUM: [90, 150],
  "MEAN-REVERT": [60, 120],
  "AI-SWING": [180, 300],
};

// v9.3 ANTI-LATE-ENTRY (operator mandate: «چرا اجرا دیرتر از تشخیص وارد می‌شود
// اصلاح بشود») — per-strategy max adverse drift (%, unlevered) tolerated between
// the DETECTION reference price and the actual entry price. Beyond the cap the
// setup is a cascade chase, not a signal — refused. Radar cards override with
// their own cap (1.5% vs the track anchor, momentum-ignition aware).
const CHASE_CAP_BY_STRATEGY: Record<string, number> = { "AI-SCALP": 0.4, "MEAN-REVERT": 0.5, MOMENTUM: 0.6, BREAKOUT: 0.6, "AI-SWING": 0.9 };

export { sleep };

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fireEvent(signalId: string | null, symbol: string | null, type: string, level: string, message: string) {
  await db.signalEvent.create({ data: { signalId, symbol, type, level, message } });
  // v6.2: optional outbound relay (Telegram when TELEGRAM_* env is armed) —
  // mirrors ALERTABLE events to the operator's phone; fire-and-forget, never
  // blocks the tick, dormant no-op when env is unset.
  // v6.3: signalId passed through so the relay can render the FULL structured
  // signal card (entry/TP/SL ladder, leverage, regime) instead of a bare line.
  relaySignalEvent(type, symbol, message, signalId);
}

// ── v6.2 HOUSEKEEPING — SignalEvent pruning (architecture review P0) ──
// The event feed grows monotonically (every transition writes a row + flavor
// + audits + afterlife reports); an unbounded table slows every findMany on
// the feed and inflates the heap via large query results (the 13:45 OOM
// happened after ~17h of accumulation). Policy: keep 30 days, hard-cap
// 80,000 rows (delete-oldest), run at most once per hour.
// v10.16 P1 RETENTION+ARCHIVE — the old 20k cap was truncating the feed to
// ~19h of history, starving the learning/forensics layers. Cap raised to
// 80k (30d age rule unchanged) and every row slated for deletion is FIRST
// mirrored as a JSON line to a rotated sidecar (8MB → .old), so history
// survives the hot cap. Archival is best-effort: a failure is logged and
// NEVER blocks pruning.
const EVENT_RETENTION_DAYS = 30;
const EVENT_HARD_CAP = 80_000;
const EVENT_ARCHIVE_PATH = "/home/z/my-project/.data/signal-events-archive.jsonl";
const EVENT_ARCHIVE_ROTATE_BYTES = 8 * 1024 * 1024;

type ArchiveRow = { id: string; signalId: string | null; type: string; symbol: string | null; message: string; level: string; createdAt: Date };

function archiveSignalEvents(rows: ArchiveRow[]): number {
  if (rows.length === 0) return 0;
  try {
    mkdirSync("/home/z/my-project/.data", { recursive: true });
    try {
      if (statSync(EVENT_ARCHIVE_PATH).size > EVENT_ARCHIVE_ROTATE_BYTES) {
        renameSync(EVENT_ARCHIVE_PATH, `${EVENT_ARCHIVE_PATH}.old`); // POSIX rename overwrites the previous rotation
      }
    } catch {
      /* stat miss = first write — nothing to rotate */
    }
    const lines = rows.map((r) => JSON.stringify({ id: r.id, signalId: r.signalId, type: r.type, symbol: r.symbol, message: r.message, level: r.level, createdAt: r.createdAt.toISOString() }));
    appendFileSync(EVENT_ARCHIVE_PATH, lines.join("\n") + "\n");
    return rows.length;
  } catch (e) {
    console.error("[housekeeping] SignalEvent archival failed (pruning continues):", e);
    return 0;
  }
}

async function pruneEvents(): Promise<void> {
  if (Date.now() - lastPruneAt < 3_600_000) return;
  lastPruneAt = Date.now();
  const SEL = { id: true, signalId: true, type: true, symbol: true, message: true, level: true, createdAt: true } as const;
  try {
    const cutoff = new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000);
    const staleRows = await db.signalEvent.findMany({ where: { createdAt: { lt: cutoff } }, select: SEL, orderBy: { createdAt: "asc" } });
    let archived = archiveSignalEvents(staleRows);
    const byAge = await db.signalEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
    let byCap = { count: 0 };
    const total = await db.signalEvent.count();
    if (total > EVENT_HARD_CAP) {
      const boundary = await db.signalEvent.findMany({ orderBy: { createdAt: "desc" }, skip: EVENT_HARD_CAP, take: 1, select: { createdAt: true } });
      if (boundary[0]) {
        const capRows = await db.signalEvent.findMany({ where: { createdAt: { lte: boundary[0].createdAt } }, select: SEL, orderBy: { createdAt: "asc" } });
        const alreadyArchived = new Set(staleRows.map((r) => r.id)); // age/cap windows can overlap — never double-archive
        archived += archiveSignalEvents(capRows.filter((r) => !alreadyArchived.has(r.id)));
        byCap = await db.signalEvent.deleteMany({ where: { createdAt: { lte: boundary[0].createdAt } } });
      }
    }
    if (byAge.count + byCap.count > 0) {
      console.log(`[housekeeping] pruned ${byAge.count} age-expired + ${byCap.count} cap-overflow SignalEvents (kept ≤${EVENT_HARD_CAP}, ${EVENT_RETENTION_DAYS}d; ${archived} archived to JSONL)`);
    }
  } catch (e) {
    console.error("[housekeeping] event pruning failed:", e);
  }
}

// ── v10.16 P1 SERIAL RACE ─────────────────────────────────────
// nextSerial()'s read-increment-write critical section is now serialized by a
// promise-chain mutex, and BOTH the lock and the cached counter live on
// globalThis: Next dev bundles a separate module instance per route, so a
// module-scoped serialCache silently forked the sequence per bundle (duplicate
// NX identities). Shared box → one sequence per process. The schema's
// UNIQUE(serial) backstop (prisma v10.16) catches anything a mutex cannot
// see (cross-process); deploySignal retries ONCE on P2002 with a fresh MAX.
type SerialBox = { cache: number | null; lock: Promise<void> };
const gSerial = globalThis as { __nexusSerial?: SerialBox };
const serialBox: SerialBox = gSerial.__nexusSerial ?? { cache: null, lock: Promise.resolve() };
gSerial.__nexusSerial = serialBox;

async function nextSerial(): Promise<number> {
  const run = serialBox.lock.then(async () => {
    if (serialBox.cache !== null) {
      serialBox.cache++;
      return serialBox.cache;
    }
    const agg = await db.signal.aggregate({ _max: { serial: true } });
    serialBox.cache = (agg._max.serial ?? 0) + 1;
    return serialBox.cache;
  });
  serialBox.lock = run.then(() => undefined, () => undefined);
  return run;
}

/** P2002 backstop — re-enter the mutex and move the cache PAST every serial
 *  the DB (or another bundle's in-flight write) may already own. */
async function nextSerialFresh(): Promise<number> {
  const run = serialBox.lock.then(async () => {
    const agg = await db.signal.aggregate({ _max: { serial: true } });
    serialBox.cache = Math.max(serialBox.cache ?? 0, agg._max.serial ?? 0) + 1;
    return serialBox.cache;
  });
  serialBox.lock = run.then(() => undefined, () => undefined);
  return run;
}

// ── universe management ───────────────────────────────────────
const FALLBACK_UNIVERSE = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "TRXUSDT"];

async function ensureAssets(): Promise<void> {
  const count = await db.marketAsset.count();
  if (count > 0) return;
  try {
    const gate = await getGateSettings();
    const universe = await fetchFuturesUniverse(gate.universeSize);
    const symbols = (universe.length >= 5 ? universe.map((u) => u.symbol) : FALLBACK_UNIVERSE).slice(0, gate.universeSize);
    const tickers = await fetchTickers(symbols);
    const now = new Date();
    for (const sym of symbols) {
      const t = tickers.get(sym);
      const price = t ? Number(t.lastPrice) : 0;
      if (!price) continue;
      await db.marketAsset.create({
        data: {
          symbol: sym,
          name: sym.replace("USDT", ""),
          price,
          prevPrice: price,
          change24h: t ? Number(t.priceChangePercent) : 0,
          high24h: t ? Number(t.highPrice) : price,
          low24h: t ? Number(t.lowPrice) : price,
          volume24h: t ? Number(t.quoteVolume) : 0,
          sparkline: JSON.stringify(Array.from({ length: 12 }, () => price)),
          source: "live",
          updatedAt: now,
        },
      });
    }
    await fireEvent(null, null, "SYSTEM", "info", `Universe self-healed from live Binance USDT-M futures ranking — ${symbols.length} perpetuals tracked`);
  } catch {
    /* retry next tick */
  }
}

// v5.1 DYNAMIC UNIVERSE — the tracked set FOLLOWS market flows instead of a fixed list:
// re-rank the WHOLE USDT-M futures market by real 24h turnover, admit the strongest
// entrants (max 12/refresh), and RETIRE symbols that drifted out of the flow ranking
// (max 6/refresh, never ones with open signals). While warming up (tracked < target)
// the re-rank runs every 5min; once at target it slows to every 30min. Scan domain =
// operator UNIVERSE tunable; membership = pure liquidity/flow merit.
const UNIVERSE_REFRESH_MS = 30 * 60_000;
const UNIVERSE_WARMUP_MS = 5 * 60_000;
const UNIVERSE_DROP_BUFFER = 20; // retire only when outside top N+buffer
const ADMISSIONS_PER_REFRESH = 12;

async function refreshUniverse(): Promise<void> {
  const tracked = await db.marketAsset.count();
  const gate = await getGateSettings();
  const warmup = tracked < gate.universeSize;
  const window = warmup ? UNIVERSE_WARMUP_MS : UNIVERSE_REFRESH_MS;
  if (Date.now() - universeRefreshedAt < window) return;
  universeRefreshedAt = Date.now();
  try {
    const [futuresUniverse, liveSymbols] = await Promise.all([fetchFuturesUniverse(gate.universeSize + UNIVERSE_DROP_BUFFER), fetchFuturesSymbols()]);
    if (futuresUniverse.length < 5) return;
    const existing = await db.marketAsset.findMany({ select: { id: true, symbol: true } });
    const have = new Set(existing.map((e) => e.symbol));
    const openSyms = new Set((await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true } })).map((s) => s.symbol));

    // ADMISSIONS — strongest flow-ranked entrants first (capped per refresh)
    const additions = futuresUniverse.map((u) => u.symbol).filter((s) => !have.has(s) && liveSymbols.has(s));
    const admitted: string[] = [];
    if (additions.length > 0) {
      const tickers = await fetchTickers(additions.slice(0, ADMISSIONS_PER_REFRESH));
      for (const sym of additions.slice(0, ADMISSIONS_PER_REFRESH)) {
        const t = tickers.get(sym);
        const price = t ? Number(t.lastPrice) : 0;
        if (!price) continue;
        await db.marketAsset.create({
          data: { symbol: sym, name: sym.replace("USDT", ""), price, prevPrice: price, change24h: t ? Number(t.priceChangePercent) : 0, high24h: t ? Number(t.highPrice) : price, low24h: t ? Number(t.lowPrice) : price, volume24h: t ? Number(t.quoteVolume) : 0, sparkline: JSON.stringify(Array.from({ length: 12 }, () => price)), source: "live" },
        });
        admitted.push(sym);
      }
    }

    // RETIREMENTS — fell out of the flow ranking (top universe+buffer) with no open signal
    const keepSet = new Set(futuresUniverse.map((u) => u.symbol));
    const retire = existing.filter((e) => !keepSet.has(e.symbol) && !openSyms.has(e.symbol) && liveSymbols.has(e.symbol)).slice(0, 6);
    // purity — venue no longer lists it as a live perpetual at all
    const stale = existing.filter((e) => !liveSymbols.has(e.symbol) && !openSyms.has(e.symbol));
    for (const s of [...retire, ...stale]) {
      await db.marketAsset.deleteMany({ where: { symbol: s.symbol } });
    }

    // one merged membership event, rate-limited to once per 10min
    if ((admitted.length > 0 || retire.length > 0 || stale.length > 0) && Date.now() - lastMembershipEventAt > 600_000) {
      lastMembershipEventAt = Date.now();
      const total = await db.marketAsset.count();
      const parts: string[] = [];
      if (admitted.length) parts.push(`admitted ${admitted.slice(0, 4).join(", ")}${admitted.length > 4 ? ` +${admitted.length - 4}` : ""}`);
      if (retire.length) parts.push(`retired ${retire.slice(0, 4).map((s) => s.symbol).join(", ")}${retire.length > 4 ? ` +${retire.length - 4}` : ""} (drifted out of flow ranking)`);
      if (stale.length) parts.push(`purged ${stale.map((s) => s.symbol).join(", ")} (delisted)`);
      await fireEvent(null, null, "SYSTEM", "info", `SCAN DOMAIN: dynamic flow-ranked universe now ${total} USDT-M perps (UNIVERSE ${gate.universeSize}${warmup ? ", warm-up sweep active" : ""}) — ${parts.join(" · ")}`);
    }
  } catch {
    /* keep current universe */
  }
}

/** Scan-domain coverage for the pulse feed (tracked vs the whole futures market). */
export async function getScanDomain(): Promise<{ tracked: number; poolTotal: number; liquidPool: number; target: number }> {
  const [tracked, pool] = await Promise.all([db.marketAsset.count(), fetchFuturesPoolStats()]);
  const gate = await getGateSettings();
  lastPoolSize = pool.totalUsdtPerps || lastPoolSize;
  return { tracked, poolTotal: lastPoolSize, liquidPool: pool.liquidPool, target: gate.universeSize };
}

// purge open signal rows on dead markets? keep monitoring (documented) — only symbols
// that vanish from exchangeInfo get their open signals force-resolved at mark.
async function resolveOrphans(): Promise<void> {
  try {
    const liveSymbols = await fetchFuturesSymbols();
    const open = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, id: true } });
    const orphans = open.filter((s) => !liveSymbols.has(s.symbol));
    for (const o of orphans.slice(0, 3)) {
      const asset = await db.marketAsset.findUnique({ where: { symbol: o.symbol } });
      if (!asset) continue;
      const sig = await db.signal.findUnique({ where: { id: o.id } });
      if (!sig) continue;
      const gross = computeGrossPnl(asset.price, sig);
      const movePct = gross / sig.leverage; // UNLEVERED
      const fb = feeBreakdown(sig.marginUsd, sig.leverage, movePct, heldMinutes(sig, new Date()));
      await db.signal.update({ where: { id: o.id }, data: { status: "CLOSED", closedAt: new Date(), pnlPercent: Number(fb.netPct.toFixed(2)) } });
      await fireEvent(o.id, o.symbol, "CLOSED", "warn", `${o.symbol} venue delisted from USDT-M perpetuals — position force-closed at mark (${fb.netPct >= 0 ? "+" : ""}${fb.netPct.toFixed(1)}% NET)`);
    }
  } catch {
    /* non-fatal */
  }
}

// ── v10.16 P0-2 SETTLEMENT STALENESS GATE ─────────────────────
// Settlement (resolveSignals + trackAfterlife) must never mint an outcome
// from a price the engine invented. `lastLiveAt` records, per symbol, the
// last tick whose TERMINAL price was live-sourced (Binance futures ticker or
// a ≥2-venue consensus median); the map is globalThis-cached so HMR module
// bundles share one truth instead of forking per route. A symbol is
// settlement-unsafe when the current price map has no entry, its source is
// not "live", or its last live tick is older than 120s — in all three cases
// every settlement decision for that symbol simply WAITS for a live price.
const SETTLEMENT_STALE_MS = 120_000;
const gLive = globalThis as { __nexusLastLiveAt?: Map<string, number> };
const lastLiveAt: Map<string, number> = gLive.__nexusLastLiveAt ?? new Map<string, number>();
gLive.__nexusLastLiveAt = lastLiveAt;
// the CURRENT tick's asset rows (refreshed at the end of updatePrices)
let latestAssets = new Map<string, MarketAsset>();

function settlementUnsafe(symbol: string): boolean {
  const a = latestAssets.get(symbol);
  if (!a) return true; // no entry in the current price map
  if (a.source !== "live") return true; // terminal price is sim drift
  return Date.now() - (lastLiveAt.get(symbol) ?? 0) > SETTLEMENT_STALE_MS; // live is stale
}

// per-symbol 10min event throttle for the settlement-stall notice (same
// last*EventAt pattern as the other engine event throttles)
const settlementStallEventAt = new Map<string, number>();
async function noteSettlementStall(symbol: string): Promise<void> {
  const last = settlementStallEventAt.get(symbol) ?? 0;
  if (Date.now() - last < 600_000) return;
  settlementStallEventAt.set(symbol, Date.now());
  await fireEvent(null, symbol, "ENGINE", "warn", `SETTLEMENT STALLED — live feed unavailable for ${symbol}; settlement deferred (v10.16)`).catch(() => undefined);
}

// ── price update (real tickers + consensus median) ───────────
async function updatePrices(): Promise<MarketAsset[]> {
  const assets = await db.marketAsset.findMany();
  if (assets.length === 0) return [];
  const symbols = assets.map((a) => a.symbol);
  const [tickers, consensus] = await Promise.all([fetchTickers(symbols), sweepConsensus(symbols)]);
  const now = new Date();
  const addPoints = tickCount % 12 === 0;

  for (const a of assets) {
    const t = tickers.get(a.symbol);
    const c = consensus.get(a.symbol);
    // terminal price IS the median when ≥2 venues agree, else Binance mid
    const next = c && c.venuesOk >= 2 && c.median ? c.median : t ? Number(t.lastPrice) : a.price * (1 + (Math.random() - 0.5) * 0.001); // sim drift last resort
    if (!next || next <= 0) continue;
    // v10.16 P0-2 — the terminal price is live-sourced iff a real ticker or a
    // ≥2-venue consensus produced it (same predicate as `source` below); stamp
    // the last-live clock ONLY on those ticks so the settlement gate can tell
    // live data from the random-walk sim fallback.
    const liveNow = !!(t || (c && c.venuesOk >= 2));
    const change24h = t ? Number(t.priceChangePercent) : a.change24h;
    const spark = JSON.parse(a.sparkline) as number[];
    spark.push(Number(next.toFixed(next > 100 ? 1 : 5)));
    if (spark.length > 48) spark.shift();
    const exchanges = c ? c.quotes.map((q) => ({ venue: q.venue, price: q.price, latencyMs: q.latencyMs })) : null;

    await db.marketAsset.update({
      where: { id: a.id },
      data: {
        prevPrice: a.price,
        price: Number(next.toFixed(next > 100 ? 2 : 6)),
        change24h: Number(change24h.toFixed(2)),
        high24h: t ? Number(t.highPrice) : Math.max(a.high24h, next),
        low24h: t ? Number(t.lowPrice) : Math.min(a.low24h, next),
        volume24h: t ? Number(t.quoteVolume) : a.volume24h,
        sparkline: JSON.stringify(spark),
        exchanges: exchanges ? JSON.stringify(exchanges) : a.exchanges,
        maxDevBps: c?.maxDevBps ?? a.maxDevBps,
        source: liveNow ? "live" : "sim",
        updatedAt: now,
      },
    });
    if (liveNow) lastLiveAt.set(a.symbol, Date.now());

    if (addPoints) await db.pricePoint.create({ data: { symbol: a.symbol, price: Number(next.toFixed(next > 100 ? 2 : 6)), createdAt: now } });

    // dislocation event (rate-limited by 12bps threshold)
    if (c && c.maxDevBps >= 12 && tickCount % 10 === 0) {
      const furthest = c.quotes.filter((q) => q.price).sort((x, y) => Math.abs((y.price ?? 0) - c.median!) - Math.abs((x.price ?? 0) - c.median!))[0];
      if (furthest) await fireEvent(null, a.symbol, "ENGINE", "warn", `Cross-exchange dislocation: ${a.symbol} spread ${c.maxDevBps.toFixed(1)} bps — ${furthest.venue} furthest from 4-venue consensus median`);
    }
  }

  if (addPoints) {
    const cutoff = new Date(Date.now() - 48 * 3600_000);
    await db.pricePoint.deleteMany({ where: { createdAt: { lt: cutoff } } });
  }
  const fresh = await db.marketAsset.findMany();
  latestAssets = new Map(fresh.map((a) => [a.symbol, a])); // settlement gate reads the CURRENT price map
  return fresh;
}

// kline round-robin cache for confluence scans
const klineCache = new Map<string, { at: number; candles: Awaited<ReturnType<typeof fetchKlines>> }>();
const KLINE_TTL = 55_000;

async function getKlines(symbol: string): Promise<Awaited<ReturnType<typeof fetchKlines>> | null> {
  const hit = klineCache.get(symbol);
  if (hit && Date.now() - hit.at < KLINE_TTL) return hit.candles;
  try {
    const candles = await fetchKlines(symbol, "15m", 160);
    klineCache.set(symbol, { at: Date.now(), candles });
    return candles;
  } catch {
    return hit?.candles ?? null;
  }
}

// ── fee-aware NET resolution ──────────────────────────────────
function computeGrossPnl(price: number, s: Signal): number {
  const isLong = s.direction === "LONG";
  const move = ((price - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1);
  return move * s.leverage * 100;
}

function heldMinutes(s: Signal, at: Date): number {
  return Math.max(0, (at.getTime() - s.createdAt.getTime()) / 60_000);
}

async function resolveSignals(assets: MarketAsset[]) {
  const priceMap = new Map(assets.map((a) => [a.symbol, a.price]));
  const active = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } });
  const now = new Date();
  // v6.5: gate settings fetched once per tick batch — the mid-ladder breakeven
  // arm (BE-TRAIL) and the expiry gate share the same governor-owned knobs.
  const gate = await getGateSettings();
  let resolved = 0;
  let leveled = 0;

  for (const s of active) {
    const price = priceMap.get(s.symbol);
    if (!price) continue;

    // ── v10.16 P0-2 SETTLEMENT STALENESS GATE ── a signal whose symbol has no
    // live price (missing from the map / sim-sourced / >120s since the last
    // live tick) is SKIPPED this tick entirely — no SL, no TP, no BE-arm, no
    // early-exit, no TTL-extension decision, not even time-based EXPIRY. The
    // signal simply waits for a live price: settling on the random-walk sim
    // fallback would mint fake outcomes (audit P0-2).
    if (settlementUnsafe(s.symbol)) {
      await noteSettlementStall(s.symbol); // rate-limited to 1/10min per symbol
      continue;
    }

    const isLong = s.direction === "LONG";
    const movePct = ((price - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100; // UNLEVERED price move %
    const gross = movePct * s.leverage; // levered % on margin (display)
    const fb = feeBreakdown(s.marginUsd, s.leverage, movePct, heldMinutes(s, now));
    const maxGross = Math.max(s.maxPnlPercent, fb.netPct);

    let status = s.status;
    let closedAt: Date | null = null;
    let stopLossNext: number | null = null; // v5.4: trail the stop when ladder rungs are banked

    const hitTp = (level: 1 | 2 | 3) => {
      const target = level === 1 ? s.tp1 : level === 2 ? s.tp2 : s.tp3;
      return isLong ? price >= target : price <= target;
    };
    const hitSl = isLong ? price <= s.stopLoss : price >= s.stopLoss;

    // v5.4 TP-PROVEN LEDGER — reaching TP1/TP2 is a permanent, auditable win:
    // reachedTp persists even if the trade later stops out or expires, so the
    // analytics win-rate counts every TP1/TP2/TP3 touch (operator request).
    const reachedTp = Math.max(s.reachedTp, hitTp(1) ? 1 : 0, hitTp(2) ? 2 : 0, hitTp(3) ? 3 : 0);

    if (hitSl) {
      status = "SL";
      closedAt = now;
      // v5.4: PnL is measured to the EFFECTIVE stop (trailed stops are real):
      // original stop → -1R · breakeven trail after TP1 → ~0R · TP1 trail after TP2 → +1R
      const stopMovePct = ((s.stopLoss - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100;
      const grossAtStop = stopMovePct * s.leverage;
      const trailNote = grossAtStop > 0.5 ? " · trailed stop executed at TP1 — +1R locked on the runner" : Math.abs(grossAtStop) <= 0.5 ? " · breakeven stop executed — runner flat, TP1 profit banked" : "";
      await fireEvent(s.id, s.symbol, "SL", "error", `${s.symbol} stopped @ ${s.stopLoss.toFixed(s.stopLoss > 100 ? 1 : 4)} — risk contained (${grossAtStop >= 0 ? "+" : "-"}${Math.abs(grossAtStop).toFixed(1)}% gross)${trailNote || (reachedTp >= 1 ? " · TP1 had been banked earlier" : "")}`);
    } else if (hitTp(3)) {
      status = "TP3";
      closedAt = now;
      await fireEvent(s.id, s.symbol, "TP3", "success", `${s.symbol} final target secured — full ${s.riskReward.toFixed(1)}R journey captured 🎯 (TP ladder ${reachedTp}/3 banked · v6.6 tranche-settled: 50% @TP1 + 30% @TP2 + 20% @TP3)`);
    } else if (hitTp(2) && s.status !== "TP2") {
      status = "TP2";
      stopLossNext = s.tp1; // v5.4: trail the stop to TP1 — the announced +1R lock is now enforced
      await fireEvent(s.id, s.symbol, "TP2", "success", `${s.symbol} TP2 reached — 80% booked, stop trailed to TP1 (+1R locked) · recorded as WIN (TP-proven ${reachedTp}/3)`);
    } else if (hitTp(1) && s.status === "ACTIVE") {
      status = "TP1";
      stopLossNext = s.entryPrice; // v5.4: breakeven trail is now enforced, not just announced
      await fireEvent(s.id, s.symbol, "TP1", "success", `${s.symbol} TP1 reached — 50% booked, SL → breakeven · recorded as WIN (TP-proven ${reachedTp}/3)`);
    } else if (
      // ── v6.5 MID-LADDER BREAKEVEN ARM (perf forensics 2026-09-07) ──
      // Evidence: 57% of SL trades were first in profit (avg MFE +15% levered)
      // but the v5.4 trail armed only at TP1 (+1R ≈ +25% levered typical), so
      // winners round-tripped into full −1R stops — the largest damage bucket
      // (SL −$89.21 of −$114.96 gross loss). Once the NET pnl first touches
      // +beTrailPct% levered, the stop moves to entry: downside becomes fee-only.
      // ── v8.4 R2 DEFINITIVE BREAKEVEN (module-performance audit 2026-09-11) ──
      // The audit still found 8 winners (MFE ≥ +8% levered) closing negative —
      // ≈$4.73 give-back, MARSCOIN +22%→−59.7%. The arm now ALSO fires on the
      // UNLEVERED price move (beArmMovePct, default +1.5% — leverage-invariant,
      // catches spikes between pulses whatever the multiplier) and stays
      // DEFINITIVE: once armed, the stop lives at entry and never re-widens.
      s.status === "ACTIVE" &&
      (isLong ? s.stopLoss < s.entryPrice : s.stopLoss > s.entryPrice) &&
      ((gate.beTrailPct > 0 && fb.netPct >= gate.beTrailPct) || (gate.beArmMovePct > 0 && movePct >= gate.beArmMovePct))
    ) {
      stopLossNext = s.entryPrice;
      const viaPrice = !(gate.beTrailPct > 0 && fb.netPct >= gate.beTrailPct) && gate.beArmMovePct > 0 && movePct >= gate.beArmMovePct;
      await fireEvent(s.id, s.symbol, "BE_TRAIL", "info", `${s.symbol} breakeven armed @ +${(viaPrice ? movePct : fb.netPct).toFixed(1)}% ${viaPrice ? "price (R2 arm)" : "NET"} (gate ≥ ${viaPrice ? `+${gate.beArmMovePct}% price` : `+${gate.beTrailPct}% NET`}) — stop moved to entry, −1R risk retired; runner rides to TP ladder risk-free`);
    } else if (
      // ── v8.4 R2/R7 EARLY TIME-EXIT (module-performance audit 2026-09-11) ──
      // EXPIRED closes averaged +$2.66 while SL closes averaged −$12.61: a
      // trade sliding toward the stop is better off closing at the mark than
      // riding to −1R, and a stalled trade only burns fees + a capacity slot.
      // After earlyExitFrac of the TTL, an UNBANKED trade (reachedTp 0 — once
      // a rung is banked the stop already trails at breakeven-or-better) may
      // exit early when:
      //   · ADVERSE — NET ≤ −earlyExitR × 1R (default −0.45R): cuts the SL tail
      //   · STALLED — |gross| ≤ 0.15R: no momentum in either direction
      // Early exits settle EXPIRED → 48h afterlife tracking validates the cut.
      gate.earlyExitGuard > 0 &&
      s.status === "ACTIVE" &&
      reachedTp === 0 &&
      now.getTime() <= s.expiresAt.getTime() && // v9.5.1 hotfix: early-exit window ends at natural TTL — past expiry the DYNAMIC EXPIRY GATE below owns the signal. The else-if chain previously starved branch 7 whenever an unbanked, non-adverse, non-stalled signal crossed earlyExitFrac (operator report 2026-09-13: NX-0174/NX-0183/NX-0199 immortal 00:00 cards).
      heldMinutes(s, now) >= gate.earlyExitFrac * s.ttlMinutes
    ) {
      const rAnchor = s.initialStopLoss ?? s.stopLoss; // immutable deploy-time risk anchor (fallback: legacy rows)
      const rGross = Math.abs(((rAnchor - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100) * s.leverage; // 1R in levered %
      const adverse = gate.earlyExitR > 0 && fb.netPct <= -(gate.earlyExitR * rGross);
      const stalled = Math.abs(gross) <= 0.15 * rGross;
      if (adverse || stalled) {
        status = "EXPIRED";
        closedAt = now;
        await fireEvent(s.id, s.symbol, "EARLY_EXIT", "warn", `EARLY TIME-EXIT (${adverse ? `ADVERSE — NET ${fb.netPct.toFixed(1)}% ≤ −${(gate.earlyExitR * rGross).toFixed(0)}% ≈ −${gate.earlyExitR.toFixed(2)}R` : `STALLED — |move| ≤ 0.15R after ${Math.round(gate.earlyExitFrac * 100)}% of TTL`}) — ${s.symbol} closed at mark ${gross >= 0 ? "+" : ""}${gross.toFixed(1)}% gross / ${fb.netPct >= 0 ? "+" : ""}${fb.netPct.toFixed(1)}% NET after ${heldMinutes(s, now).toFixed(0)}m, no rung banked · audit R2/R7: EXPIRED +$2.66 vs SL −$12.61 — exit before the stop · 48h afterlife tracking armed`);
      }
    } else if (now.getTime() > s.expiresAt.getTime()) {
      // ── v6.1 DYNAMIC EXPIRY GATE ─────────────────────────────
      // Post-expiry afterlife evidence showed most expiries reach TP afterwards
      // (64% would-have-won). Instead of a hard TTL cut, an automatic gate
      // evaluates each maturing signal: extension budget, risk distance,
      // TP proximity, profit state and live momentum. The governor (LLM)
      // owns the policy knobs — ttlExtendMax / ttlExtendMinutes / ttlNearTpPct.
      // v9.3: radar R6 cards (RADAR-TTL tag) NEVER get extensions — their short
      // explicit TTL is the informative-ratio lever; extending would reintroduce
      // exactly the EXPIRED censoring the R6 gate drowns in.
      const radarNoExtend = !!s.tags && s.tags.split(",").includes("RADAR-TTL");
      const ext: TtlDecision = gate.ttlExtendMax > 0 && !radarNoExtend ? await evaluateTtlExtension(s, price, movePct, gate, now) : { grant: false, nearTp: false, reason: radarNoExtend ? "radar R6 card — TTL extension disabled (informative-ratio mandate)" : "gate disabled by governor (ttlExtendMax 0)" };
      if (ext.grant) {
        const newExpiry = new Date(s.expiresAt.getTime() + gate.ttlExtendMinutes * 60_000);
        await db.signal.update({ where: { id: s.id }, data: { expiresAt: newExpiry, ttlExtensions: s.ttlExtensions + 1 } });
        await bumpTtlTelemetry({ extended: 1 });
        // v6.1.1: dedicated TTL_EXTENDED type — grants are ALERTABLE now (toast + sound),
        // previously silent ENGINE events the operator never saw ("سیستم هیچ واکنشی نداره")
        await fireEvent(s.id, s.symbol, "TTL_EXTENDED", "info", `DYNAMIC EXPIRY GATE — ${s.symbol} TTL extended +${gate.ttlExtendMinutes}m (grant #${s.ttlExtensions + 1}/${gate.ttlExtendMax}) · ${ext.reason} — auto-close deferred, mark now ${gross >= 0 ? "+" : ""}${gross.toFixed(1)}% gross / ${fb.netPct >= 0 ? "+" : ""}${fb.netPct.toFixed(1)}% NET`);
        leveled++;
        continue;
      }
      status = "EXPIRED";
      closedAt = now;
      await bumpTtlTelemetry({ denied: 1, deniedNearTp: ext.nearTp ? 1 : 0 });
      await fireEvent(s.id, s.symbol, "TTL_EXPIRED", "warn", `${s.symbol} TTL (${s.ttlMinutes}m${s.ttlExtensions ? ` +${s.ttlExtensions} ext` : ""}) elapsed — auto-closed at mark ${gross >= 0 ? "+" : ""}${gross.toFixed(1)}% gross / ${fb.netPct >= 0 ? "+" : ""}${fb.netPct.toFixed(1)}% NET · expiry gate: ${ext.reason} · entering 48h afterlife tracking`);
    }

    // ── v6.6 TRANCHE-AWARE NET ACCOUNTING (operator-approved, both ledger bugs fixed) ──
    // Bug A: TP3 exits were priced off the CURRENT (trailed) stop, so any stop
    // move (BE-trail, TP1/TP2 trail) collapsed the risk distance and understated
    // every TP3 close (measured: NX-119/NX-127 under-booked +$4.71 combined).
    // Fix: the runner leg exits at the tp3 RUNG — a deploy-time price that stop
    // moves can never touch (moveAtPct(tp3) ≡ rr × ORIGINAL risk distance).
    // initialStopLoss stays captured at deploy as the immutable risk anchor for
    // forensics. Legacy rows keep the old numbers — only future closes re-price.
    // Bug B: banked rungs (TP1 50% / TP2 30%) were priced at the FINAL exit on
    // FULL margin — TP3 closes overstated, TP1→BE round-trips lost the banked
    // profit entirely. Settled pnl now weights every tranche at its real exit
    // (TP1 50% @ tp1 · TP2 30% @ tp2 · runner @ final exit), matching what the
    // ladder announces. Fees still accrue on the full notional (3 exit fills sum
    // to one position) — pnlPercent stays margin-relative, so every downstream
    // pnlUsd = margin × pnlPercent/100 consumer keeps its contract.
    const moveAtPct = (px: number) => ((px - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100; // UNLEVERED
    let finalMovePct: number;
    if (!closedAt) {
      finalMovePct = movePct;
    } else if (reachedTp >= 1) {
      // TRANCHES GO FIRST — any close after a banked rung is tranche-weighted no
      // matter how it ends, because 50%/30% already left the book at their rung
      // prices while the trade was still open. Runner leg by final status:
      //   TP3        → exits at tp3, a deploy-time rung — Bug A fixed by
      //                construction (stop moves can no longer touch the math:
      //                moveAtPct(tp3) ≡ rr × original-risk-distance × 100)
      //   SL         → exits at the EFFECTIVE (trailed) stop (v5.4 semantics)
      //   EXPIRED/…  → exits at the closing mark
      const runnerMove = status === "TP3" ? moveAtPct(s.tp3) : status === "SL" ? moveAtPct(s.stopLoss) : movePct;
      const tranches: Array<{ weight: number; movePct: number }> = [{ weight: LADDER_TRANCHES.tp1, movePct: moveAtPct(s.tp1) }];
      if (reachedTp >= 2) tranches.push({ weight: LADDER_TRANCHES.tp2, movePct: moveAtPct(s.tp2) });
      tranches.push({ weight: 1 - LADDER_TRANCHES.tp1 - LADDER_TRANCHES.tp2, movePct: runnerMove });
      finalMovePct = ladderWeightedMove(tranches);
    } else if (status === "SL") {
      finalMovePct = moveAtPct(s.stopLoss); // v5.4: EFFECTIVE (trailed) stop is the real exit — nothing was banked
    } else {
      finalMovePct = movePct; // EXPIRED / CLOSED without any banked rung — mark price on full margin
    }
    const finalFb = feeBreakdown(s.marginUsd, s.leverage, finalMovePct, heldMinutes(s, closedAt ?? now));

    // ── v6.3 REGIME OUTCOME TELEMETRY — every close feeds the per-regime
    // ledger the governor reads each cycle (REGIME LEDGER context line) so
    // regimeGuard hardening is tuned from realized PNL evidence, not vibes.
    if (closedAt) {
      const rTag = regimeTagOf(s.tags);
      if (rTag) {
        const win = finalFb.netPct > 0 || reachedTp >= 1;
        void bumpRegimeTelemetry(rTag, win, Number(((s.marginUsd * finalFb.netPct) / 100).toFixed(2))).catch(() => undefined);
      }
      // ── v8.4 R5 RESEARCH-SHADOW SETTLE — close the deploy-time A/B pair with
      // a 1m-candle replay of both ladders (fire-and-forget, never blocks) ──
      if (gate.researchShadow > 0) {
        void settleResearchShadow({
          serial: s.serial,
          symbol: s.symbol,
          direction: s.direction as "LONG" | "SHORT",
          entry: s.entryPrice,
          createdAt: s.createdAt,
          closedAt,
          live: { stop: s.stopLoss, tp3: s.tp3, rr: s.riskReward },
          finalStatus: status,
        }).catch(() => undefined);
      }
    }

    await db.signal.update({
      where: { id: s.id },
      data: {
        status,
        reachedTp,
        ...(stopLossNext !== null ? { stopLoss: Number(stopLossNext.toFixed(s.entryPrice > 100 ? 2 : 6)) } : {}),
        pnlPercent: Number(finalFb.netPct.toFixed(2)),
        maxPnlPercent: Number(Math.max(maxGross, finalFb.netPct).toFixed(2)),
        closedAt,
        feeUsd: closedAt ? finalFb.commissionUsd : s.feeUsd,
        swapUsd: closedAt ? finalFb.swapUsd : s.swapUsd,
        afterlife: status === "EXPIRED" ? "TRACKING" : s.afterlife,
      },
    });

    if (closedAt) resolved++;
    else if (status !== s.status) leveled++;

    // ── v6.1 TTL-GATE outcome telemetry — extended signals are followed to
    // their final resolution so the governor can tune the policy from evidence
    if (closedAt && s.ttlExtensions > 0) {
      if (status === "SL") await bumpTtlTelemetry({ slAfter: 1 });
      else if (status === "EXPIRED") await bumpTtlTelemetry({ reExpired: 1 });
      else await bumpTtlTelemetry({ tpAfter: 1, capturedUsd: Number(((s.marginUsd * finalFb.netPct) / 100).toFixed(2)) });
    }
  }

  return { resolved, leveled, activeCount: active.length };
}

// ── EXPIRED afterlife tracking (Bug 5 — شفافیت چرخه عمر EXPIRED) ──
let lastAfterlifeStallEventAt = 0; // v10.16 — GLOBAL 10min throttle for the afterlife stall notice
async function trackAfterlife(assets: MarketAsset[]) {
  const priceMap = new Map(assets.map((a) => [a.symbol, a.price]));
  const tracking = await db.signal.findMany({ where: { afterlife: "TRACKING", status: "EXPIRED" } });
  for (const s of tracking) {
    if (s.closedAt && Date.now() - s.closedAt.getTime() > PURGE_HOURS * 3600_000) {
      await db.signal.update({ where: { id: s.id }, data: { afterlife: "FLAT", afterlifeAt: new Date() } });
      // v6.1: report window closure — the feed now says the follow-up ended, not silence
      await fireEvent(s.id, s.symbol, "ENGINE", "info", `${s.symbol} EXPIRED follow-up closed — 48h afterlife window ended with no TP/SL re-test (window verdict FLAT)`);
      continue;
    }
    const price = priceMap.get(s.symbol);
    // ── v10.16 P0-2 SETTLEMENT STALENESS GATE — same skip as resolveSignals:
    // an afterlife verdict (post-expiry TP/SL re-test) must never be minted
    // from sim prices. The clock-based 48h window closure above still runs —
    // it consumes no price. Global 10min-throttled notice below.
    if (settlementUnsafe(s.symbol)) {
      if (Date.now() - lastAfterlifeStallEventAt > 600_000) {
        lastAfterlifeStallEventAt = Date.now();
        await fireEvent(null, null, "ENGINE", "warn", "SETTLEMENT STALLED — live feed unavailable; afterlife tracking deferred for stalled symbols (v10.16)").catch(() => undefined);
      }
      continue;
    }
    if (!price) continue;
    const isLong = s.direction === "LONG";
    const movePct = ((price - s.entryPrice) / s.entryPrice) * (isLong ? 1 : -1) * 100; // UNLEVERED
    const maxPost = Math.max(s.maxPostPnlPercent, movePct * s.leverage);

    let afterlife: string | null = s.afterlife;
    let afterlifeAt: Date | null = null;
    const hitTp = (t: number) => (isLong ? price >= t : price <= t);
    if (hitTp(s.tp3)) afterlife = "TP3_HIT";
    else if (hitTp(s.tp2)) afterlife = "TP2_HIT";
    else if (hitTp(s.tp1)) afterlife = "TP1_HIT";
    else if (isLong ? price <= s.stopLoss : price >= s.stopLoss) afterlife = "SL_HIT";

    const update: Record<string, unknown> = { maxPostPnlPercent: Number(maxPost.toFixed(2)) };
    if (afterlife && afterlife !== s.afterlife) {
      update.afterlife = afterlife;
      update.afterlifeAt = afterlifeAt ?? new Date();
      await fireEvent(s.id, s.symbol, "AFTERLIFE", afterlife === "SL_HIT" ? "warn" : "info", `${s.symbol} EXPIRED follow-up: price would have hit ${afterlife.replace("_", " ")} after TTL (post-expiry MFE ${maxPost >= 0 ? "+" : ""}${maxPost.toFixed(1)}% levered) — TTL calibration data point`);
    }
    await db.signal.update({ where: { id: s.id }, data: update });
  }
}

// ── v6.1 DYNAMIC EXPIRY GATE — policy evaluator + telemetry live in
// src/lib/ttl-gate.ts (shared with the governor without an import cycle).
// The gate is DETERMINISTIC (every input measured) while the POLICY (budget,
// window length, TP proximity band) is owned by the AI governor, which reads
// the ttl-gate telemetry + afterlife post-mortem each cycle and tunes the
// knobs via set_ttl_extend_max / set_ttl_extend_minutes. Zero manual modes.

// v10.14 SQN telemetry (supervisor proposal msg 3920, operator APPROVE
// 2026-09-19T08:56Z msg 861802419): every realizedEdgeFilter evaluation
// records the SQN-style R-normalized statistic of the rolling window next to
// the legacy mean-% statistic. SQN = √N × mean(R)/std(R) on the same
// pnlPercent series — scale-free, outlier-discounted via std, √N-discounted
// by construction. DECISION RULES ARE UNCHANGED (the −3%/−2% floors still
// decide); the SQN column exists so the advisor's future KNOB_ADJUST
// (triggered by the GATE-NEAR-MISS cohort per msg 3920) compares both
// statistics on live data, not opinion. Restart-safe: in-memory mirror only,
// re-populated by the next real gate evaluation.
const mgSqnTelemetry = new Map<string, { sqn: number; sqnTrim: number; n: number; expPct: number; at: number }>();

function sqnOf(pnls: number[]): { sqn: number; sqnTrim: number } {
  const n = pnls.length;
  const mean = pnls.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n); // population (ddof 0)
  const sqn = sd > 0 ? Math.sqrt(n) * (mean / sd) : 0;
  const sorted = [...pnls].sort((a, b) => a - b);
  const k = Math.floor(n * 0.1);
  const trim = k > 0 && n - 2 * k >= 5 ? sorted.slice(k, n - k) : sorted;
  const tm = trim.reduce((a, b) => a + b, 0) / trim.length;
  const tsd = Math.sqrt(trim.reduce((a, b) => a + (b - tm) * (b - tm), 0) / trim.length);
  const sqnTrim = tsd > 0 ? Math.sqrt(trim.length) * (tm / tsd) : 0;
  return { sqn: Number(sqn.toFixed(2)), sqnTrim: Number(sqnTrim.toFixed(2)) };
}

/** v10.14 — live SQN-vs-legacy snapshot of the memory-gate rolling windows
 * (what the advisor KNOB_ADJUST will compare). Keys: strategy name; combo
 * windows under `symbol:strategy`. Read by /api/ai/near-miss (gateSqn block). */
export function memoryGateSqnSnapshot(): { strategies: { key: string; n: number; expPct: number; sqn: number; sqnTrim: number; ageMin: number }[]; note: string } {
  const strategies = [...mgSqnTelemetry.entries()].map(([key, v]) => ({ key, n: v.n, expPct: Number(v.expPct.toFixed(2)), sqn: v.sqn, sqnTrim: v.sqnTrim, ageMin: Math.round((Date.now() - v.at) / 60_000) })).sort((a, b) => a.ageMin - b.ageMin);
  return { strategies, note: "SQN = sqrt(N) x mean(R)/std(R) on the same rolling pnlPercent series the legacy mean-% gate reads — decision rules unchanged until the GATE-NEAR-MISS 30-settle cohort lands (msg 3920 rule)" };
}

// ── deployment gates ──────────────────────────────────────────
async function realizedEdgeFilter(symbol: string, strategy: string): Promise<{ ok: boolean; reason?: string; probe?: boolean }> {
  // v6.3 PROFIT-FIRST MEMORY GATE (operator mandate: «معیار سود، نه تعداد برد»):
  // suppression now keys on NET EXPECTANCY (avg %/trade), not raw win rate.
  // Measured proof: BREAKOUT passed the old WR gate at 28% while bleeding
  // −13.1%/trade (−$564 over 43 trades) — a win-rate-only gate is blind to a
  // strategy that wins small and loses huge. Expectancy cannot be fooled.
  // v8.4.1 G5 (operator mandate «انجام بده» 2026-09-11): the memory gate had
  // the SAME cumulative-all-time flaw the learned gate had before G1 —
  // pre-R-package poison rows (SL −$12.61 era) suppressed a strategy forever
  // with no lift path (no deploys → no fresh settles → suppression never
  // re-evaluates): a THIRD deadlock path, discovered because G4 probe deploys
  // could never reach the learned gate (AI-SWING was suppressed upstream on
  // all-time n=13 / exp −11.4%). Scope BOTH ledgers to the EPOCH-2 book with
  // ROLLING windows (take 30 strategy / 20 combo): the gate judges the NEW
  // engine on the NEW book; old rows roll OUT as G4-probe and normal settles
  // land. Evidence floors unchanged (n≥8 combo · n≥12 strategy).
  const combo = await db.signal.findMany({ where: { symbol, strategy, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-2" } }, select: { pnlPercent: true, reachedTp: true }, orderBy: { createdAt: "desc" }, take: 20 });
  if (combo.length >= 8) {
    const exp = combo.reduce((a, c) => a + c.pnlPercent, 0) / combo.length;
    const wr = (combo.filter((c) => c.pnlPercent > 0 || c.reachedTp >= 1).length / combo.length) * 100;
    const cSq = sqnOf(combo.map((c) => c.pnlPercent));
    mgSqnTelemetry.set(`${symbol}:${strategy}`, { ...cSq, n: combo.length, expPct: exp, at: Date.now() });
    if (exp < -3) return { ok: false, reason: `${symbol}+${strategy} realized expectancy ${exp.toFixed(1)}%/trade (n=${combo.length} EPOCH-2 rolling) < −3% — bleeding combo · SQN ${cSq.sqn}` };
    if (wr < 25 && exp < 0) return { ok: false, reason: `${symbol}+${strategy} realized WR ${wr.toFixed(0)}% with negative expectancy ${exp.toFixed(1)}%/trade (n=${combo.length} EPOCH-2 rolling) · SQN ${cSq.sqn}` };
  }
  const strat = await db.signal.findMany({ where: { strategy, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-2" } }, select: { pnlPercent: true, reachedTp: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 30 });
  if (strat.length >= 12) {
    const exp = strat.reduce((a, c) => a + c.pnlPercent, 0) / strat.length;
    const sSq = sqnOf(strat.map((c) => c.pnlPercent));
    mgSqnTelemetry.set(strategy, { ...sSq, n: strat.length, expPct: exp, at: Date.now() });
    if (exp >= 0) return { ok: true };
    // v10.9.3 MEMORY-GATE RE-ENTRY HYSTERESIS WITH PROBE SIZING (operator APPROVE
    // 2026-09-16 «تایید پیشنهاد سوپروایزر کامل و مهندسی», SUPERVISOR proposal
    // cmu4858z001x1rj3e6g6njk49): a single −2% threshold has two failure modes —
    // chatter around the threshold, and an evidence-starvation loop (suppressed
    // → no new settles → the rolling-30 recovers on a CLOCK, not on regime
    // truth). Live proof 2026-09-16: AI-SWING suppressed SITEWIDE at −2.8..−3.0%
    // (n=30) while carrying 261/414 = 63% of the book. Schmitt-trigger fix:
    // negative-expectancy strategies admit HALF-SIZE probe deploys (tagged
    // MG-PROBE) instead of full-size trade-or-nothing; a 5-probe block with
    // expectancy ≥ 0 restores full size; a failed block re-suppresses with a
    // 48h cooldown (G5 anti-deadlock — a lift path must always exist); the
    // hard zone (< −2%) keeps its legacy reason string while the window is
    // still moving (fresh settles) and gains a 24h-frozen escape so a
    // suppressed strategy can always recharge its own window. Cycle state is
    // derived from the MG-PROBE ledger itself (gap-walk 48.5h) — restart-proof,
    // no extra state store.
    const probes = await db.signal.findMany({ where: { strategy, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "MG-PROBE" }, createdAt: { gt: new Date(Date.now() - 7 * 24 * 3600_000) } }, select: { pnlPercent: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 12 });
    const cycle: typeof probes = [];
    for (const p of probes) {
      if (cycle.length === 0 || new Date(cycle[cycle.length - 1]!.createdAt).getTime() - new Date(p.createdAt).getTime() <= 48.5 * 3600_000) cycle.push(p);
      else break;
    }
    if (cycle.length >= 5) {
      const blockExp = cycle.slice(0, 5).reduce((a, c) => a + c.pnlPercent, 0) / 5;
      if (blockExp >= 0) return { ok: true }; // probe block PASSED — full size restored
      const newestProbeAgeMs = Date.now() - new Date(cycle[0]!.createdAt).getTime();
      if (newestProbeAgeMs < 48 * 3600_000) return { ok: false, reason: `${strategy} probe block FAILED (last-5 MG-PROBE expectancy ${blockExp.toFixed(1)}%/trade) — re-suppressed; fresh probe cycle re-arms in ${Math.ceil((48 * 3600_000 - newestProbeAgeMs) / 3600_000)}h (v10.9.3 hysteresis)` };
    }
    if (exp < -2) {
      const newestSettleAgeMs = Date.now() - new Date(strat[0]!.createdAt).getTime();
      if (newestSettleAgeMs < 24 * 3600_000) return { ok: false, reason: `${strategy} realized expectancy ${exp.toFixed(1)}%/trade (n=${strat.length} EPOCH-2 rolling) < −2% — strategy suppressed (profit-first gate) · SQN ${sSq.sqn}` };
      // window frozen ≥24h — starvation escape: bounded probes resume so the strategy can prove regime truth
    }
    return { ok: true, probe: true }; // bounded half-size probe (MG-PROBE ×0.5)
  }
  return { ok: true };
}

// ── v8.2 SHADOW SWEEP — keeps the decision-border gauge LIVE between real
// gate evaluations (autoSpawn pauses at position capacity, but the operator's
// gauge must not freeze). A rotating batch runs the SAME scoring + surcharge
// chain as evaluate() (cache peeks only — getKlines is TTL-cached) and the
// verdicts are journaled with source "shadow": telemetry, never deploy
// attempts, never regime-veto fireEvents. Deduped inside gate-journal.
let shadowCursor = 0;
let shadowInFlight = false;
const lastShadowAt = new Map<string, number>();
const SHADOW_SPACING_MS = 150_000; // per symbol — keep the ring clean
async function shadowGateSweep(assets: MarketAsset[]): Promise<void> {
  if (shadowInFlight || assets.length === 0) return;
  shadowInFlight = true;
  try {
    const gate = await getGateSettings();
    const eff = await getEffectiveWeights();
    const weights = Object.keys(eff.weights).length ? (eff.weights as FactorWeights) : undefined;
    const BATCH = 6;
    const batch: MarketAsset[] = [];
    for (let i = 0; i < Math.min(BATCH, assets.length); i++) batch.push(assets[(shadowCursor + i) % assets.length]!);
    shadowCursor = (shadowCursor + batch.length) % assets.length;
    const now = Date.now();
    const fresh = batch.filter((a) => now - (lastShadowAt.get(a.symbol) ?? 0) > SHADOW_SPACING_MS);
    if (fresh.length === 0) return;
    const rows: Array<Omit<GateSample, "at" | "best" | "band" | "gap"> & { passed: boolean }> = [];
    await Promise.all(
      fresh.map(async (asset) => {
        try {
          const candles = await getKlines(asset.symbol);
          if (!candles) return;
          const snap = buildSnapshot(asset.symbol, candles);
          if (!snap) return;
          const conf = scoreConfluence(snap, weights);
          const regime = getRegimeCached(asset.symbol, candles);
          const ruling = regimeRuling(regime, conf.direction, conf.strategy, gate.regimeGuard);
          if (!ruling.ok) return; // the real gate refuses pre-score — nothing to gauge
          // same surcharge chain as evaluate() (mirrored; all cache reads)
          let thrAdj = ruling.thrAdj;
          const thr: ThrBreakdown = { regime: ruling.thrAdj, spill: 0, chase: 0, mtf: 0, liq: 0 };
          if (gate.regimeGuard >= 2) {
            const spill = btcSpilloverThrAdj(peekRegime("BTCUSDT"), asset.symbol, conf.direction);
            if (spill.adj !== 0) {
              thrAdj += spill.adj;
              thr.spill += spill.adj;
            }
          }
          if (gate.chaseThrAdj > 0 && conf.direction === "LONG" && candles.length >= 16) {
            const b5 = candles.slice(-5);
            const burstPct = ((b5[b5.length - 1]!.close - b5[0]!.open) / b5[0]!.open) * 100;
            let atrSum = 0;
            for (let i = candles.length - 14; i < candles.length; i++) {
              const c = candles[i]!, p = candles[i - 1]!;
              atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
            }
            const atrPctQuick = (atrSum / 14 / candles[candles.length - 1]!.close) * 100;
            if (burstPct >= Math.max(1.5, 1.5 * atrPctQuick)) {
              thrAdj += gate.chaseThrAdj;
              thr.chase += gate.chaseThrAdj;
            }
          }
          const mtf = peekSymbolFlow(asset.symbol);
          if (mtf && Math.abs(mtf.netScore) >= 40) {
            const aligned = Math.sign(mtf.netScore) === (conf.direction === "LONG" ? 1 : -1);
            if (!aligned) {
              thrAdj += 5;
              thr.mtf += 5;
            }
            // v8.4 R4 VETO-ONLY: the aligned −4 discount is retired here too —
            // the shadow sweep must mirror the live gate's threshold chain.
          }
          const volRow = peekVolForecast(asset.symbol);
          const heat = peekLiqHeat(asset.symbol);
          if (heat && heat.clusters.length > 0) {
            const reach = Math.max(0.5, (volRow?.atr15mPct ?? 1) * 0.5);
            const below = heat.nearestBelow;
            const above = heat.nearestAbove;
            if (conf.direction === "LONG" && below && Math.abs(below.distPct) <= reach) {
              thrAdj += 4;
              thr.liq += 4;
            } else if (conf.direction === "LONG" && above && Math.abs(above.distPct) <= reach) {
              thrAdj -= 3;
              thr.liq -= 3;
            } else if (conf.direction === "SHORT" && above && Math.abs(above.distPct) <= reach) {
              thrAdj += 4;
              thr.liq += 4;
            } else if (conf.direction === "SHORT" && below && Math.abs(below.distPct) <= reach) {
              thrAdj -= 3;
              thr.liq -= 3;
            }
          }
          const adjScore = conf.score >= 0 ? conf.score + ruling.scoreAdj : conf.score - ruling.scoreAdj;
          const effMin = Math.max(12, gate.minScore + thrAdj);
          const ranked = [...conf.votes].sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote));
          const dirSign = conf.direction === "LONG" ? 1 : -1;
          rows.push({
            symbol: asset.symbol,
            direction: conf.direction,
            strategy: conf.strategy,
            score: adjScore,
            effMin,
            baseMin: gate.minScore,
            thr,
            confirms: ranked.filter((v) => v.vote * dirSign > 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
            opposes: ranked.filter((v) => v.vote * dirSign < 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
            notes: "SHADOW-SWEEP — tick rotation telemetry, not a deploy attempt",
            source: "shadow",
            passed: Math.abs(adjScore) >= effMin,
          });
          lastShadowAt.set(asset.symbol, Date.now());
        } catch {
          /* best-effort */
        }
      })
    );
    if (rows.length > 0) {
      void recordGateSamples(rows).catch(() => undefined);
      // v8.2 SHADOW-VETO — shadow-sweep rows reach the fence too (coverage while
      // autoSpawn pauses at capacity); the adjudicator self-budgets and dedups.
      void offerFenceAdjudication(rows).catch(() => undefined);
      // v10.13 NEAR-MISS TIER S — score-band rejects (0.85-1.0×effMin) feed the
      // paper evidence queue (top-1, rails in near-miss.ts; proposal msg 3677,
      // operator APPROVE 2026-09-18T18:58Z).
      void nearMissCaptureScore(rows).catch(() => undefined);
    }
  } finally {
    shadowInFlight = false;
  }
}

// ── deployment ────────────────────────────────────────────────
// v9.1 CALIBRATION CAPTURE AUTHORITY (operator mandate 2026-09-13):
//  · opts.calCapture     — RAW-CAL record: issue the signal WITHOUT quality
//    filters (threshold/memory/strategy/short/learned/flow/ veto layers),
//    tagged RAW-CAL — pure data capture for the AI CALIBRATION book. The
//    honesty rails (feed-fresh guard, sim-price ban) stay HARD: calibration
//    rows must never be born from stale or invented prices.
//  · opts.authorityBypass — PUMP/DUMP RADAR direct authority (EngineSetting
//    "pump.authority"="direct"): the radar's own evidence conviction (≥78/100
//    across velocity/volume/OI/CVD/whale/liq layers) IS the quality judgment;
//    the generic engine gates no longer re-judge its nominations.
// Both still respect the risk rails that protect the LEDGER itself (max-open
// spacing lives in the callers; risk-overlay cluster joins go HALF-SIZED,
// exactly like operator-forced deploys).

// v10.12 HONEST-SWEEP TELEMETRY (operator APPROVE 2026-09-18 msg 861802411:
// «باید به امتیاز واقعی وصل شود») — the flavor event used to print
// Math.random() filler as "best |score|"; deploySignal() now records the REAL
// sweep outcome here (max |adjScore| across evaluated candidates vs the sweep
// MIN_SCORE) and the flavor event reads it. null until the first sweep boots.
let lastSweepBest: { at: number; best: number; minScore: number; candidates: number } | null = null;

export async function deploySignal(symbol?: string, directionHint?: "LONG" | "SHORT", opts?: { forced?: boolean; focusSymbol?: string; triggerTag?: string; extraTags?: string[]; authorityBypass?: boolean; calCapture?: boolean; ttlMinutes?: number; ttlNoExtend?: boolean; refPrice?: number; chaseCapPct?: number }): Promise<{ signal?: Signal; error?: string; status?: number }> {
  const gate = await getGateSettings();
  const eff = await getEffectiveWeights();
  const weights = Object.keys(eff.weights).length ? (eff.weights as FactorWeights) : undefined;

  const assets = await db.marketAsset.findMany({ orderBy: { volume24h: "desc" } });
  if (assets.length === 0) return { error: "universe warming up — retry shortly", status: 503 };

  // ── v6.7 FEED-FRESH DEPLOY GUARD (operator-approved package 2026-09-08) ──
  // The supervisor caught deployments landing while the market feed ran 19–21
  // consecutive failures — deploying on stale data is simulation-adjacent and
  // violates the honesty contract. Auto/trigger-driven deploys are BLOCKED
  // while the feed is degraded (≥3 consecutive failures or no successful
  // fetch for >3min). Operator-forced deploys bypass (explicit human override,
  // audited in the SYSTEM event log).
  const feed = getFeedStatus();
  const feedStale = feed.consecutiveFailures >= 3 || (feed.lastOkAt !== null && Date.now() - feed.lastOkAt > 180_000);
  if (feedStale && !opts?.forced) {
    if (Date.now() - lastFeedGuardEventAt > 600_000) {
      lastFeedGuardEventAt = Date.now();
      await fireEvent(null, null, "SYSTEM", "warn", `FEED-FRESH DEPLOY GUARD: deployment blocked — market feed degraded (${feed.consecutiveFailures} consecutive failures, last ok ${feed.lastOkAt ? `${Math.round((Date.now() - feed.lastOkAt) / 1000)}s ago` : "never"}). No signals on stale data.`);
    }
    return { error: `feed-fresh guard: market feed degraded (${feed.consecutiveFailures} failures, last ok ${feed.lastOkAt ? `${Math.round((Date.now() - feed.lastOkAt) / 1000)}s ago` : "never"}) — no signals on stale data`, status: 503 };
  }

  // scan candidates: confluence across tracked markets (focusSymbol = event-driven single-symbol evaluation)
  // v5.1: PARALLEL with bounded concurrency — the domain is now up to 64 perps
  const candidates: Array<{ asset: MarketAsset; conf: Awaited<ReturnType<typeof scoreConfluence>>; regimeTag: string; sizeMult: number; slMult: number; regimeAdj: number; regimeNote: string | null; thrAdj: number; thrParts: ThrBreakdown; mtf: MtfRollup | null; scanPrice: number }> = [];
  const openSymbols = new Set((await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true } })).map((s) => s.symbol));
  const liveSymbols = await fetchFuturesSymbols().catch(() => new Set<string>());

  // v6.2 SIM-PRICE DEPLOY BAN (architecture review P1): when an asset's feed
  // degrades to "sim" (drift fallback), its price is NOT real — deploying a
  // live signal against invented prices would violate the honesty contract.
  // Operator-forced deploys bypass (explicit operator override, audited).
  const simBanned = assets.filter((a) => a.source !== "live" && !openSymbols.has(a.symbol)).map((a) => a.symbol);
  if (simBanned.length > 0 && Date.now() - lastSimBanEventAt > 600_000) {
    lastSimBanEventAt = Date.now();
    await fireEvent(null, null, "SYSTEM", "warn", `SIM-PRICE DEPLOY BAN: ${simBanned.slice(0, 6).join(", ")}${simBanned.length > 6 ? ` +${simBanned.length - 6}` : ""} excluded from auto-deployment — feed degraded (sim), no signals on invented prices`);
  }

  const pool = assets.filter((asset) => {
    if (opts?.focusSymbol) return asset.symbol === opts.focusSymbol;
    if (openSymbols.has(asset.symbol)) return false; // dedup open-symbol
    if (liveSymbols.size > 0 && !liveSymbols.has(asset.symbol)) return false; // futures-only deployments
    if (isCounterCascadeSuppressed(asset.symbol)) return false; // L3 anti-cascade veto window
    if (!opts?.forced && asset.source !== "live") return false; // v6.2 sim-price ban
    return true;
  });

  const CONCURRENCY = 6;
  async function evaluate(asset: MarketAsset): Promise<void> {
    const candles = await getKlines(asset.symbol);
    if (!candles) return;
    const snap = buildSnapshot(asset.symbol, candles);
    if (!snap) return;
    const conf = scoreConfluence(snap, weights);
    // LAYER-0 regime ruling (v5.0 trigger hierarchy) — v6.3: guard-aware
    const regime = getRegimeCached(asset.symbol, candles);
    const ruling = regimeRuling(regime, conf.direction, conf.strategy, gate.regimeGuard);
    if (!ruling.ok) {
      void recordGateBlock({ gate: "REGIME", symbol: asset.symbol, direction: conf.direction, reason: ruling.reason ?? "regime ruling veto" });
      if (opts?.focusSymbol) await fireEvent(null, asset.symbol, "ENGINE", "info", `Regime gate: ${ruling.reason}`);
      return;
    }
    // v6.3 BTC-spillover surcharge (guard L2): alts fighting BTC's primary trend
    // pay a threshold premium — marginal counter-BTC setups fail the gate.
    let thrAdj = ruling.thrAdj;
    // v8.2 GATE GAUGE — per-candidate breakdown of every threshold modifier so
    // the journal can attribute a reject/confirm to its exact source.
    const thrParts: ThrBreakdown = { regime: ruling.thrAdj, spill: 0, chase: 0, mtf: 0, liq: 0, lesson: 0 };
    let spillNote: string | null = null;
    if (gate.regimeGuard >= 2) {
      const btcRegime = peekRegime("BTCUSDT");
      const spill = btcSpilloverThrAdj(btcRegime, asset.symbol, conf.direction);
      if (spill.adj !== 0) {
        thrAdj += spill.adj;
        thrParts.spill += spill.adj;
        spillNote = spill.reason;
      }
    }
    // ── v6.7.2 LONG-CHASE ASYMMETRY GUARD (DURATION-LAB evidence 2026-09-08) ──
    // All 9 real fast-kills (<15m straight-to-SL) were LONG entries made while
    // the tape was already extended — the last-5-bar move ≥1.5×ATR. Extended
    // long candidates now pay a threshold surcharge so MARGINAL chases fail
    // the gate before the flow stage even runs. Measured from the same 15m
    // candles the candidate was scored on — no extra fetches.
    let chaseNote: string | null = null;
    if (gate.chaseThrAdj > 0 && conf.direction === "LONG" && candles.length >= 16) {
      const b5 = candles.slice(-5);
      const burstPct = ((b5[b5.length - 1]!.close - b5[0]!.open) / b5[0]!.open) * 100;
      let atrSum = 0;
      for (let i = candles.length - 14; i < candles.length; i++) {
        const c = candles[i]!, p = candles[i - 1]!;
        atrSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      }
      const atrPctQuick = (atrSum / 14 / candles[candles.length - 1]!.close) * 100;
      if (burstPct >= Math.max(1.5, 1.5 * atrPctQuick)) {
        thrAdj += gate.chaseThrAdj;
        thrParts.chase += gate.chaseThrAdj;
        chaseNote = `LONG-chase guard: last-5-bar move +${burstPct.toFixed(2)}% ≥ 1.5×ATR(${atrPctQuick.toFixed(2)}%) → eff threshold +${gate.chaseThrAdj}`;
      }
    }
    // ── v8.0 MULTI-TF FLOW BOARD GUARD (EPOCH-2 operator mandate) ──
    // The research doctrine: HTF carries the bias. A candidate fighting a
    // |net|≥40 board pays +5 on its EFFECTIVE threshold; one riding a board
    // with ≥3/4 aligned TFs earns a −4 discount. The cached rollup costs zero
    // fetches — the scanner already measured it on the tick rotation.
    const mtf = peekSymbolFlow(asset.symbol);
    let mtfNote: string | null = null;
    if (mtf && Math.abs(mtf.netScore) >= 40) {
      const dirSign = conf.direction === "LONG" ? 1 : -1;
      const aligned = Math.sign(mtf.netScore) === dirSign;
      if (!aligned) {
        thrAdj += 5;
        thrParts.mtf += 5;
        mtfNote = `MTF-CONFLICT: flow board ${mtf.netScore} against ${conf.direction} (${mtf.netBias}, ${mtf.alignment}/4 TFs) → eff +5`;
      } else {
        // v8.4 R4 VETO-ONLY (module-performance audit 2026-09-11): the
        // aligned-board −4 threshold discount is RETIRED — the deploy-flow
        // ledger shows CONFIRMS behaved as an anti-signal (tp 12.5%,
        // Σ−124.4%). Flow may only raise thresholds/veto, never lower them.
        // Alignment still ships as the MTF-ALIGNED telemetry tag.
        mtfNote = `MTF-ALIGNED (telemetry only): flow board ${mtf.netScore} with ${conf.direction} (${mtf.alignment}/4 TFs) — R4 veto-only, no threshold discount`;
      }
    }
    // ── v8.1 P1 LIQUIDATION-HEAT PROXIMITY GUARD (heatmap doctrine) ──
    // Clusters BELOW price = long-liq flush fuel (magnet DOWN): a NEW long with
    // a dense cluster within reach eats the flush first → +4 threshold. Clusters
    // ABOVE = short-liq squeeze fuel (magnet UP): for a long that is the classic
    // sweep-then-pump reversal fuel → −3 discount. Mirrored for SHORTS. Zero
    // fetches — the heat/OI/vol caches warm on the tick rotation; cold symbols
    // warm fire-and-forget and gate on their NEXT evaluation (never invented).
    const volRowEv = peekVolForecast(asset.symbol);
    let liqNote: string | null = null;
    const heat = peekLiqHeat(asset.symbol);
    if (heat && heat.clusters.length > 0) {
      const reach = Math.max(0.5, (volRowEv?.atr15mPct ?? 1) * 0.5); // 0.5×ATR band, 0.5% floor
      const below = heat.nearestBelow;
      const above = heat.nearestAbove;
      if (conf.direction === "LONG" && below && Math.abs(below.distPct) <= reach) {
        thrAdj += 4;
        thrParts.liq += 4;
        liqNote = `LIQ-HEAT-BELOW: est ${below.estUsdM}M long-liq cluster ${Math.abs(below.distPct).toFixed(2)}% below price (reach ${reach.toFixed(2)}%) → eff +4 — flush-through risk first`;
      } else if (conf.direction === "LONG" && above && Math.abs(above.distPct) <= reach) {
        thrAdj -= 3;
        thrParts.liq -= 3;
        liqNote = `LIQ-FUEL-ABOVE: est ${above.estUsdM}M short-liq cluster ${Math.abs(above.distPct).toFixed(2)}% above price → eff −3 — squeeze fuel in trade direction`;
      } else if (conf.direction === "SHORT" && above && Math.abs(above.distPct) <= reach) {
        thrAdj += 4;
        thrParts.liq += 4;
        liqNote = `LIQ-HEAT-ABOVE: est ${above.estUsdM}M short-liq cluster ${Math.abs(above.distPct).toFixed(2)}% above price (reach ${reach.toFixed(2)}%) → eff +4 — squeeze-through risk first`;
      } else if (conf.direction === "SHORT" && below && Math.abs(below.distPct) <= reach) {
        thrAdj -= 3;
        thrParts.liq -= 3;
        liqNote = `LIQ-FUEL-BELOW: est ${below.estUsdM}M long-liq cluster ${Math.abs(below.distPct).toFixed(2)}% below price → eff −3 — flush fuel in trade direction`;
      }
      if (liqNote && !heat.oiScaled) liqNote += " (unscaled estimate — OI board warming)";
    } else {
      void getLiqHeat(asset.symbol).catch(() => undefined);
    }
    // ── v9.3 LESSON GATE (operator mandate ب) ──
    // Deterministic deep-learn injection: fresh (≤6h) lessons with confidence ≥60
    // speak as a signed threshold term — SL-scope lessons RAISE the gate (never
    // repeat a measured loss pattern), TP3_FULL lessons may lower it slightly.
    // Clamped [−3,+8], cached 5min, zero LLM calls on the hot path. The term
    // rides the thr breakdown so every gate journal row shows WHICH lesson
    // moved the threshold and by how much.
    const lesson = await lessonThrAdj();
    if (lesson.adj !== 0) {
      thrAdj += lesson.adj;
      thrParts.lesson = (thrParts.lesson ?? 0) + lesson.adj;
    }
    const fullNote = [ruling.reason ?? null, spillNote, chaseNote, mtfNote, liqNote, lesson.note].filter(Boolean).join(" · ") || null;
    candidates.push({ asset, conf, regimeTag: ruling.tag, sizeMult: ruling.sizeMult, slMult: ruling.slMult, regimeAdj: ruling.scoreAdj, regimeNote: fullNote, thrAdj, thrParts, mtf, scanPrice: asset.price });
  }

  for (let i = 0; i < pool.length; i += CONCURRENCY) {
    await Promise.all(pool.slice(i, i + CONCURRENCY).map(evaluate));
  }

  candidates.sort((a, b) => Math.abs(b.conf.score) - Math.abs(a.conf.score));
  // regime scoreAdj (CHOP breakout penalty / trend alignment bonus) applied BEFORE the threshold
  const adjusted = candidates.map((c) => ({ ...c, adjScore: c.conf.score >= 0 ? c.conf.score + c.regimeAdj : c.conf.score - c.regimeAdj }));
  // v6.3 DYNAMIC MIN_SCORE — the threshold is no longer one flat number: each
  // candidate's EFFECTIVE threshold = base + regime thrAdj (chop surcharge,
  // trend alignment discount, vol tax, BTC spillover at guard L2).
  // v10.11 STRAT-PROBATION double-confirm: a strategy on expectancy probation
  // (book-wide EB-shrunk UCB still negative at n≥15) must beat a +5 higher
  // effective bar — soft strategy-level valve for bleeds the per-combo memory
  // gate cannot see. Skipped under capture/authority bypass (never fights the
  // operator's own capture mandate).
  const bypassQuality = !!(opts?.forced || opts?.authorityBypass || opts?.calCapture);
  const probStrats = bypassQuality ? new Set<string>() : await probationStrategies();
  const withEff = adjusted.map((c) => ({ ...c, effMin: Math.max(12, gate.minScore + c.thrAdj + (probStrats.has(c.conf.strategy) ? probationEffMinBonus() : 0)) }));
  // v10.12 HONEST-SWEEP TELEMETRY — record the real best |adjScore| of this sweep
  lastSweepBest = { at: Date.now(), best: withEff.length ? Math.max(...withEff.map((c) => Math.abs(c.adjScore))) : 0, minScore: gate.minScore, candidates: withEff.length };
  let eligibleFinal = withEff.filter((c) => Math.abs(c.adjScore) >= c.effMin);
  // v9.1 CALIBRATION CAPTURE: when every threshold says no and the caller
  // carries capture authority, the BEST measured candidate of the scan is
  // issued anyway — the whole point is to sample the flow the filters reject.
  // calCapture → strongest scan row overall; authorityBypass (radar) → the
  // strongest row of the focus symbol only.
  if (eligibleFinal.length === 0 && bypassQuality) {
    const fallbackPool = opts?.calCapture ? withEff : withEff.filter((c) => c.asset.symbol === opts?.focusSymbol);
    const fallback = fallbackPool.sort((a, b) => Math.abs(b.adjScore) - Math.abs(a.adjScore))[0] ?? null;
    if (fallback) eligibleFinal = [fallback];
  }

  // ── v8.2 GATE GAUGE — journal every threshold verdict BEFORE the early
  // returns: the "no qualifying setup" scans are exactly where the boundary
  // band lives. Each sample carries the signed votes split into confirms vs
  // opposes, the thr-modifier breakdown and the distance-to-gate. Dedup is
  // internal (BOUNDARY 60s / REJECT 150s per symbol|direction).
  const passedSet = new Set(eligibleFinal);
  const gateSource = (opts?.forced ? "forced" : opts?.triggerTag ? "trigger" : "auto-scan") as "forced" | "trigger" | "auto-scan";
  const gateRows = withEff.map((c) => {
    const dirSign = c.conf.direction === "LONG" ? 1 : -1;
    const ranked = [...c.conf.votes].sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote));
    return {
      symbol: c.asset.symbol,
      direction: c.conf.direction,
      strategy: c.conf.strategy,
      score: c.adjScore,
      effMin: c.effMin,
      baseMin: gate.minScore,
      thr: c.thrParts,
      confirms: ranked.filter((v) => v.vote * dirSign > 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
      opposes: ranked.filter((v) => v.vote * dirSign < 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
      notes: c.regimeNote,
      source: gateSource,
      passed: passedSet.has(c),
    };
  });
  void recordGateSamples(gateRows).catch(() => undefined);
  // v8.2 SHADOW-VETO — offer the fence candidates (hair-thin passes gap 0..+3,
  // near-miss rejects gap −8..0) to the AI-core adjudicator. Fire-and-forget:
  // budgeted (12/h), spaced (≥90s), deduped (30min per symbol|direction).
  void offerFenceAdjudication(gateRows).catch(() => undefined);
  // v10.13 NEAR-MISS TIER S — same batch feeds the score-band paper queue.
  void nearMissCaptureScore(gateRows).catch(() => undefined);

  if (eligibleFinal.length === 0) {
    const best = withEff[0];
    return { error: `no qualifying setup — best |score| ${best ? Math.abs(best.adjScore).toFixed(0) : 0} vs dynamic MIN_SCORE ${gate.minScore}${best && best.thrAdj !== 0 ? `${best.thrAdj > 0 ? "+" : ""}${best.thrAdj} regime adj → eff ${best.effMin}` : ""} (${describeGate(gate)})${opts?.triggerTag ? " · trigger-driven evaluation" : ""}`, status: 409 };
  }

  // memory gate — v9.1: quality layer, skipped under capture/authority bypass
  const mgProbeKeys = new Set<string>(); // v10.9.3 — candidates admitted as MG-PROBE half-size re-entry
  const memoryPassed: typeof eligibleFinal = [];
  for (const c of eligibleFinal) {
    if (bypassQuality) {
      memoryPassed.push(c);
      continue;
    }
    const mem = await realizedEdgeFilter(c.asset.symbol, c.conf.strategy);
    if (mem.ok) {
      if (mem.probe) mgProbeKeys.add(`${c.asset.symbol}:${c.conf.strategy}`);
      memoryPassed.push(c);
    }
    else {
      void recordGateBlock({ gate: "MEMORY", symbol: c.asset.symbol, direction: c.conf.direction, reason: mem.reason ?? "realized-edge suppression" });
      await fireEvent(null, c.asset.symbol, "ENGINE", "info", `Memory gate: skipped ${c.asset.symbol} — ${mem.reason}`);
      // v10.14 GATE-NEAR-MISS (supervisor proposal msg 3920, operator APPROVE
      // 2026-09-19T08:56Z msg 861802419): the suppressed candidate PASSED the
      // score gate — capture it as a paper trade so the memory gate's
      // opportunity cost is measured, not assumed. The 30-settle cohort
      // expectancy decides keep-vs-SQN-upgrade (advisor path). Rails live in
      // near-miss.ts (8/day · 2h dedup · 16 open per tier) — fail-open.
      void nearMissCaptureGate({ symbol: c.asset.symbol, direction: c.conf.direction, strategy: c.conf.strategy, reason: mem.reason ?? "realized-edge suppression" }).catch(() => undefined);
    }
  }
  if (memoryPassed.length === 0) return { error: "all qualifying setups suppressed by memory gate (realized <25%)", status: 409 };

  // ── v6.5/v6.6 STRATEGY GUARD (perf forensics 2026-09-07; operator-approved trial 2026-09-08) ──
  // Realized evidence: BREAKOUT = 49 settled · 14.3% win · −$30.98 — worse than the
  // entire book's net loss; every other strategy is net-positive combined.
  // breakoutGuard: 0 normal · 1 CONDITIONAL (chop still vetoed by regimeGuard L1,
  // non-chop BREAKOUT deploys at HALF size, tagged BO-EXP for the A/B ledger) ·
  // 2 veto. The advisor tracks the BO-EXP cohort: ≥20 settled with PF>1.2 keeps
  // the trial alive, PF≤1.2 proposes reverting to veto. Operator-forced bypasses.
  const boGuard = gate.breakoutGuard;
  const strategyPassed = boGuard >= 2 && !opts?.forced && !bypassQuality ? memoryPassed.filter((c) => c.conf.strategy !== "BREAKOUT") : memoryPassed;
  const boVetoed = memoryPassed.length - strategyPassed.length;
  if (boVetoed > 0 && Date.now() - lastStratGateEventAt > 600_000) {
    lastStratGateEventAt = Date.now();
    await fireEvent(null, null, "ENGINE", "info", `Strategy guard: ${boVetoed} BREAKOUT setup${boVetoed > 1 ? "s" : ""} vetoed (breakoutGuard=${boGuard}) — realized evidence 14.3% win / −$30.98; advisor may propose re-enable via breakoutGuard knob`);
    void recordGateBlock({ gate: "STRATEGY", symbol: null, direction: null, reason: `BREAKOUT veto ×${boVetoed} (breakoutGuard=${boGuard}) — realized 14.3% win / −$30.98` });
  }
  if (strategyPassed.length === 0) return { error: `all qualifying setups vetoed by STRATEGY GUARD (BREAKOUT, breakoutGuard=${boGuard} — realized 14.3% win / −$30.98)`, status: 409 };

  // ── v8.4 R1 SHORT GUARD (module-performance audit 2026-09-11) ──
  // Evidence: the SHORT book won 11.1% and burned −$9.69 of the −$9.95 total
  // net — the single largest damage cohort. shortGuard: 0 normal · 1 a SHORT
  // must ride an ALIGNED HTF flow board (netScore ≤ −40, ≥2/4 TFs agree —
  // fail-closed when the board is cold) · 2 veto ALL auto SHORT deployments
  // until the regime evidence improves. Operator-forced deploys bypass
  // (explicit human override, audited) — the dial lives in gate settings.
  const shortGuardPassed =
    gate.shortGuard === 0 || opts?.forced || bypassQuality
      ? strategyPassed
      : strategyPassed.filter((c) => {
          if (c.conf.direction !== "SHORT") return true;
          if (gate.shortGuard === 2) return false;
          const m = c.mtf;
          return !!(m && m.netScore <= -40 && m.alignment >= 2);
        });
  const sgVetoed = strategyPassed.length - shortGuardPassed.length;
  if (sgVetoed > 0) {
    void recordGateBlock({ gate: "SHORT-GUARD", symbol: null, direction: "SHORT", reason: `SHORT veto ×${sgVetoed} (shortGuard=${gate.shortGuard}) — audit: WR 11.1%, −$9.69 of −$9.95 net` });
    if (Date.now() - lastShortGuardEventAt > 600_000) {
      lastShortGuardEventAt = Date.now();
      await fireEvent(null, null, "ENGINE", "warn", `R1 SHORT GUARD: ${sgVetoed} SHORT setup${sgVetoed > 1 ? "s" : ""} vetoed (shortGuard=${gate.shortGuard}${gate.shortGuard === 1 ? " — HTF flow board not aligned" : ""}) — audit evidence: SHORT book 11.1% win / −$9.69 of −$9.95 net. Relax via shortGuard 1 (HTF-align) or 0 (off).`);
    }
  }
  if (shortGuardPassed.length === 0) return { error: `all qualifying setups vetoed by R1 SHORT GUARD (shortGuard=${gate.shortGuard} — audit: SHORT WR 11.1%, −$9.69 of −$9.95 net)`, status: 409 };

  // ── v10.15 DISLOCATION-GATE (SUPERVISOR proposal 2026-09-19T10:54Z, operator
  // APPROVE «تایید پیشنهادهای سوپروایزر کامل و مهندسی انجام بده» 2026-09-19T11:36Z msg 861802422) ──
  // Evidence: persistent cross-exchange venue dislocation concentrates on the
  // big-loss symbols (GUSDT 338-366bps sustained, STRK 27-36, AR 14-24,
  // HYPERLIQUID recurring outlier) — a stretched venue price is adverse
  // selection at entry, and until now no venue-consistency check existed
  // (CHASE-ADJ is order-level only). Reuses the existing 4-venue consensus
  // telemetry (maxDevBps, zero new feeds); the decision reads the ROLLING-5
  // SCAN median. median ≥ skipBps → skip; ≥ warnBps → admitted at HALF margin
  // downstream (DISLOCATION-HALF). Operator-forced deploys bypass (audited).
  const dislocationPassed =
    gate.dislocationGate === 0 || opts?.forced || bypassQuality
      ? shortGuardPassed
      : shortGuardPassed.filter((c) => {
          const med = rollingDislocationBps(c.asset.symbol, c.asset.maxDevBps);
          if (med >= gate.dislocationSkipBps) {
            void recordGateBlock({ gate: "DISLOCATION", symbol: c.asset.symbol, direction: c.conf.direction, reason: `venue dislocation median ${med.toFixed(1)}bps ≥ skip ${gate.dislocationSkipBps}bps (rolling-5) — adverse-selection entry avoided` });
            return false;
          }
          return true;
        });
  const dislocVetoed = shortGuardPassed.length - dislocationPassed.length;
  if (dislocVetoed > 0 && Date.now() - lastDislocationEventAt > 600_000) {
    lastDislocationEventAt = Date.now();
    const worst = shortGuardPassed.filter((c) => !dislocationPassed.includes(c)).sort((x, y) => (y.asset.maxDevBps ?? 0) - (x.asset.maxDevBps ?? 0))[0];
    await fireEvent(null, worst?.asset.symbol ?? null, "ENGINE", "warn", `DISLOCATION-GATE: ${dislocVetoed} setup${dislocVetoed > 1 ? "s" : ""} skipped — venue-dislocation median ≥ ${gate.dislocationSkipBps}bps (rolling-5${worst ? ` · worst ${worst.asset.symbol} ${(worst.asset.maxDevBps ?? 0).toFixed(1)}bps` : ""}). Adjust via dislocationWarnBps/dislocationSkipBps knobs.`);
  }
  if (dislocationPassed.length === 0) return { error: `all qualifying setups vetoed by DISLOCATION-GATE (venue-dislocation median ≥ ${gate.dislocationSkipBps}bps rolling-5 — adverse-selection entry avoided)`, status: 409 };


  // LEARNED GATE (v5.0): live auto-deployment requires learned evidence
  // v8.4.1 G4 RECOVERY PROBE (operator mandate «انجام بده» 2026-09-11): a fully
  // closed gate that also blocks every deploy can never collect fresh settles
  // (the G1 rolling window stays static) — the deadlock re-forms one level
  // deeper. When the learned gate blocks AND the deploy drought ≥2h, allow ONE
  // bounded probe through: all other guards (strategy, R1 SHORT-GUARD, flow,
  // shadow-veto, risk overlay) still apply upstream, the probe runs at HALF
  // margin and is tagged G4-PROBE so its settles are auditable as a cohort.
  let probeBypass = false;
  if (!opts?.forced && !directionHint && !bypassQuality) {
    const learned = await learnedGateAllows();
    if (!learned.allowed) {
      let probeAllowed = false;
      if (gate.probeDeploys > 0) {
        const lastSig = await db.signal.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }).catch(() => null);
        const droughtMs = lastSig ? Date.now() - new Date(lastSig.createdAt).getTime() : Number.POSITIVE_INFINITY;
        if (droughtMs >= 2 * 3600_000) {
          probeAllowed = true;
          probeBypass = true;
          await fireEvent(null, null, "ENGINE", "info", `G4 RECOVERY PROBE: learned gate closed (${learned.reason}) — deploy drought ${droughtMs === Number.POSITIVE_INFINITY ? "∞" : Math.floor(droughtMs / 3600_000) + "h"} ≥ 2h — ONE bounded probe deploy allowed (half margin, LONG-only, every other guard live) to recharge the G1 rolling window with fresh R-protected settles.`);
        } else if (Date.now() - lastLearnedGateEventAt > 600_000) {
          lastLearnedGateEventAt = Date.now();
          await fireEvent(null, null, "ENGINE", "warn", `Learned gate: auto-deployment SUPPRESSED — ${learned.reason}. G4 probe re-arms in ${Math.ceil((2 * 3600_000 - droughtMs) / 60_000)}min; operator-forced deploys bypass.`);
        }
      } else if (Date.now() - lastLearnedGateEventAt > 600_000) {
        lastLearnedGateEventAt = Date.now();
        await fireEvent(null, null, "ENGINE", "warn", `Learned gate: auto-deployment SUPPRESSED — ${learned.reason}. The AUTO-LEARNER re-runs every 6h; operator-forced deploys bypass (G4 probe OFF).`);
      }
      if (!probeAllowed) {
        void recordGateBlock({ gate: "LEARNED", symbol: null, direction: null, reason: learned.reason });
        return { error: `learned gate: ${learned.reason}`, status: 409 };
      }
    }
  }

  // flow shortlist
  // v8.4.1 F1 FIX: the shortlist must flow from shortGuardPassed — it was built
  // from strategyPassed, so SHORTs already vetoed by the R1 SHORT-GUARD could
  // still be chosen and deployed (the guard only affected the empty-book check).
  // v10.15: source is now dislocationPassed (SHORT-GUARD → DISLOCATION-GATE chain).
  // v8.4.1 G4: a probe deploy is strictly LONG-only regardless of shortGuard.
  const shortlist = dislocationPassed.slice(0, gate.flowShortlist).filter((c) => !probeBypass || c.conf.direction === "LONG");
  await ensureFlow(shortlist.map((c) => c.asset.symbol));
  let vetoed = 0;
  let chosen: (typeof shortlist)[number] | null = null;
  let chosenFlow: Awaited<ReturnType<typeof scoreFlow>> | null = null;
  for (const c of shortlist) {
    const candles = klineCache.get(c.asset.symbol)?.candles;
    const price1hAgoPct = candles && candles.length >= 5 ? ((candles[candles.length - 1]!.close - candles[candles.length - 5]!.close) / candles[candles.length - 5]!.close) * 100 : null;
    const flow = await scoreFlow(c.asset.symbol, c.conf.direction, price1hAgoPct);
    if (!opts?.forced && !bypassQuality && flow.score <= -gate.flowVetoScore) {
      vetoed++;
      void recordGateBlock({ gate: "FLOW", symbol: c.asset.symbol, direction: c.conf.direction, reason: `flow ${flow.verdict} ${flow.score}/25 · ${flow.reasons[0] ?? ""}` });
      await fireEvent(null, c.asset.symbol, "ENGINE", "info", `Flow gate: vetoed ${c.asset.symbol} — flow ${flow.verdict} ${flow.score}/25 · ${flow.reasons[0] ?? ""}`);
      continue;
    }
    if (!chosen) {
      chosen = c;
      chosenFlow = flow;
    }
  }

  if (!chosen || !chosenFlow) return { error: `all ${shortlist.length} shortlisted setups vetoed by flow gate`, status: 409 };

  // build the deployment
  const asset = chosen.asset;
  const conf = chosen.conf;
  // VOL-ONSET telemetry tag (contract 2026-09-06: vote 0, never gates/sizes —
  // learning loop decides later whether eruption-context signals outperform)
  const onsetInfo = await onsetTagFor(asset.symbol, klineCache.get(asset.symbol)?.candles).catch(() => null);
  if (onsetInfo?.hot) conf.votes.push({ factor: onsetInfo.tag, vote: 0, detail: onsetInfo.detail });
  const direction = (directionHint ?? conf.direction) as "LONG" | "SHORT";
  const isLong = direction === "LONG";

  // ── v6.7.2 VOL-ONSET RETEST GATE (operator mandate: «هر سه را مهندسی انجام بده») ──
  // DURATION-LAB evidence: the 9 real fast-kills were chase entries into fresh
  // eruption bursts — flow CONFIRMS the burst while it is already terminal.
  // A deployment CHASING a hot (<90min) eruption is now BLOCKED until price has
  // retraced ≥30% of the impulse leg (entry on retest, not on burst). Retested
  // entries earn the VOL-ONSET-RETEST tag so the ledger can A/B the cohort.
  // Counter-eruption deployments (fading the burst) are not gated here.
  // Operator-forced deploys bypass (explicit human override, audited).
  let onsetRetested = false;
  if (gate.onsetRetestGuard >= 1 && onsetInfo?.hot && !opts?.forced && !bypassQuality) {
    const erupUp = onsetInfo.direction === "UP";
    const chasing = (isLong && erupUp) || (!isLong && !erupUp);
    if (chasing) {
      const bars = klineCache.get(asset.symbol)?.candles ?? [];
      const erupTime = Date.now() - onsetInfo.minutesSince * 60_000;
      const post = bars.filter((b) => b.openTime >= erupTime - 15 * 60_000);
      const erupRef = post[0]?.close;
      if (post.length >= 1 && erupRef && erupRef > 0) {
        const extreme = erupUp ? Math.max(...post.map((b) => b.high)) : Math.min(...post.map((b) => b.low));
        const leg = Math.abs(extreme - erupRef);
        if (leg / erupRef >= 0.003) {
          // clean impulse leg ≥0.3% — otherwise the "burst" is noise, don't gate on it
          const retr = leg > 0 ? (erupUp ? extreme - asset.price : asset.price - extreme) / leg : 1;
          if (retr < 0.3) {
            void recordGateBlock({ gate: "ONSET-RETEST", symbol: asset.symbol, direction, reason: `chasing a ${erupUp ? "UP" : "DOWN"} eruption ${onsetInfo.minutesSince.toFixed(0)}m old — ${(retr * 100).toFixed(0)}% retraced, ≥30% required` });
            if (Date.now() - lastRetestGateEventAt > 600_000) {
              lastRetestGateEventAt = Date.now();
              await fireEvent(null, asset.symbol, "ENGINE", "warn", `VOL-ONSET RETEST GATE: ${asset.symbol} ${direction} blocked — chasing a ${erupUp ? "UP" : "DOWN"} eruption ${onsetInfo.minutesSince.toFixed(0)}m old with only ${(retr * 100).toFixed(0)}% retracement (need ≥30%). Entry on retest, not on burst — DURATION-LAB evidence: 9 fast-kills were untested-burst chases.`);
            }
            return { error: `vol-onset retest gate: ${asset.symbol} ${direction} chases a hot ${erupUp ? "UP" : "DOWN"} eruption (${(retr * 100).toFixed(0)}% retraced, ≥30% required) — wait for the retest`, status: 409 };
          }
          onsetRetested = true;
        }
      }
    }
  }

  // v6.4 VOL-CAUSE hook (operator: research top-volatility causes → track →
  // learn → use). When this symbol recently entered MARKET MATRIX top-|Δ24h|
  // with an attributed cause whose LEARNED continuation profile passed the
  // gate (n ≥ 30 · cont ≥ 55% · |mean fwd6h| ≥ 0.12%) AND the deployment
  // direction matches the event direction — conviction +2..4 and sizing
  // ×1.15. Otherwise the cause still ships as a vote-0 telemetry tag.
  const volCause = await volCauseBoost(asset.symbol, direction).catch(() => null);
  if (volCause?.cause) {
    conf.votes.push({
      factor: `VOL-CAUSE:${volCause.cause}`,
      vote: 0,
      detail: volCause.basis === "LEARNED-CONTINUATION" ? `learned continuation profile → +${volCause.boost}` : volCause.detail ?? "telemetry-only",
    });
  }
  // v6.7 SMC-lite sweep telemetry (operator-approved package item ⑥): the last
  // closed bar sweeping prior swing liquidity and rejecting is the classic
  // liquidity-grab print. Aligned sweeps earn the LIQ-SWEEP tag; opposing
  // sweeps still ship as a vote-0 line so the ledger can judge them later.
  const sweepInfo = detectLiquiditySweep(klineCache.get(asset.symbol)?.candles, direction);
  if (sweepInfo.swept) {
    conf.votes.push({ factor: "LIQ-SWEEP", vote: 0, detail: sweepInfo.detail });
  }
  const price = asset.price;
  const entry = price;

  // ── v9.3 ANTI-LATE-ENTRY PRICE GUARD (operator mandate) ──
  // Duration-Lab verdict LATE_ENTRY_CASCADE_CHASE: the real fast-kill cohort
  // NEVER went green — they were entries executed well after detection, buying
  // the top of the cascade. Root cause: NOTHING measured the distance between
  // the detection reference and the actual entry price. Now it is measured:
  // radar cards compare against the track's anchorPrice (the detection instant),
  // scans against the scan-time tick price. If price already ran further than
  // the strategy's chase cap IN THE TRADE DIRECTION, the deploy is refused —
  // execution can no longer enter later than detection. Operator-forced deploys
  // bypass (explicit human override, audited). Every refusal is journaled
  // (gate CHASE-PRICE) so the rejected-chase cohort stays auditable.
  const chaseRef = opts?.refPrice ?? chosen.scanPrice ?? price;
  const chaseCap = opts?.chaseCapPct ?? CHASE_CAP_BY_STRATEGY[conf.strategy] ?? 0.6;
  const chaseDrift = chaseRef > 0 ? ((entry - chaseRef) / chaseRef) * 100 * (isLong ? 1 : -1) : 0;
  if (chaseDrift > chaseCap && !opts?.forced) {
    const reason = `entry ${chaseDrift.toFixed(2)}% past detection ref ${chaseRef} (cap ${chaseCap}% for ${conf.strategy}) — late cascade-chase entry refused`;
    void recordGateBlock({ gate: "CHASE-PRICE", symbol: asset.symbol, direction, reason });
    await fireEvent(null, asset.symbol, "ENGINE", "warn", `ANTI-LATE-ENTRY GUARD: ${direction} ${asset.symbol} deploy refused — ${reason} · Duration-Lab evidence: the fast-kill cohort never went green (LATE_ENTRY_CASCADE_CHASE)`);
    return { error: `anti-late-entry guard: ${asset.symbol} ${direction} entry is ${chaseDrift.toFixed(2)}% past its detection reference (cap ${chaseCap}%) — no cascade chasing`, status: 409 };
  }

  // regime + crowd scaling constants (needed before SL math)
  const slMult = chosen.slMult ?? 1;
  const crowdCut = isCrowdCut(asset.symbol);
  const regimeSize = chosen.sizeMult ?? 1;
  // v10.15 DISLOCATION-GATE warn band: the candidate survived the skip floor —
  // a rolling-5 median still ≥ warnBps means the venue board is stretched but
  // not broken: admit at HALF margin, tagged DISLOCATION-HALF, so the cohort's
  // settles are auditable (same measured-caution pattern as G4-PROBE/MG-PROBE).
  const dislocMedian = rollingDislocationBps(asset.symbol, asset.maxDevBps);
  const dislocationMult = gate.dislocationGate !== 0 && !opts?.forced && !bypassQuality && dislocMedian >= gate.dislocationWarnBps ? 0.5 : 1;

  // ── v8.1 P2 VOLATILITY-SCALED GEOMETRY (vol-forecast.ts) ──
  // The forecast regime scales the risk geometry with the vol the market is
  // ENTERING (bounded ×0.9..×1.15 stop / ±0.2R targets): LOW tightens and
  // stretches, ELEVATED/EXTREME breathe the stop and trim targets. Logged +
  // tagged (VOL-REGIME-* cohorts); null-safe — no forecast, no change.
  const volF = peekVolForecast(asset.symbol);
  const volGeo = volGeometry(volF);
  if (!volF) void getVolBoard([asset.symbol], 1).catch(() => undefined);

  const atrPct = await atrPctOf(asset.symbol);
  // v6.3: stop distance is GOVERNOR-OWNED — slAtrMult (0.8–2.5) scales the ATR
  // multiple; regime slMult still widens for volatility on top; v8.1: the vol
  // regime multiplier rides on top (bounded ×0.9..×1.15).
  const slDistPct = Math.min(5, Math.max(0.7, gate.slAtrMult * atrPct * slMult * volGeo.slMult)) / 100;
  const stopLoss = entry * (isLong ? 1 - slDistPct : 1 + slDistPct);
  const risk = Math.abs(entry - stopLoss);

  // ── v5.4 DYNAMIC RISK:REWARD CALCULATOR (root-cause fix for "R:R always 1:2.6") ──
  // RR was hardcoded at 2.6 for every deployment. It is now computed per-signal
  // from four measured drivers, so the analytics AVG R:R and per-card R:R become
  // real distributions instead of a flat constant:
  //   · strategy base      — scalps bank shorter, swings stretch further
  //   · order flow         — CONFIRMS flow pays for a wider target, CONFLICTS trims it
  //   · confluence conviction — higher score → room to the final target
  //   · market regime      — TRENDING stretches, VOLATILE/CHOP compress
  // v6.3: the whole ladder then scales by the GOVERNOR-OWNED rrScale knob
  // (0.75–1.35) — the AI can stretch or trim targets from realized TP3/SL evidence.
  const RR_BASE: Record<string, number> = { "AI-SCALP": 2.1, "MEAN-REVERT": 2.4, MOMENTUM: 2.8, BREAKOUT: 3.1, "AI-SWING": 3.4 };
  // v8.4 R4 VETO-ONLY (audit 2026-09-11): flow CONFIRMS stretched targets on an
  // anti-signal (CONFIRMS cohort tp 12.5%, Σ−124.4%) — the flow term is now
  // clamped ≤ 0: CONFLICTS still trim, CONFIRMS no longer stretch. Veto power
  // (flowVetoScore gate) is untouched until the factor passes its backtest.
  const flowAdj = Math.min(0, chosenFlow.score / 50);
  const confAdj = (conf.confidence - 60) / 40;
  const regimeAdjRR = chosen.regimeTag.includes("TREND") ? 0.2 : chosen.regimeTag.includes("VOLATILE") ? -0.3 : chosen.regimeTag.includes("CHOP") ? -0.25 : 0;
  const rr = Number(Math.min(4.2, Math.max(1.8, ((RR_BASE[conf.strategy] ?? 2.6) + flowAdj + confAdj + regimeAdjRR + volGeo.rrAdj) * gate.rrScale)).toFixed(1));
  // TP2 scales with RR (was frozen at 1.8R) — keeps the ladder proportional
  const tp2Mult = Number(Math.min(2.2, Math.max(1.5, 1.2 + rr * 0.22)).toFixed(2));
  const rrDrivers = `base ${RR_BASE[conf.strategy] ?? 2.6} · flow ${flowAdj >= 0 ? "+" : ""}${flowAdj.toFixed(2)} · conv ${confAdj >= 0 ? "+" : ""}${confAdj.toFixed(2)} · regime ${regimeAdjRR >= 0 ? "+" : ""}${regimeAdjRR.toFixed(1)} · vol ${volGeo.rrAdj >= 0 ? "+" : ""}${volGeo.rrAdj.toFixed(1)} · gov-scale ×${gate.rrScale.toFixed(2)}`;
  const tp1 = isLong ? entry + risk : entry - risk;
  const tp2 = isLong ? entry + risk * tp2Mult : entry - risk * tp2Mult;
  const tp3 = isLong ? entry + risk * rr : entry - risk * rr;
  // ── v8.4 R5 RESEARCH-SHADOW LADDER — the audit caught the live geometry
  // CONTRADICTING the flow-factor research optimum (slAtr 1.8 vs 1.2, rrScale
  // 0.75 vs 1.15, BE-trail on vs off). Flipping the live book to unproven
  // params would be reckless, so every deploy journals the research-aligned
  // ladder built from the SAME drivers (post-R4 scoring) — settle time replays
  // both ladders on 1m candles into db/research-shadow/ (the adoption A/B).
  const rawUnscaledRR = (RR_BASE[conf.strategy] ?? 2.6) + flowAdj + confAdj + regimeAdjRR + volGeo.rrAdj;
  const researchLadder = gate.researchShadow > 0 ? buildResearchLadder(entry, isLong, atrPct, slMult, volGeo.slMult, rawUnscaledRR) : null;

  const [ttlMin, ttlMax] = TTL_BY_STRATEGY[conf.strategy] ?? [90, 180];
  // v9.3 R6-INFORMATIVE PACKAGE: radar cards carry an explicit short TTL
  // (60–75m) + ttlNoExtend so they RESOLVE fast instead of drifting to a
  // censored EXPIRED-no-touch — the R6 informative ratio's main lever.
  // v10.9.2: `let` — the VOL-SCALED VERTICAL BARRIER (below) may replace the
  // random band TTL with the per-candidate solved one.
  let ttl = opts?.ttlMinutes ?? Math.round(ttlMin + Math.random() * (ttlMax - ttlMin));
  const now = new Date();

  // ── shared excursion math (v10.9.2) — ONE 20×15m window feeds BOTH the
  // VOL-SCALED VERTICAL BARRIER and the v10.6 DECISIVE-EXCURSION filter, so
  // both gates reason over the same tape view (no double counting).
  const exBars = klineCache.get(asset.symbol)?.candles ?? [];
  const exWin = exBars.slice(-20);
  let exEr: number | null = null; // Kaufman efficiency ratio (null = window not measurable)
  if (exWin.length >= 10) {
    const exNet = Math.abs(exWin[exWin.length - 1]!.close - exWin[0]!.open);
    let exPath = 0;
    for (let i = 1; i < exWin.length; i++) exPath += Math.abs(exWin[i]!.close - exWin[i - 1]!.close);
    exEr = exPath > 0 ? exNet / exPath : 0;
  }

  // ── v10.9.2 VOL-SCALED VERTICAL BARRIER (SUPERVISOR proposal, operator
  // blanket-approve 2026-09-16T09:03Z) — expiry-censoring root cause #2: the
  // RANDOM strategy-band TTL has no relationship to how far THIS tape can
  // carry price inside the holding window. Slow-tape candidates get 180-300m
  // of runway and die as EXPIRED-no-touch (censored rows — 44% of the
  // post-filter cohort), hot-tape candidates get TTLs shorter than their
  // travel justifies. Fix: SOLVE the diffusion projection for the time the
  // first decision (min(TP1dist, SLdist) = 1R) is reached —
  //   t1r = 15 × (requiredPct / (atrPct × ER))²
  // and set the vertical barrier there × volBarrierMult (headroom for the fat
  // right tail of touch times), clamped [30m, volBarrierCapMin]. A projected
  // touch beyond the cap (or ER below the chop floor) = SLOW-TOUCH candidate:
  // SKIPPED — a farther barrier would only manufacture the same censored rows
  // with extra fees. Explicit TTL overrides (radar cards), forced deploys and
  // authority bypasses are untouched; RAW-CAL capture DOES ride the barrier —
  // the censoring lives exactly there. Composes with the decisive filter:
  // a barrier-qualified candidate projects ≥1R travel by construction, so the
  // decisive check degrades to its chop-floor guard (coherent, not redundant).
  // v10.14 REGIME-ADAPTIVE CAP (SUPERVISOR proposal 2026-09-19T06:51Z,
  // operator APPROVE 2026-09-19T08:56Z msg 861802419): when
  // gate.volBarrierAdaptive=1 the EFFECTIVE cap relaxes from the base knob up
  // to 3×base as the symbol's 30d realized-vol percentile falls below 30 —
  // 240→720m at p0 — so compression regimes stop killing the exact setups
  // that expand (both droughts: 100% vol-barrier blocks, healthy sweep).
  // Fail-open: volPctile null (feed/cache fail) → FIXED base cap, legacy
  // behavior. Residual rejects feed the BARRIER-CAP-NEAR-MISS paper queue
  // with volPctile/capUsed metadata (counterfactual audit of the widening).
  if (gate.volBarrier > 0 && !opts?.forced && !opts?.authorityBypass && opts?.ttlMinutes === undefined) {
    const vbRequiredPct = slDistPct * 100;
    const vbSkip = (reason: string, detail: string) =>
      ({ reason, detail }) as const;
    let vbSkipInfo: ReturnType<typeof vbSkip> | null = null;
    let vbT1r: number | null = null; // v10.13 — hoisted projected 1R touch (near-miss tier B evidence)
    // v10.14 — effective cap: base knob, regime-relaxed when the symbol sits
    // in its own low-vol tail (percentile < 30). Adaptive ONLY when the knob
    // is on AND the percentile is measurable — otherwise exactly legacy.
    let effCap = gate.volBarrierCapMin;
    let volPctile: number | null = null;
    if (gate.volBarrierAdaptive) {
      volPctile = await realizedVolPctile(asset.symbol).catch(() => null);
      if (volPctile !== null) effCap = adaptiveBarrierCap(gate.volBarrierCapMin, volPctile);
    }
    const vbRegime = volPctile !== null && effCap !== gate.volBarrierCapMin ? ` · volPctile p${Math.round(volPctile)} → adaptive cap ${effCap}m` : "";
    if (exEr === null || exEr < gate.decisiveErMin || atrPct <= 0) {
      vbSkipInfo = vbSkip(
        `no measurable travel regime (ER ${exEr === null ? "n/a" : exEr.toFixed(2)} vs chop floor ${gate.decisiveErMin.toFixed(2)}, ATR ${atrPct.toFixed(2)}%) — slow-touch candidate`,
        `ER ${exEr === null ? "n/a" : exEr.toFixed(2)} below floor ${gate.decisiveErMin.toFixed(2)}`,
      );
    } else {
      const t1r = 15 * Math.pow(vbRequiredPct / (atrPct * exEr), 2);
      vbT1r = t1r;
      if (t1r > effCap) {
        vbSkipInfo = vbSkip(
          `projected 1R touch ${Math.round(t1r)}m beyond the ${effCap}m barrier cap (ATR ${atrPct.toFixed(2)}% × ER ${exEr.toFixed(2)}) — slow-touch candidate`,
          `t1r ${Math.round(t1r)}m > cap ${effCap}m`,
        );
      } else {
        const barrier = Math.round(Math.min(effCap, Math.max(30, t1r * gate.volBarrierMult)));
        if (Math.abs(barrier - ttl) >= 10) {
          void fireEvent(null, asset.symbol, "ENGINE", "info", `VOL-SCALED BARRIER: ${direction} ${asset.symbol} ${conf.strategy} TTL ${ttl}m → ${barrier}m (projected 1R touch ${Math.round(t1r)}m × ${gate.volBarrierMult.toFixed(2)} headroom · ATR ${atrPct.toFixed(2)}% · ER ${exEr.toFixed(2)}${vbRegime})`).catch(() => undefined);
        }
        ttl = barrier;
      }
    }
    if (vbSkipInfo) {
      void recordGateBlock({ gate: "VOL-BARRIER", symbol: asset.symbol, direction, reason: vbSkipInfo.reason });
      // v10.13 NEAR-MISS TIER B (operator APPROVE 2026-09-18T18:58Z msg 861802415):
      // a slow-touch reject with t1r in (cap, 1.5×cap] becomes a PAPER capture
      // riding the engine-identical ladder built above (entry/stopLoss/tp1-3/rr)
      // under the hypothetical 1.5×cap barrier — outcome-tracked answer to "is
      // the barrier cap over-tight in regime-guard L2?" Zero live risk (no
      // order, no ledger row); rails (8/day tier cap · 2h dedup · 16 open) live
      // in near-miss.ts. Self-skips outside the band.
      void nearMissCaptureBarrier({ symbol: asset.symbol, direction, strategy: conf.strategy, entry, stopLoss, tp1, tp2, tp3, slDistPct, rr, t1rMin: vbT1r ?? 0, capMin: effCap, volBarrierMult: gate.volBarrierMult, volPctile, baseCap: gate.volBarrierCapMin }).catch(() => undefined);
      if (Date.now() - lastDecisiveEventAt > 600_000) {
        lastDecisiveEventAt = Date.now();
        await fireEvent(null, asset.symbol, "ENGINE", "info", `VOL-SCALED BARRIER: ${direction} ${asset.symbol} ${conf.strategy} deploy skipped — ${vbSkipInfo.reason} · evidence: post-filter cohort expiry 44% (censored rows starve R6 attribution, SUPERVISOR proposal 2026-09-16)`);
      }
      return { error: `vol-scaled barrier: ${asset.symbol} ${direction} ${vbSkipInfo.detail} — slow-touch, deploy skipped`, status: 409 };
    }
  }

  // ── v10.6 DECISIVE-EXCURSION FILTER (operator mandate «علت های ریشه‌ای را برطرف کن» 2026-09-15) ──
  // Root cause #1 of the 7-day bleed (SUPERVISOR audit + proposal msg 2325):
  // 62% of settles EXPIRE without ever touching TP1 or SL — expiredNoTouch
  // 75/113 on RAW-CAL, bucket 30-60m 99/121 — censored rows starve R6 factor
  // attribution AND bleed fees. The filter predicts the no-touch cohort BEFORE
  // entry: the ATR-projected price TRAVEL within TTL (diffusion √t scaling off
  // the 15m ATR14, discounted by the Kaufman efficiency ratio so chop counts
  // as no-travel) must reach the first decision distance min(TP1dist, SLdist).
  // With TP1 = 1R both equal the stop distance — the bar is 1R in price terms.
  // Predicted no-touch → deploy SKIPPED (gate journal gate=DECISIVE).
  // Operator-forced + radar direct-authority deploys bypass (explicit human
  // override); RAW-CAL capture does NOT bypass — the censoring lives exactly
  // there and the mandate targets it.
  if (gate.decisiveFilter > 0 && !opts?.forced && !opts?.authorityBypass) {
    // v10.9.2: reuses the shared excursion window (exEr above) and runs AFTER
    // the vol-scaled barrier, so it judges the BARRIER TTL the trade will
    // actually live under; for barrier-qualified candidates the projection is
    // ≥1R by construction and this degrades to its chop-floor guard.
    if (exEr !== null) {
      const requiredPct = slDistPct * 100; // min(TP1dist, SLdist) = 1R (tp1 = entry ± risk)
      const decMult = gate.decisiveFilter >= 2 ? 1 : 0.85; // level 1 lenient ×0.85 · level 2 strict ×1.0
      const projPct = atrPct * Math.sqrt(ttl / 15) * exEr; // 15m-ATR diffusion projection × efficiency
      if (exEr < gate.decisiveErMin || projPct < requiredPct * decMult) {
        const reason = `projected travel ${projPct.toFixed(2)}% in ${ttl}m (ATR ${atrPct.toFixed(2)}% × √(ttl/15m) × ER ${exEr.toFixed(2)}) vs required ${(requiredPct * decMult).toFixed(2)}% = 1R min(TP1,SL)${exEr < gate.decisiveErMin ? ` · ER ${exEr.toFixed(2)} below chop floor ${gate.decisiveErMin}` : ""} — predicted no-touch`;
        void recordGateBlock({ gate: "DECISIVE", symbol: asset.symbol, direction, reason });
        if (Date.now() - lastDecisiveEventAt > 600_000) {
          lastDecisiveEventAt = Date.now();
          await fireEvent(null, asset.symbol, "ENGINE", "info", `DECISIVE-EXCURSION FILTER: ${direction} ${asset.symbol} ${conf.strategy} deploy skipped — ${reason} · evidence: expiredNoTouch 75/113, bucket 30-60m 99/121 expired (root cause #1, operator mandate 2026-09-15)`);
        }
        return { error: `decisive-excursion filter: ${asset.symbol} ${direction} projected travel ${projPct.toFixed(2)}% < ${(requiredPct * decMult).toFixed(2)}% required within ${ttl}m (ER ${exEr.toFixed(2)}) — predicted no-touch, deploy skipped`, status: 409 };
      }
    }
  }

  // ── v5.4 DYNAMIC TIMEFRAME ALLOCATION (root-cause fix for "TIMEFRAME EDGE always constant") ──
  // Every deployment used to be stamped "15m", collapsing the TIMEFRAME EDGE
  // analytics into a single dead bar. The intended holding horizon is now
  // derived from strategy family, then tilted by measured volatility + regime:
  const TF_BASE: Record<string, string> = { "AI-SCALP": "5m", "MEAN-REVERT": "15m", MOMENTUM: "15m", BREAKOUT: "15m", "AI-SWING": "1h" };
  const TF_LADDER = ["5m", "15m", "1h", "4h"];
  let tfIdx = TF_LADDER.indexOf(TF_BASE[conf.strategy] ?? "15m");
  const tfVolTilt = atrPct >= 2.2 ? -1 : atrPct < 0.8 ? 1 : 0; // hot tape → faster horizon, dead tape → slower
  tfIdx = Math.max(0, Math.min(TF_LADDER.length - 1, tfIdx + tfVolTilt + (chosen.regimeTag.includes("TREND") && conf.strategy === "AI-SWING" ? 1 : 0)));
  const timeframe = TF_LADDER[tfIdx]!;

  // equity + confidence-sized margin, regime-scaled (VOLATILE ×0.6 etc.) + L3.5 crowd cut
  const settled = await db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { pnlPercent: true, marginUsd: true } });
  const openSigs = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { pnlPercent: true, marginUsd: true } });
  const realized = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const unrealized = openSigs.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const equity = ACCOUNT_START_USD + realized + unrealized;
  const exposure = openSigs.reduce((a, s) => a + s.marginUsd, 0);
  const marginBase = confidenceMargin(conf.confidence, equity, Math.max(0, equity - exposure));

  // ── v8.1 P2 RISK OVERLAY (risk-overlay.ts) ──
  // getRiskState(symbol, direction) assesses the STANDING book (union-merge
  // clusters |ρ|≥0.65, drawdown sizing ×1/×0.75/×0.5 at 3%/7%) plus the
  // candidate join test (same-direction correlated share ≥35% of equity →
  // blocked). Auto path: refused with an audited, rate-limited event.
  // Operator-forced deploys are never refused — they deploy HALF-SIZED with
  // the RISK-CLUSTER tag so the ledger can judge the override cohort.
  const riskOv = await getRiskState(asset.symbol, direction);
  let riskMult = riskOv.state.sizeMult;
  let riskTag: string | null = null;
  let riskNote: string | null = riskOv.candidateJoinsBlocked || riskOv.state.verdict !== "OK" ? riskOv.state.reasons.join(" · ") : null;
  if (riskOv.candidateJoinsBlocked) {
    if (!opts?.forced && !bypassQuality) {
      if (Date.now() - lastRiskBlockEventAt > 600_000) {
        lastRiskBlockEventAt = Date.now();
        await fireEvent(null, asset.symbol, "ENGINE", "warn", `RISK-CLUSTER BLOCK: ${direction} ${asset.symbol} refused — ${riskNote ?? "correlated cluster over cap"}. The overlay caps same-direction correlated exposure at 35% of equity.`);
      }
      void recordGateBlock({ gate: "RISK-CLUSTER", symbol: asset.symbol, direction, reason: riskOv.state.reasons[0] ?? "correlated cluster over cap" });
      return { error: `risk overlay: ${direction} ${asset.symbol} would join an over-cap correlated cluster (${riskOv.state.reasons[0] ?? "exposure cap"})`, status: 409 };
    }
    riskMult = Math.min(riskMult, 0.5);
    riskTag = "RISK-CLUSTER";
    riskNote = `${opts?.forced ? "operator-forced" : "capture-authority"} deploy joins an over-cap correlated cluster — HALF-SIZED per overlay policy (${riskNote ?? "exposure cap"})`;
  } else if (riskOv.state.drawdownPct >= 3) {
    riskTag = "RISK-DD";
  }

  // ── v8.2 SHADOW-VETO DEPLOY GATE (AI-core Phase 0/1, operator 2026-09-09) ──
  // Tiered authority at the fence: in mode=veto (unlockable ONLY through the
  // measured evidence gate — ≥30 settled per arm + Wilson-LB separation +
  // negative veto-cohort PnL), a fresh VETO verdict from the shadow adjudicator
  // blocks this deployment. FAIL-OPEN: no fresh verdict → the deploy proceeds
  // and the adjudicator pre-warms for the next evaluation. Operator-forced
  // deploys always bypass (explicit human override, audited).
  // v10.6 CAPTURE-OBSERVE branch (operator mandate «پرشدن بازوهای shadow-veto
  // را سرعت و بهبود ببخش» 2026-09-15): RAW-CAL deploys skip the veto gate by
  // design, but the skip also SKIPPED VERDICT CREATION — 113 capture issues
  // starved the REAL arms (real-keep 9/30). Under capture the adjudicator now
  // runs OBSERVE-ONLY (side PASS, verdict never vetoes — capture authority is
  // untouched) and the verdict binds to the real serial via linkRealDeploy →
  // every capture settle feeds real-keep / real-veto.
  {
    const svGap = Math.abs(chosen.adjScore) - chosen.effMin;
    const svRank = [...conf.votes].sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote));
    const svDirSign = direction === "LONG" ? 1 : -1;
    const svCtx = {
      symbol: asset.symbol,
      direction,
      strategy: conf.strategy,
      score: chosen.adjScore,
      effMin: chosen.effMin,
      gap: svGap,
      thr: chosen.thrParts,
      confirms: svRank.filter((v) => v.vote * svDirSign > 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
      opposes: svRank.filter((v) => v.vote * svDirSign < 0).slice(0, 3).map((v) => ({ factor: v.factor, vote: v.vote, detail: v.detail })),
      notes: chosen.regimeNote,
      entryPrice: entry,
      source: gateSource,
    };
    if (!opts?.forced && !bypassQuality) {
      const sv = await shadowVetoDeployGate(svCtx);
      if (sv.veto) {
        const svMsg = `SHADOW-VETO BLOCK [${sv.verdictId}]: ${direction} ${asset.symbol} deploy refused — ${sv.reason}`;
        void recordGateBlock({ gate: "SHADOW-VETO", symbol: asset.symbol, direction, reason: svMsg });
        await fireEvent(null, asset.symbol, "ENGINE", "warn", `${svMsg} · veto-only core authority active (mode=veto, evidence-gated) — the blocked trade is paper-tracked for revocation evidence`);
        return { error: `shadow-veto gate: ${direction} ${asset.symbol} blocked by the AI core (${sv.reason}) — tiered veto authority, revocable via /api/ai/shadow-veto`, status: 409 };
      }
    } else if (opts?.calCapture && !opts?.forced) {
      await shadowVetoObserve(svCtx);
    }
  }

  // v6.3: riskPerTrade is GOVERNOR-OWNED (0.5–1.5) — scales the whole margin so
  // the LLM can de-risk in drawdowns and re-size on proven positive expectancy
  // v6.5: two more measured multipliers — shortSizeMult (SHORT book bleeds:
  // 27.8% win / −$26.65 vs LONG +$2.32) and BREAKOUT half-size under guard L1.
  // v8.1: risk-overlay multiplier (drawdown throttle + cluster policy).
  const stratSizeMult = conf.strategy === "BREAKOUT" && boGuard === 1 ? 0.5 : 1;
  // v10.6 PER-STRATEGY SIZING (SUPERVISOR proposal completed for operator
  // decision): per-strategy margin multiplier instead of ONE global size —
  // staged weights cut the AI-SWING bleed (57% of book @ −1.87%/trade) and
  // feed the proven AI-SCALP/MEAN-REVERT edges. Neutral ×1 while the module
  // is disabled; activation = explicit operator decision (/api/strategy-weights).
  const stratW = await strategyWeightFor(conf.strategy);
  // v10.11 STRAT-PROBATION — soft margin valve: ×0.5 while the strategy's
  // EB-shrunk expectancy UCB is negative (sizing only, never a veto; the
  // memory gate / breakoutGuard / governor semantics are untouched).
  const probF = await probationFactorFor(conf.strategy);
  // v10.9.3 MG-PROBE — memory-gate hysteresis re-entry: HALF margin until the
  // 5-probe block proves expectancy ≥ 0 (operator APPROVE 2026-09-16).
  const mgProbe = mgProbeKeys.has(`${asset.symbol}:${conf.strategy}`);
  let margin = Number((marginBase * gate.riskPerTrade * regimeSize * (crowdCut ? 0.6 : 1) * (volCause?.basis === "LEARNED-CONTINUATION" ? 1.15 : 1) * (direction === "SHORT" ? gate.shortSizeMult : 1) * stratSizeMult * stratW * probF * riskMult * (probeBypass ? 0.5 : 1) * (mgProbe ? 0.5 : 1) * dislocationMult).toFixed(2));

  // v6.7.2 LEVERED RISK CAP (operator mandate): slDist% × leverage is the real
  // single-trade swing at the stop. Design targeted a constant ~60%; the 20x
  // clamp let tight stops through at 36% (NX-0185) and wide stops 61% (NX-0138)
  // — two trades carried the day. Excess leverage is trimmed so the stop costs
  // ≤ leveredRiskCap% of margin. 5x floor: if even 5x breaks the cap the stop
  // is structurally broken — keep 5x (SL floor 0.7% bounds the damage at 3.5%).
  let leverage = Math.round(Math.min(20, Math.max(5, 60 / (slDistPct * 100))));
  let riskCapped = false;
  const rawLev = leverage;
  if (gate.leveredRiskCap > 0 && slDistPct * 100 * leverage > gate.leveredRiskCap) {
    const capped = Math.floor(gate.leveredRiskCap / (slDistPct * 100));
    if (capped >= 5 && capped < leverage) {
      leverage = capped;
      riskCapped = true;
    }
  }

  // v8.4 R4 VETO-ONLY: flow can no longer LIFT conviction either — clamp ≤ 0
  // (a conflicting board still drags it down; a confirming one adds nothing).
  const conviction = Math.round(Math.min(96, Math.max(55, conf.confidence + Math.min(0, chosenFlow.score * 0.3) + (volCause?.boost ?? 0))));
  let serial = await nextSerial(); // v10.16 P1 — `let`: the P2002 backstop below may re-issue a fresh serial

  // v8.1 P1 — liq-heat cohort tag derived from the evaluate() guard note that
  // rode through on chosen.regimeNote (LIQ-HEAT-* = threshold penalty, LIQ-FUEL-* = discount)
  const liqTag = chosen.regimeNote?.includes("LIQ-HEAT-")
    ? chosen.regimeNote.includes("LIQ-HEAT-BELOW") ? "LIQ-HEAT-BELOW" : "LIQ-HEAT-ABOVE"
    : chosen.regimeNote?.includes("LIQ-FUEL-")
      ? chosen.regimeNote.includes("LIQ-FUEL-ABOVE") ? "LIQ-FUEL-ABOVE" : "LIQ-FUEL-BELOW"
      : null;

  const factorsJson = JSON.stringify(conf.votes);
  const flowJson = JSON.stringify(chosenFlow);
  const tags = [
    conf.score >= 45 ? "high-conviction" : "confluence",
    chosenFlow.verdict === "CONFIRMS" ? "FLOW-CONFIRM" : chosenFlow.verdict === "CONFLICTS" ? "FLOW-CONFLICT" : "FLOW-NEUTRAL",
    chosen.regimeTag,
    ...(opts?.triggerTag ? ["EVENT-TRIGGER"] : []),
    ...(opts?.extraTags ?? []), // v9.0 — dedicated PUMP/DUMP card cohorts (radar-spawned)
    ...(crowdCut ? ["CROWD-CUT"] : []),
    ...(onsetInfo?.hot ? [onsetInfo.tag] : []),
    ...(volCause?.cause ? [`VOLCAUSE-${volCause.cause}`] : []),
    // v6.7 SMART-MONEY tags: whale prints (aggTrades ≥$250K near entry) and
    // SMC liquidity sweeps aligned with the thesis — auditable A/B cohorts.
    // FUNDING-SKEW: extreme carry marks the crowded side the entry leans into.
    ...(chosenFlow.metrics.whalePrint5m ? ["WHALE-PRINT"] : []),
    ...(sweepInfo.swept && sweepInfo.supportive ? ["LIQ-SWEEP"] : []),
    ...(Math.abs(chosenFlow.metrics.funding8h ?? 0) >= 0.05 ? [`FUNDING-SKEW-${chosenFlow.metrics.funding8h! > 0 ? "LONGS-CROWDED" : "SHORTS-CROWDED"}`] : []),
    // v6.7.2 FAST-KILL GUARDS: retested-eruption cohort + risk-capped cohort —
    // auditable A/B arms the advisor judges exactly like BO-EXP.
    ...(onsetRetested ? ["VOL-ONSET-RETEST"] : []),
    ...(riskCapped ? ["RISK-CAP"] : []),
    // v10.6 per-strategy sizing cohort — rows sized under an ACTIVE strategy
    // weight carry the multiplier so the ledger can A/B the resized cohorts.
    ...(stratW !== 1 ? [`STRATW-x${stratW.toFixed(2)}`] : []),
    // v10.11 STRAT-PROBATION cohort — rows sized under probation carry the
    // factor so the ledger can A/B the halved cohort like STRATW.
    ...(probF !== 1 ? [`STRAT-PROB-x${probF.toFixed(2)}`] : []),
    // v8.0 EPOCH-2 — the operator-ordered reset epoch: ledger wiped, balance
    // reseeded to $100, calibration rebuilt ONLY from the verified backtest.
    // This tag slices the fresh book from every predecessor.
    "EPOCH-2",
    // v8.0 MULTI-TF FLOW BOARD cohorts — auditable A/B arms for the scanner gate.
    ...(chosen.mtf && Math.abs(chosen.mtf.netScore) >= 40 ? [Math.sign(chosen.mtf.netScore) === (direction === "LONG" ? 1 : -1) ? "MTF-ALIGNED" : "MTF-CONFLICT"] : []),
    ...(chosen.mtf && chosen.mtf.alignment >= 3 ? ["MTF-CONSENSUS"] : []),
    // v8.1 P1/P2 cohorts — liq-heat proximity, vol regime and risk overlay arms.
    ...(liqTag ? [liqTag] : []),
    ...(volGeo.tag ? [volGeo.tag] : []),
    ...(riskTag ? [riskTag] : []),
    // v6.6 BREAKOUT trial cohort — conditional-regime experiment (breakoutGuard=1):
    // these rows form the A/B arm the advisor judges (PF > 1.2 over ≥20 settles).
    ...(gate.breakoutGuard === 1 && conf.strategy === "BREAKOUT" ? ["BO-EXP"] : []),
    // v9.1 CALIBRATION CAPTURE cohort — RAW-CAL rows are the unfiltered sample
    // the operator ordered into the engine-memory book; their settles count
    // toward the R6 n≥100 calibration lift exactly like every other EPOCH-2 row.
    ...(opts?.calCapture ? ["RAW-CAL"] : []),
    // v9.3 R6-INFORMATIVE package — radar cards: short explicit TTL, expiry
    // extension disabled at settlement (resolve fast → informative outcomes).
    ...(opts?.ttlNoExtend ? ["RADAR-TTL"] : []),
    // v8.4.1 G4 RECOVERY PROBE cohort — gate-closed bounded deploys at half
    // margin; their settles are the evidence that re-opens the G1 rolling gate.
    ...(probeBypass ? ["G4-PROBE"] : []),
    // v10.9.3 MG-PROBE cohort — memory-gate hysteresis re-entry at half margin;
    // their settles are the evidence that restores full size (5-probe block).
    ...(mgProbe ? ["MG-PROBE"] : []),
    // v10.15 DISLOCATION-GATE warn band — admitted through a stretched venue
    // board at half margin; settles are the adverse-selection cohort evidence.
    ...(dislocationMult !== 1 ? ["DISLOCATION-HALF"] : []),
  ];
  const votesStr = `EMA ${conf.votes[0]?.vote >= 0 ? "+" : ""}${conf.votes[0]?.vote}, MACD ${conf.votes[1]?.vote >= 0 ? "+" : ""}${conf.votes[1]?.vote}, RSI ${snap0(conf)}, range ${conf.votes[3]?.vote >= 0 ? "+" : ""}${conf.votes[3]?.vote}`;
  const thrStr = chosen.thrAdj !== 0 ? ` vs dynamic MIN_SCORE ${gate.minScore}${chosen.thrAdj > 0 ? "+" : ""}${chosen.thrAdj} regime adj → eff ${chosen.effMin}` : `/${Math.abs(conf.score) >= gate.minScore ? "PASS" : "FAIL"} gate ${gate.minScore}`;
  const analysis = [
    `[NX-${String(serial).padStart(4, "0")}] ${direction} ${asset.symbol} — ${conf.strategy}${opts?.triggerTag ? " (EVENT-TRIGGER)" : ""} ${chosenFlow.verdict === "CONFIRMS" ? "with flow confirmation" : "on confluence"}: score ${conf.score}/100${thrStr} (${votesStr}).`,
    chosen.regimeNote ? `Regime: ${chosen.regimeNote}.` : "",
    onsetInfo?.hot ? `Vol-onset: ${onsetInfo.detail}${onsetRetested ? " — RETESTED: impulse retraced ≥30%, entry on the pullback (retest gate passed)" : ""}.` : "",
    riskCapped ? `Levered risk cap: stop swing trimmed from ${(slDistPct * 100 * rawLev).toFixed(0)}% to ${(slDistPct * 100 * leverage).toFixed(1)}%-of-margin via ${rawLev}×→${leverage}× leverage (cap ${gate.leveredRiskCap}%).` : "",
    volCause?.cause ? `Vol-cause: ${volCause.detail ?? volCause.cause}${volCause.basis === "LEARNED-CONTINUATION" ? ` — learned profile applied (+${volCause.boost} conviction, ×1.15 size)` : " — telemetry-only, learned gate pending"}.` : "",
    `Flow ${chosenFlow.verdict} ${chosenFlow.score}/25 — ${chosenFlow.reasons[0] ?? "measured snapshot"}.`,
    chosenFlow.metrics.whalePrint5m ? `Whale prints: ${chosenFlow.metrics.whalePrint5m.count} fill(s) ≥$250K / $${(chosenFlow.metrics.whalePrint5m.totalUsd / 1000).toFixed(0)}K in 5m (${chosenFlow.metrics.whalePrint5m.buyUsd >= chosenFlow.metrics.whalePrint5m.sellUsd ? "buy" : "sell"}-dominant, max $${(chosenFlow.metrics.whalePrint5m.maxUsd / 1000).toFixed(0)}K).` : "",
    sweepInfo.swept ? `Liquidity sweep: ${sweepInfo.detail}.` : "",
    // v8.1 P1/P2 transparency lines — the operator sees WHY geometry/sizing moved
    volGeo.note ? `Vol forecast: ${volGeo.note}.` : volF ? `Vol forecast: regime ${volF.regime} (self-pct ${volF.percentile}, EWMA 1h ${volF.ewma1hPct.toFixed(2)}%) — geometry unchanged.` : "",
    riskNote ? `Risk overlay: ${riskNote}${riskOv.state.sizeMult < 1 ? ` · drawdown sizing ×${riskMult.toFixed(2)}` : ""}.` : "",
    `Invalidation ${slDistPct.toFixed(2)}% behind entry (${slMult > 1 ? "widened for volatility, " : ""}${gate.slAtrMult}×ATR${slMult !== 1 ? `×${slMult}` : ""}); targets 1R/${tp2Mult}R/${rr}R — dynamic R:R (${rrDrivers}); horizon ${timeframe}${tfVolTilt !== 0 ? ` (vol-tilted ${tfVolTilt < 0 ? "down" : "up"}, ATR ${atrPct.toFixed(2)}%)` : ""}; TTL ${ttl}m. Margin $${margin.toFixed(2)} @ ${leverage}× (confidence${gate.riskPerTrade !== 1 ? ` × risk ${gate.riskPerTrade.toFixed(2)}` : ""}${regimeSize !== 1 ? ` × regime ${regimeSize}` : ""}${crowdCut ? " × crowd-cut 0.6" : ""}${direction === "SHORT" && gate.shortSizeMult !== 1 ? ` × short-size ${gate.shortSizeMult.toFixed(2)}` : ""}${stratSizeMult !== 1 ? " × breakout-guard 0.5" : ""}${stratW !== 1 ? ` × strategy-weight ${stratW.toFixed(2)}` : ""}${probF !== 1 ? " × strat-probation 0.5" : ""} sizing${gate.beTrailPct > 0 || gate.beArmMovePct > 0 ? ` · BE arms at ${gate.beTrailPct > 0 ? `+${gate.beTrailPct}% NET` : ""}${gate.beTrailPct > 0 && gate.beArmMovePct > 0 ? " or " : ""}${gate.beArmMovePct > 0 ? `+${gate.beArmMovePct}% price (R2)` : ""}` : ""}${gate.earlyExitGuard > 0 ? ` · early-exit ${Math.round(gate.earlyExitFrac * 100)}%TTL@${gate.earlyExitR.toFixed(2)}R (R7)` : ""}${gate.shortGuard > 0 && direction === "SHORT" ? ` · R1 short-guard active` : ""}${probeBypass ? " · G4-PROBE ×0.5" : ""}${mgProbe ? " · MG-PROBE ×0.5" : ""}${dislocationMult !== 1 ? ` · DISLOCATION ×0.5 (venue median ${dislocMedian.toFixed(1)}bps)` : ""}) · fees taker 0.05%×2 + funding 0.01%/8h.`,
  ].filter(Boolean).join(" ");

  // v10.16 P1 SERIAL RACE — the create runs under the UNIQUE(serial) DB
  // backstop (schema v10.16): a P2002 means a double-assign the globalThis
  // mutex could not see (cross-bundle/cross-process). Retry ONCE with a fresh
  // MAX(serial) via the mutex and re-stamp the NX-xxxx token in the analysis
  // body so the row stays internally consistent.
  const buildSigInput = (ser: number, body: string) => ({
    data: {
      symbol: asset.symbol,
      direction,
      entryPrice: Number(entry.toFixed(entry > 100 ? 2 : 6)),
      entryZoneLow: Number((entry * 0.9992).toFixed(entry > 100 ? 2 : 6)),
      entryZoneHigh: Number((entry * 1.0008).toFixed(entry > 100 ? 2 : 6)),
      tp1: Number(tp1.toFixed(entry > 100 ? 2 : 6)),
      tp2: Number(tp2.toFixed(entry > 100 ? 2 : 6)),
      tp3: Number(tp3.toFixed(entry > 100 ? 2 : 6)),
      stopLoss: Number(stopLoss.toFixed(entry > 100 ? 2 : 6)),
      initialStopLoss: Number(stopLoss.toFixed(entry > 100 ? 2 : 6)), // v6.6 — deploy-time snapshot for tranche/TP3 accounting
      leverage,
      marginUsd: margin,
      confidence: conviction,
      riskReward: rr,
      timeframe,
      strategy: conf.strategy,
      status: "ACTIVE",
      analysis: body,
      tags: tags.join(","),
      engine: ENGINE_VERSION,
      serial: ser,
      factorsJson,
      flowJson,
      mtfJson: chosen.mtf ? JSON.stringify(chosen.mtf) : null, // v8.0 multi-TF flow board frozen at deploy
      ttlMinutes: ttl,
      expiresAt: new Date(now.getTime() + ttl * 60_000),
      createdAt: now,
    },
  });
  const nxToken = (n: number) => `NX-${String(n).padStart(4, "0")}`;
  let sig: Signal;
  try {
    sig = await db.signal.create(buildSigInput(serial, analysis));
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const oldToken = nxToken(serial);
    serial = await nextSerialFresh();
    sig = await db.signal.create(buildSigInput(serial, analysis.replaceAll(oldToken, nxToken(serial))));
    await fireEvent(null, asset.symbol, "ENGINE", "warn", `SERIAL COLLISION recovered — UNIQUE(serial) backstop caught a duplicate NX identity; deployed as ${nxToken(serial)} after one fresh MAX(serial) retry (v10.16)`).catch(() => undefined);
  }

  await fireEvent(sig.id, sig.symbol, "CREATED", "ai", `[NX-${String(serial).padStart(4, "0")}] ${direction} ${sig.symbol} deployed @ ${sig.entryPrice} — ${conf.strategy} ${timeframe}${opts?.triggerTag ? " · EVENT-TRIGGER spawn" : ""} · conviction ${conviction}% (flow ${chosenFlow.score >= 0 ? "+" : ""}${chosenFlow.score}) · R:R 1:${rr} · flow ${chosenFlow.verdict.toLowerCase()} (OI ${chosenFlow.metrics.oiDelta1h !== null ? `${chosenFlow.metrics.oiDelta1h >= 0 ? "+" : ""}${chosenFlow.metrics.oiDelta1h.toFixed(2)}%/1h` : "n/a"} · funding ${chosenFlow.metrics.funding8h !== null ? `${chosenFlow.metrics.funding8h.toFixed(4)}%/8h` : "n/a"})${chosen.regimeTag !== "REGIME-UNKNOWN" ? ` · ${chosen.regimeTag.replace("REGIME-", "")}` : ""}${crowdCut ? " · crowd-cut ×0.6" : ""}${opts?.forced ? " · OPERATOR-FORCED (gates bypassed)" : ""}${opts?.calCapture ? " · RAW-CAL CAPTURE (unfiltered, calibration sample)" : ""}${opts?.authorityBypass ? " · RADAR DIRECT AUTHORITY (unfiltered emission — operator mandate; honesty rails only)" : ""}`);
  // v8.4 R5 — journal the shadow pair (live vs research ladder) for settle-time replay
  if (researchLadder) {
    journalResearchShadowDeploy({
      serial,
      symbol: sig.symbol,
      direction,
      at: now.toISOString(),
      entry,
      live: { slDistPct: Number((slDistPct * 100).toFixed(3)), rr, stop: sig.stopLoss, tp3: sig.tp3 },
      research: researchLadder,
    });
  }
  // v8.2 GATE GAUGE — the deployment itself closes the loop in the journal
  void recordGateDeploy({ serial, symbol: sig.symbol, direction, strategy: conf.strategy, score: conf.score, effMin: chosen.effMin, flowScore: chosenFlow.score, conviction, tags });
  // v8.2 SHADOW-VETO — bind the freshest PASS-side verdict to this serial so
  // the settle sweep can attach the REAL outcome (would-veto counterfactual).
  void linkRealDeploy(serial, sig.symbol, direction).catch(() => undefined);
  if (opts?.triggerTag) markTriggerSpawn();
  return { signal: sig };
}

async function atrPctOf(symbol: string): Promise<number> {
  const candles = await getKlines(symbol);
  if (!candles) return 1.5;
  const snap = buildSnapshot(symbol, candles);
  return snap?.atrPct ?? 1.5;
}

// tiny helper to read votes in analysis text
function snap0(conf: Awaited<ReturnType<typeof scoreConfluence>>): string {
  const rsi = conf.votes.find((v) => v.factor === "RSI POSITION");
  return `${rsi && rsi.vote >= 0 ? "+" : ""}${rsi?.vote ?? 0}`;
}

async function autoSpawn(activeCount: number): Promise<number> {
  const cap = (await getGateSettings().catch(() => null))?.maxActive ?? MAX_ACTIVE_FALLBACK;
  if (activeCount >= cap) return 0;
  if (Math.random() > 0.3) return 0;
  const res = await deploySignal();
  return res.signal ? 1 : 0;
}

// ── flavor events (live, honest) ──────────────────────────────
async function flavorEvents(assets: MarketAsset[]) {
  if (Math.random() > FLAVOR_CHANCE) return;
  const feed = getFeedStatus();
  const flow = getFlowStatus();
  const liq = await getLiquidationStatus();
  const pool: Array<{ type: string; level: string; msg: () => string }> = [
    { type: "ENGINE", level: "info", msg: () => { const s = lastSweepBest; return `Confluence sweep complete — best |score| ${s ? Math.round(s.best) : "n/a (no sweep since boot)"} vs sweep MIN_SCORE ${s ? s.minScore : "--"} (${s ? s.candidates : 0} candidates) across ${assets.length} futures markets`; } },
    { type: "SYSTEM", level: "info", msg: () => { const worst = [...assets].filter((a) => a.maxDevBps != null).sort((x, y) => (y.maxDevBps ?? 0) - (x.maxDevBps ?? 0))[0]; const v = worst?.maxDevBps ?? 0; return v > 0 ? `Cross-venue consensus sweep — worst tracked dislocation ${v.toFixed(1)} bps on ${worst!.symbol} (event floor 12 bps)` : `Cross-venue consensus sweep — all tracked symbols aligned below the 12 bps dislocation floor`; } },
    { type: "ENGINE", level: "info", msg: () => `Futures flow sweep: ${flow.covered} symbols covered — deployments are flow-gated (CVD/OI/funding/crowd)` },
    feed.source === "LIVE"
      ? { type: "SYSTEM", level: "info", msg: () => `Binance feed LIVE ${feed.latencyMs ?? "--"}ms via ${feed.host} — kline rotation ${KLINE_ROTATION}/tick` }
      : { type: "SYSTEM", level: "warn", msg: () => `Feed degraded (${feed.source}) — resilience ladder engaged` },
    liq
      ? liq.dataStalled
        ? { type: "SYSTEM", level: "warn", msg: () => `Liquidation stream stalled — exchange frames not reaching this host; derived OI probe in use, no invented cascade data` }
        : { type: "SYSTEM", level: "info", msg: () => `Liquidation stream connected — ${liq.buffered} forceOrder events buffered` }
      : { type: "SYSTEM", level: "warn", msg: () => `Liquidation service offline — derived OI probe in use` },
  ];
  const tpl = pool[Math.floor(Math.random() * pool.length)]!;
  const sym = assets[Math.floor(Math.random() * assets.length)]?.symbol ?? null;
  await fireEvent(null, sym, tpl.type, tpl.level, tpl.msg());
}

// event-driven spawn: a fired trigger hands the engine ONE symbol for immediate gated evaluation
// v9.3: the trigger's event-instant price rides along as the ANTI-LATE-ENTRY
// reference — if price already ran past the strategy chase cap since the event
// fired (≤90s window), the deploy is refused instead of chasing.
async function triggerSpawn(symbol: string, side: "LONG" | "SHORT" | "NEUTRAL", refPrice?: number): Promise<void> {
  if (!canTriggerSpawn()) return;
  const activeCount = await countActive();
  const cap = (await getGateSettings().catch(() => null))?.maxActive ?? MAX_ACTIVE_FALLBACK;
  if (activeCount >= cap) return;
  const res = await deploySignal(undefined, side === "NEUTRAL" ? undefined : side, { focusSymbol: symbol, triggerTag: "EVENT-TRIGGER", ...(refPrice ? { refPrice } : {}) });
  if (res.signal) {
    await fireEvent(null, symbol, "ENGINE", "ai", `Event-driven engine: candidate born from TRIGGER BUS — ${symbol} evaluated on trigger, passed all gates → NX-${String(res.signal.serial).padStart(4, "0")} (no scan-schedule wait)`);
  } else if (res.error && !res.error.includes("no qualifying")) {
    await fireEvent(null, symbol, "ENGINE", "info", `Event-driven engine: ${symbol} trigger evaluated — ${res.error}`);
  }
}

// ── main tick ─────────────────────────────────────────────────
export async function tick(force = false): Promise<{ ran: boolean; resolved: number; leveled: number; spawned: number; tickCount: number }> {
  ensureHeartbeat(); // first call arms the autonomous heartbeat
  const now = Date.now();
  if (!force && now - lastTick < MIN_TICK_MS) return { ran: false, resolved: 0, leveled: 0, spawned: 0, tickCount };
  if (ticking) return { ran: false, resolved: 0, leveled: 0, spawned: 0, tickCount };

  ticking = true;
  try {
    lastTick = now;
    tickCount++;
    await ensureAssets();
    const assets = await updatePrices();
    await refreshUniverse();

    // v5.3 FLOW DOMAIN WARMUP — keep flow metrics hot across the WHOLE scan
    // domain (not only the 3-symbol deploy shortlist) so FLOW COVERAGE
    // telemetry, the trigger bus and AI grounding reflect the real tracked
    // market. 8 symbols per 3 ticks → 27-40 perps re-measured in ~1min,
    // comfortably inside the 10min stale grace.
    if (tickCount % 3 === 0 && assets.length > 0) {
      const BATCH = 8;
      const syms: string[] = [];
      for (let i = 0; i < Math.min(BATCH, assets.length); i++) syms.push(assets[(flowCursor + i) % assets.length]!.symbol);
      flowCursor = (flowCursor + syms.length) % Math.max(1, assets.length);
      void ensureFlow(syms).catch(() => undefined);
      // v5.3: LAYER-0 regime warmup — the same rotating slice re-classifies
      // regimes from cached klines, so the TERMINAL Market Regimes strip stays
      // permanently populated instead of flickering to "classifier warming"
      // whenever no deploy scan ran in the last 6min (root cause of the
      // operator's "Market Regimes unstable" report).
      for (const s of syms) {
        const c = klineCache.get(s)?.candles;
        if (c && c.length >= 80) getRegimeCached(s, c);
      }
    }
    if (tickCount % 30 === 0) await resolveOrphans();
    void pruneEvents(); // v6.2 housekeeping — internally rate-limited to 1/h
    ensureAutoDiscover(); // v6.2.2 telegram — idempotent, no-op once chat resolved
    const { resolved, leveled, activeCount } = await resolveSignals(assets);
    await trackAfterlife(assets);

    // v9.0 PUMP/DUMP RADAR — independent tracking engine (operator mandate
    // 2026-09-12). Stage-1 velocity screen is in-memory; stage-2 flow
    // confirmation is throttled inside the module. Fire-and-forget: never
    // blocks or breaks the tick. Signals stay forbidden until the radar
    // banks 5 SUCCESSFUL tracks (operator's learning gate).
    void pumpTick(assets.map((a) => ({ symbol: a.symbol, price: a.price, volume24h: a.volume24h, source: a.source }))).catch((e) => console.error("[pump-radar]", e));

    // v9.1 RADAR PERFORMANCE JOURNAL — every ~80 ticks recompute the radar
    // performance forensics and persist the digest to EngineSetting
    // "pump.performance" (the channel the governor/advisor/engine-memory read).
    if (tickCount % 80 === 0) {
      void computePumpPerformance()
        .then((perf) => persistPumpPerformance(perf))
        .catch((e) => console.error("[pump-performance]", e));
    }

    // v9.1 RAW-CAL CAPTURE — operator-ordered unfiltered issuance for the AI
    // CALIBRATION book. Self-throttled inside (spacing + open-cap + auto-lift
    // at the 100-settled bar); fire-and-forget, never blocks the tick.
    if (tickCount % 10 === 0) {
      void maybeRawCalDeploy().catch((e) => console.error("[raw-cal]", e));
    }

    // v9.2 RAW-CAL PACE MONITOR — telemetry snapshot (self-throttled to one
    // journal row / 10min inside) + idempotent milestone ledger (audited
    // events at 50/60/70/80/90/95/100 EPOCH-2 settled; Telegram for 90+).
    if (tickCount % 20 === 0) {
      void recordRawcalSnapshot().catch((e) => console.error("[rawcal-snap]", e));
      void checkRawcalMilestones().catch((e) => console.error("[rawcal-milestones]", e));
      void checkRawcalStallAlarm().catch((e) => console.error("[rawcal-stall]", e)); // v9.2.1 — push rhythm breaks (2h/type cooldown)
      void recordRawcalQuality().catch((e) => console.error("[rawcal-quality]", e)); // v9.3 — sample-quality journal (10min cadence, forced on new settles)
    }

    const spawned = await autoSpawn(activeCount);
    await flavorEvents(assets);

    // v8.2 SHADOW-VETO — paper sweep for the would-have-won ledger (in-memory
    // rung/tranche/fee accounting; no-op while no paper positions are open)
    // + periodic real-outcome closure for linked verdicts.
    if (shadowPaperCount() > 0) {
      void shadowPaperSweep(new Map(assets.map((a) => [a.symbol, a.price]))).catch((e) => console.error("[shadow-paper]", e));
    }
    // v10.13 NEAR-MISS — paper sweep for the near-miss evidence ledgers (same
    // price map; no-op while no NM papers are open)
    if (nearMissOpenCount() > 0) {
      void nearMissSweep(new Map(assets.map((a) => [a.symbol, a.price]))).catch((e) => console.error("[near-miss]", e));
    }
    if (tickCount % 40 === 0) {
      void retroLinkRealDeploys().catch((e) => console.error("[shadow-retrolink]", e)); // v8.4.3 — repair REAL-arm starvation race, then close outcomes below
      void closeRealOutcomes().catch((e) => console.error("[shadow-close]", e));
      // v9.3 AUTO-PROMOTION WATCHDOG (operator mandate ج): the moment the
      // shadow-veto evidence arms fill (n≥30/30 + Wilson-LB separation +
      // negative would-veto net), mode flips shadow→veto BY ITSELF — the
      // criteria are unchanged, only the operator-flip latency is removed.
      void maybeAutoPromote()
        .then(async (r) => {
          if (!r.promoted) return;
          await fireEvent(null, null, "SYSTEM", "success", r.detail);
          await sendDirect(r.detail);
        })
        .catch((e) => console.error("[shadow-promote]", e));
    }

    // v10.2 SV-TELEMETRY HUB — per-arm feed wiring + consolidated JSON
    // persistence (.data/shadow-veto-telemetry.json). Self-throttled to 10min
    // inside the module (this call is just a Date.now() compare per tick).
    // New alerts (arm starvation, link leak, closure backlog, promotion-ready)
    // are pushed to the operator relay + event tape by the capture itself.
    void captureSvTelemetry().catch((e) => console.error("[sv-telemetry]", e));

    // calibration hook: recompute every ~60 ticks
    if (tickCount - calibLastAt >= 60) {
      calibLastAt = tickCount;
      const { state, auditLine } = await refreshCalibration();
      if (auditLine) await fireEvent(null, null, "ENGINE", "ai", auditLine);
      else if (state.status === "OBSERVING" && tickCount % 600 === 0) await fireEvent(null, null, "ENGINE", "info", `AI CALIBRATION: OBSERVING ${state.settled}/${state.target} settled — weights go ACTIVE at ${state.target}`);
    }

    // v5.0 SCHEDULERS — learner re-run + AI governor (both internally throttled;
    // heavy LLM agents are dynamic imports — P1 review, off the boot path)
    if (tickCount % 40 === 0) {
      void maybeAutoLearner().catch((e) => console.error("[learner:auto]", e));
      void import("@/lib/governor").then((m) => m.maybeAutoGovernor()).catch((e) => console.error("[governor:auto]", e));
      // v8.4.1 N3 — active neural-link recovery probe (internally throttled 5min)
      void import("@/lib/ai")
        .then((m) => m.maybeNeuralAutoProbe())
        .then((r) => {
          if (r?.ok) return fireEvent(null, null, "ENGINE", "info", "NEURAL PROBE OK — LLM link restored, 429 shield reset (streak cleared); MODEL verdicts resume automatically.");
        })
        .catch((e) => console.error("[neural-probe]", e));
    }

    // v5.2 AI SUPERVISOR — watchdog above the governor (every ~2min, audited)
    if (tickCount % 30 === 0) {
      void import("@/lib/supervisor").then((m) => m.maybeSupervise()).catch((e) => console.error("[supervisor]", e));
    }

    // v5.4 DEEP-LEARN — full-TP (TP3) + stop-out research Q&A; internally
    // throttled to one cycle per 30min, lessons persisted + agent-grounded
    if (tickCount % 75 === 0) {
      void import("@/lib/tp3-lab").then((m) => m.maybeAutoDeepLearn()).catch((e) => console.error("[deep-learn]", e));
    }

    // v6.6 AI ADVISOR — evidence-gated calibration proposals the operator must
    // approve (Q3 mandate). Dynamic import keeps the LLM-free module off the boot
    // path; the advisor itself is deterministic (no LLM call) and self-throttled
    // to one cycle per 6h — proposals queue in the AI CORE advisor panel + Telegram.
    if (tickCount % 40 === 0) {
      void import("@/lib/advisor").then((m) => m.maybeRunAdvisor()).catch((e) => console.error("[advisor:auto]", e));
    }

    // v10.0 SHADOW MODULES — the four operator-approved modules (mandate
    // 2026-09-15: «اجرای چهار ماژول را مهندسی شده و کامل انجام بده»):
    // R1 risk-governor · R2 time-governor · R5 ui-canary on the ~2min rail,
    // R6 senior-review nightly (post-daily-report window). The registry
    // self-throttles every member (15min / 60min / 6h / once-per-Tehran-night),
    // rides the global SHADOW/ENGAGED authority switch ("governor-modules.mode"),
    // is fire-and-forget, and NEVER touches the deploy path.
    if (tickCount % 30 === 0) {
      void import("@/lib/shadow-modules").then((m) => m.maybeRunShadowModules()).catch((e) => console.error("[shadow-modules]", e));
    }

    // v8.0 MULTI-TF FLOW SCANNER (EPOCH-2) — rotating batch (6 symbols/call,
    // full domain in ~10-16min) builds the per-TF flow board the deploy gate
    // and the FLOW-SHIFT tracker consume. Internally throttled ≥60s.
    if (tickCount % 25 === 0 && assets.length > 0) {
      void maybeFlowScan(assets.map((a) => a.symbol)).catch((e) => console.error("[flow-scan]", e));
    }
    if (tickCount % 50 === 0) {
      void flowShiftTracking().catch((e) => console.error("[flow-shift]", e));
    }

    // v8.1 P1 OI/FUNDING BOARD — same rotating-batch doctrine as the flow
    // scanner (6 symbols/call, ≥60s): OI Δ15m/1h/4h + funding for the whole
    // domain. Feeds the liq-heatmap OI scaling, the L3P pre-cascade layer and
    // the /api/oi-funding board.
    if (tickCount % 25 === 0 && assets.length > 0) {
      void maybeOiFundScan(assets.map((a) => a.symbol)).catch((e) => console.error("[oi-fund]", e));
    }
    // v8.1 P1 LIQ-HEAT WARMUP — pre-compute estimated clusters for the top-8
    // OI symbols every ~2.7min (compute is cache-bound, TTL 3min, map ≤64).
    if (tickCount % 45 === 0 && assets.length > 0) {
      void (async () => {
        const board = await getOiFundBoard();
        for (const r of board.rows.slice(0, 8)) await getLiqHeat(r.symbol).catch(() => undefined);
      })().catch((e) => console.error("[liq-heat]", e));
    }
    // v8.1 P2 VOL-REGIME SCAN — on-demand board warm for the top-8 volume
    // symbols (kline cache TTL 120s bounds the REST cost; the deploy path and
    // /api/vol-forecast read the same cache).
    if (tickCount % 30 === 0 && assets.length > 0) {
      void getVolBoard(assets.slice(0, 8).map((a) => a.symbol), 8).catch((e) => console.error("[vol-board]", e));
    }

    // v8.2 VERDICT GAUGE — shadow sweep keeps the decision-border ladder live
    // between real gate evaluations (6 symbols/~28s, per-symbol spacing 150s);
    // rows are journaled source:"shadow" — telemetry, never deploy attempts.
    if (tickCount % 8 === 0 && assets.length > 0) {
      void shadowGateSweep(assets).catch((e) => console.error("[shadow-sweep]", e));
    }
    // v8.2 VERDICT-CORE — the central core studies the gate journal
    // (internally self-throttled to one cycle per 30min).
    if (tickCount % 150 === 0) {
      void maybeAutoVerdictLearn().catch((e) => console.error("[verdict-core]", e));
    }

    // v5.1 TRIGGER BUS — event-driven rotation over the FULL scan domain (3/cycle ≈70s:
    // 48 perps ⇒ a complete flow sweep every ~19min — the whole domain, not a top-12 elite)
    if (tickCount % 20 === 0) {
      const busSymbols = assets.map((a) => a.symbol);
      void runTriggerCycle(busSymbols).catch((e) => console.error("[trigger-bus]", e));
      // actionable trigger spawn: use the freshest acted L1/L2 event
      const bus = getTriggerBusSummary();
      const actionable = bus.last.find((t) => t.acted && (t.layer === "L1_TAKER_SWEEP" || (t.layer === "L2_VACUUM" && t.strength >= 0.5)) && Date.now() - t.at < 90_000);
      if (actionable) void triggerSpawn(actionable.symbol, actionable.side, actionable.price ?? undefined);
    }

    // v5.2 LAYER-0 REGIME ROTATION — classify a rotating batch of 6 assets every
    // 10 ticks so the Market Regimes strip stays stable across the WHOLE domain
    // (previously the memo only filled for deploy-scan candidates and expired
    // to an empty "warming" card whenever no browser was polling).
    if (tickCount % 10 === 0 && assets.length > 0) {
      const batch: Array<Promise<unknown>> = [];
      for (let i = 0; i < 6; i++) {
        const a = assets[(regimeCursor + i) % assets.length]!;
        batch.push(
          (async () => {
            try {
              const candles = await fetchKlines(a.symbol, "15m", 96);
              getRegimeCached(a.symbol, candles);
            } catch {
              /* regime refresh is best-effort */
            }
          })()
        );
      }
      regimeCursor = (regimeCursor + 6) % assets.length;
      void Promise.all(batch).catch(() => undefined);
    }

    return { ran: true, resolved, leveled, spawned, tickCount };
  } finally {
    ticking = false;
  }
}

export function getEngineTickInfo(): { tickCount: number; heartbeat: boolean; lastTickAgeMs: number | null } {
  return {
    tickCount,
    heartbeat: !!g.__nexusHeartbeat,
    lastTickAgeMs: lastTick ? Date.now() - lastTick : null,
  };
}

export async function countActive(): Promise<number> {
  return db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } });
}

export async function getFlowHealthForPulse() {
  const [flow, liq] = await Promise.all([Promise.resolve(getFlowStatus()), getLiquidationStatus()]);
  return { flow, liq };
}

export { getTriggerBusSummary, fetchFlowMetrics, describeGate };
