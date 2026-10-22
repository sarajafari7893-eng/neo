// ── FlowRadar Neo trigger hierarchy + event-driven bus (server-only, v5.0) ──
// Replaces "scan every 15 minutes" with REACTION: the fastest movers (taker
// sweeps, book imbalance) are millisecond-to-second phenomena — a periodic scan
// always arrives late. The bus measures the trigger-hierarchy layers on real
// exchange data and, when a trigger fires WITH fuel confirmed, hands the engine
// an immediate candidate (which still passes EVERY deployment gate).
//
// Layer  1   AGGRESSIVE TAKER SWEEP   — aggTrades same-side burst (seconds)
// Layer  1.5 ORDER-BOOK IMBALANCE     — depth top-band OBI, spoof-guarded (seconds)
// Layer  2   LIQUIDITY VACUUM / WALL  — ±2% depth map gaps & clusters (seconds-minutes)
// Layer  3   LIQUIDATION CASCADE      — REAL forceOrder stream + OI (minutes)
// Layer  3.5 LEVERAGE CROWDING        — funding extreme + OI z-jump (hours)
// Layer  4   MACRO FLOWS              — v6.2: key-less measurable source found
//            (Crypto Fear & Greed Index, alternative.me — no API key). Extreme
//            readings fire contrarian context triggers; unreachable source
//            keeps the honest OBSERVING declaration, never fabricated.

import { gateFetch } from "./fapi-gate";
import { bridgeTape, bridgeDepth } from "./flow-bridge"; // v12.3 TASK-52 — tape/depth ladders
import { getLiquidationSnapshot } from "./liquidations";
import { fetchFlowMetrics, getFlowHistory } from "./flow";
import { peekRegime } from "./regime";
import { getMacroSnapshot, peekMacro } from "./macro";
import { peekLiqHeat } from "./liq-heatmap";
import { peekOiFund } from "./oi-funding";
import { peekVolForecast } from "./vol-forecast";
import { db } from "@/lib/db";

export type TriggerLayer = "L1_TAKER_SWEEP" | "L15_OBI_IMBALANCE" | "L2_VACUUM" | "L3_LIQ_CASCADE" | "L3P_LIQ_PRE" | "L35_CROWD_JUMP" | "L4_MACRO";

export interface TriggerEvent {
  at: number;
  layer: TriggerLayer;
  symbol: string;
  side: "LONG" | "SHORT" | "NEUTRAL";
  strength: number; // 0..1
  detail: string;
  acted: boolean;
  regime: string | null;
  price?: number | null; // v9.3 — event-instant mid price (anti-late-entry chase reference)
}

export interface TriggerBusSummary {
  counts: Record<TriggerLayer, number>;
  last: TriggerEvent[];
  rotation: number;
  rotationSize: number;
  lastCycleAt: number | null;
  lastSpawnAt: number | null;
  suppressed: string[];
  crowdCut: string[];
  macroNote: string;
  // v5.2 observability + wedge armor
  cyclesStarted: number;
  cyclesCompleted: number;
  cycleInFlight: boolean;
  lastCycleMs: number | null;
  lastCycleError: string | null;
}

export const LAYER_LABEL: Record<TriggerLayer, string> = {
  L1_TAKER_SWEEP: "L1 · TAKER SWEEP",
  L15_OBI_IMBALANCE: "L1.5 · OBI",
  L2_VACUUM: "L2 · VACUUM",
  L3_LIQ_CASCADE: "L3 · LIQ CASCADE",
  L3P_LIQ_PRE: "L3P · LIQ PRE",
  L35_CROWD_JUMP: "L3.5 · CROWDING",
  L4_MACRO: "L4 · MACRO",
};

const RING_CAP = 40;
const PERSIST_KEY = "triggerbus";
const SPAWN_COOLDOWN_MS = 8 * 60_000; // max 1 trigger-spawned deploy / 8min
const COUNTER_CASCADE_SUPPRESS_MS = 10 * 60_000;
const CROWD_CUT_MS = 30 * 60_000;

// ── module state ────────────────────────────────────────────────
// TASK-40 (2026-09-27, operator bug report «Trigger Bus داده‌ها را از دست می‌دهد»):
// GENERATION-PROOF STATE. Next dev bundles one module instance per route, so
// module-scoped state forks per bundle (the v10.16 serial-mutex lesson in
// engine.ts). The old code was doubly broken:
//   1. A fresh generation restored NOTHING (its `restored` flag was private)
//      and its first fire()/markTriggerSpawn() persisted ALL-ZERO counts over
//      the good EngineSetting row — permanent destruction, observed live
//      2026-09-27 09:50 (row zeroed while lastCycleAt stayed fresh).
//   2. restore() latched `restored = true` even on a TRANSIENT DB error, so a
//      hiccup under memory pressure froze a zeroed generation that then
//      faithfully overwrote every later persist.
// Counters/ring now live on globalThis (shared by every generation in the
// process), restore() merges with MAX (monotonic counters) + deduped ring,
// and persist() is DENIED until a successful restore (or a confirmed-fresh
// row) — the zero-overwrite destroyer is structurally impossible now.
interface NexusTriggerState {
  counts: Record<TriggerLayer, number>;
  ring: TriggerEvent[];
  lastCycleAt: number | null;
  lastSpawnAt: number;
}
const gState = globalThis as { __nexusTriggerState?: NexusTriggerState };
const S: NexusTriggerState = gState.__nexusTriggerState ?? {
  counts: {
    L1_TAKER_SWEEP: 0,
    L15_OBI_IMBALANCE: 0,
    L2_VACUUM: 0,
    L3_LIQ_CASCADE: 0,
    L3P_LIQ_PRE: 0,
    L35_CROWD_JUMP: 0,
    L4_MACRO: 0,
  },
  ring: [],
  lastCycleAt: null,
  lastSpawnAt: 0,
};
gState.__nexusTriggerState = S;
const { counts, ring } = S; // shared references — mutations flow through S
let cursor = 0;
let rotationSize = 40;
let cycleInFlight = false;
let macroAnnounced = false;

const cascadeUntil = new Map<string, number>(); // counter-cascade suppression
const crowdCutUntil = new Map<string, number>(); // size-cut windows
const lastOBI = new Map<string, { at: number; obi: number }>(); // spoof guard
const lastTriggerAt = new Map<string, number>(); // per-symbol+layer cooldown

const measCache = new Map<string, { at: number; v: unknown }>();
const MEAS_TTL = 35_000;

// ── measurement primitives (all real endpoints, cached) ────────
// v10.24 Task 34-a: through the central fapi-gate, CRITICAL lane — the
// reaction layer rides ahead of the telemetry scanners when the weight
// budget tightens (one 250ms negative retry, then an honest null).
async function fapi<T>(path: string, timeoutMs = 5500): Promise<T | null> {
  return gateFetch<T>(path, { priority: "critical", timeoutMs });
}

interface AggTrade {
  p: number;
  q: number;
  T: number;
  m: boolean; // isBuyerMaker → m=false means the TAKER bought
}

interface TakerSweep {
  buyUsd: number;
  sellUsd: number;
  sweepSide: "LONG" | "SHORT" | null;
  sweepUsd: number;
  dominance: number;
}

/** L1 — aggressive taker sweep over the last 60s of real aggTrades. */
async function measureTakerSweep(symbol: string): Promise<TakerSweep | null> {
  const ck = `agg:${symbol}`;
  const hit = measCache.get(ck);
  if (hit && Date.now() - hit.at < MEAS_TTL) return hit.v as TakerSweep | null;
  // v12.3 TASK-52: fapi aggTrades (w20) is rung 1 — during fapi starvation the
  // sweep survives on the bridge ladder (BYBIT tape → SPOT-MIRROR, honest venue).
  let trades = await fapi<AggTrade[]>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=1000`);
  if (!trades || trades.length < 10) {
    const b = await bridgeTape(symbol).catch(() => null);
    if (b && b.trades.length >= 10) trades = b.trades.map((t) => ({ p: t.price, q: t.qty, T: t.time, m: t.isBuyerMaker }));
  }
  if (!trades || trades.length < 10) {
    measCache.set(ck, { at: Date.now(), v: null });
    return null;
  }
  const cutoff = Date.now() - 60_000;
  let buyUsd = 0;
  let sellUsd = 0;
  for (const t of trades) {
    if (t.T < cutoff) continue;
    const usd = t.p * t.q;
    if (t.m) sellUsd += usd;
    else buyUsd += usd;
  }
  const total = buyUsd + sellUsd;
  const dominant = Math.max(buyUsd, sellUsd);
  const res = {
    buyUsd: Math.round(buyUsd),
    sellUsd: Math.round(sellUsd),
    sweepSide: total >= 250_000 && dominant >= 250_000 && dominant >= total * 0.62 ? ((buyUsd > sellUsd ? "LONG" : "SHORT") as "LONG" | "SHORT") : null,
    sweepUsd: Math.round(dominant),
    dominance: total > 0 ? dominant / total : 0,
  };
  measCache.set(ck, { at: Date.now(), v: res });
  return res;
}

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthMeasure {
  mid: number;
  obi: number;
  vacuum: { side: "ABOVE" | "BELOW"; widthPct: number; edgeDistPct: number } | null;
  wall: { side: "BID" | "ASK"; priceDistPct: number; usd: number } | null;
}

/** L1.5 + L2 — order-book imbalance + ±2% vacuum/wall map from one depth snapshot. */
async function measureDepth(symbol: string): Promise<DepthMeasure | null> {
  const ck = `depth:${symbol}`;
  const hit = measCache.get(ck);
  if (hit && Date.now() - hit.at < MEAS_TTL) return hit.v as DepthMeasure | null;
  // v12.3 TASK-52: depth rides the ladder — fapi (w5) → BYBIT linear book →
  // SPOT-MIRROR book; OBI/vacuum math is venue-shape-agnostic (bids DESC / asks ASC).
  const d = await bridgeDepth(symbol, 500);
  if (!d || d.bids.length === 0 || d.asks.length === 0) {
    measCache.set(ck, { at: Date.now(), v: null });
    return null;
  }
  const bids: DepthLevel[] = d.bids.map(([p, q]) => ({ price: p, qty: q }));
  const asks: DepthLevel[] = d.asks.map(([p, q]) => ({ price: p, qty: q }));
  const mid = (bids[0]!.price + asks[0]!.price) / 2;

  // OBI over the top ±0.5% band
  let bidNot = 0;
  let askNot = 0;
  for (const b of bids) if (b.price >= mid * 0.995) bidNot += b.price * b.qty; else break;
  for (const a of asks) if (a.price <= mid * 1.005) askNot += a.price * a.qty; else break;
  const obi = askNot > 0 ? bidNot / askNot : 1;

  // ±2% map: find the widest liquidity gap (vacuum) and the biggest single wall
  const band = 0.02;
  const buckets = 40;
  const bucketUsd = new Array<number>(buckets).fill(0);
  const push = (price: number, qty: number) => {
    const dev = (price - mid) / mid;
    if (Math.abs(dev) > band) return;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((dev + band) / (2 * band)) * buckets)));
    bucketUsd[idx]! += price * qty;
  };
  for (const b of bids) push(b.price, b.qty);
  for (const a of asks) push(a.price, a.qty);

  const nonZero = bucketUsd.filter((v) => v > 0);
  const median = nonZero.length ? [...nonZero].sort((a, b) => a - b)[Math.floor(nonZero.length / 2)]! : 0;

  let vacuum: { side: "ABOVE" | "BELOW"; widthPct: number; edgeDistPct: number } | null = null;
  if (median > 0) {
    let bestStart = -1;
    let bestLen = 0;
    let curStart = -1;
    for (let i = 0; i < buckets; i++) {
      const empty = bucketUsd[i]! < median * 0.15;
      if (empty && curStart < 0) curStart = i;
      if ((!empty || i === buckets - 1) && curStart >= 0) {
        const len = (empty ? i + 1 : i) - curStart;
        if (len > bestLen) {
          bestLen = len;
          bestStart = curStart;
        }
        curStart = -1;
      }
    }
    if (bestLen >= 4) {
      const midIdx = bestStart + bestLen / 2;
      const devMid = (midIdx / buckets) * 2 * band - band;
      const edgeDev = (bestStart / buckets) * 2 * band - band;
      vacuum = {
        side: devMid >= 0 ? "ABOVE" : "BELOW",
        widthPct: Number(((bestLen / buckets) * 2 * band * 100).toFixed(2)),
        edgeDistPct: Number((Math.abs(edgeDev) * 100).toFixed(2)),
      };
    }
  }

  // wall: biggest single level within ±2%
  let wall: { side: "BID" | "ASK"; priceDistPct: number; usd: number } | null = null;
  for (const b of bids) {
    const usd = b.price * b.qty;
    if (!wall || usd > wall.usd) wall = { side: "BID", priceDistPct: Number((((mid - b.price) / mid) * 100).toFixed(2)), usd: Math.round(usd) };
  }
  for (const a of asks) {
    const usd = a.price * a.qty;
    if (!wall || usd > wall.usd) wall = { side: "ASK", priceDistPct: Number((((a.price - mid) / mid) * 100).toFixed(2)), usd: Math.round(usd) };
  }

  const res = { mid: Number(mid.toFixed(mid > 100 ? 2 : 6)), obi: Number(obi.toFixed(3)), vacuum, wall };
  measCache.set(ck, { at: Date.now(), v: res });
  return res;
}

// ── trigger firing ──────────────────────────────────────────────
// v9.3: fire() stamps the event-instant mid price so the engine's ANTI-LATE-
// ENTRY guard can measure how far price ran between the TRIGGER and the deploy.
function fire(layer: TriggerLayer, symbol: string, side: "LONG" | "SHORT" | "NEUTRAL", strength: number, detail: string, acted = false, price?: number | null): TriggerEvent {
  const ev: TriggerEvent = { at: Date.now(), layer, symbol, side, strength: Number(strength.toFixed(2)), detail, acted, regime: peekRegime(symbol)?.label ?? null, price: typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null };
  ring.unshift(ev);
  if (ring.length > RING_CAP) ring.pop();
  counts[layer]++;
  lastTriggerAt.set(`${layer}:${symbol}`, ev.at);
  void persist();
  return ev;
}

function cooled(layer: TriggerLayer, symbol: string, ms = 4 * 60_000): boolean {
  const t = lastTriggerAt.get(`${layer}:${symbol}`);
  return !t || Date.now() - t > ms;
}

export function isCounterCascadeSuppressed(symbol: string): boolean {
  const t = cascadeUntil.get(symbol);
  return !!t && Date.now() < t;
}

export function isCrowdCut(symbol: string): boolean {
  const t = crowdCutUntil.get(symbol);
  return !!t && Date.now() < t;
}

async function persist(): Promise<void> {
  if (!restoreOk) return; // TASK-40: never overwrite an unrestored (possibly good) row with cold state
  try {
    const value = JSON.stringify({ counts: S.counts, last: S.ring.slice(0, RING_CAP), lastCycleAt: S.lastCycleAt, lastSpawnAt: S.lastSpawnAt });
    await db.engineSetting.upsert({ where: { key: PERSIST_KEY }, create: { key: PERSIST_KEY, value }, update: { value } });
  } catch {
    /* non-fatal */
  }
}

/** Restore counters/ring after a dev-server restart.
 * TASK-40 hardening: a TRANSIENT DB error no longer latches the restore —
 * failed restores retry on the next cycle and persist() stays denied until
 * this succeeds. Counters merge MAX (they are monotonic), the ring merges
 * deduped by at|layer|symbol: a double-restore or a racing generation can
 * never move the visible numbers backwards. */
let restoreOk = false;
async function restore(): Promise<void> {
  if (restoreOk) return;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: PERSIST_KEY } });
    if (!row) {
      restoreOk = true; // confirmed fresh — first persist may create the row
      return;
    }
    const v = JSON.parse(row.value) as { counts?: Record<TriggerLayer, number>; last?: TriggerEvent[]; lastCycleAt?: number | null; lastSpawnAt?: number };
    // layer-set evolution guard + MAX-merge — a layer added after the persist
    // was written would otherwise sit at undefined and NaN on the first ++
    for (const k of Object.keys(S.counts) as TriggerLayer[]) {
      const disk = Number(v.counts?.[k] ?? 0);
      S.counts[k] = Math.max(S.counts[k] ?? 0, Number.isFinite(disk) ? disk : 0);
    }
    const seen = new Set(S.ring.map((e) => `${e?.at}|${e?.layer}|${e?.symbol}`));
    for (const e of (v.last ?? []).slice(0, RING_CAP)) {
      if (!e || typeof e.at !== "number") continue;
      const k = `${e.at}|${e.layer}|${e.symbol}`;
      if (seen.has(k)) continue;
      seen.add(k);
      S.ring.push(e);
    }
    S.ring.sort((a, b) => b.at - a.at);
    if (S.ring.length > RING_CAP) S.ring.length = RING_CAP;
    if (typeof v.lastCycleAt === "number") S.lastCycleAt = Math.max(S.lastCycleAt ?? 0, v.lastCycleAt);
    S.lastSpawnAt = Math.max(S.lastSpawnAt, v.lastSpawnAt ?? 0);
    restoreOk = true;
  } catch {
    /* transient DB hiccup — NOT latched; next cycle retries; persist stays denied */
  }
}

/** Scan ONE symbol through the whole hierarchy; returns acted triggers. */
export async function scanSymbolTriggers(symbol: string): Promise<TriggerEvent[]> {
  const fired: TriggerEvent[] = [];

  const depth = await measureDepth(symbol);
  if (!depth) return fired;
  const px = depth.mid; // v9.3 — event-instant reference price for every layer below

  // L1.5 — persistent OBI extreme (spoof guard: needs 2 consecutive extreme reads)
  // v6.7 FIX (dead-layer root cause): the guard window was 90s, but the bus
  // rotates 3 symbols/cycle over a ≤64-symbol domain — each symbol is re-scanned
  // every ~10-20min, so `prev.at` was ALWAYS older than 90s and L15 could never
  // fire (count stuck at 0 since launch). A spoofed wall must now survive one
  // full rotation (~10-20min of real depth) — a STRICTER guard, not a looser one.
  const prev = lastOBI.get(symbol);
  lastOBI.set(symbol, { at: Date.now(), obi: depth.obi });
  if (cooled("L15_OBI_IMBALANCE", symbol) && prev && Date.now() - prev.at < 30 * 60_000) {
    const extreme = depth.obi >= 2.5 || depth.obi <= 0.4;
    const sameDir = Math.sign(depth.obi - 1) === Math.sign(prev.obi - 1);
    if (extreme && sameDir) {
      const side = depth.obi > 1 ? "LONG" : "SHORT";
      fired.push(fire("L15_OBI_IMBALANCE", symbol, side, Math.min(1, Math.abs(depth.obi - 1) / 1.5), `book imbalance ${depth.obi.toFixed(2)}× (bid/ask notional, ±0.5% band) held across 2 snapshots — ${side === "LONG" ? "bids" : "asks"} stacked`, false, px));
    }
  }

  // L1 — taker sweep, with OBI alignment check (the money combo)
  const sweep = await measureTakerSweep(symbol);
  if (sweep && sweep.sweepSide && cooled("L1_TAKER_SWEEP", symbol)) {
    const obiAligned = sweep.sweepSide === "LONG" ? depth.obi >= 1.3 : depth.obi <= 0.77;
    if (obiAligned) {
      const strength = Math.min(1, (sweep.dominance - 0.62) / 0.38 * 0.5 + Math.min(1, sweep.sweepUsd / 1_500_000) * 0.5);
      const ev = fire("L1_TAKER_SWEEP", symbol, sweep.sweepSide, strength, `aggressive ${sweep.sweepSide === "LONG" ? "buy" : "sell"} sweep $${(sweep.sweepUsd / 1000).toFixed(0)}K/60s (${Math.round(sweep.dominance * 100)}% dominant) + OBI ${depth.obi.toFixed(2)} aligned — liquidity consumed toward the thin side`, true, px);
      fired.push(ev);
    } else {
      fired.push(fire("L1_TAKER_SWEEP", symbol, sweep.sweepSide, strength0(sweep.dominance), `sweep $${(sweep.sweepUsd / 1000).toFixed(0)}K/60s but OBI ${depth.obi.toFixed(2)} NOT aligned — recorded as fuel, no spawn`, false, px));
    }
  }

  // L2 — vacuum edge within reach (fuel for the move INTO the gap)
  if (depth.vacuum && cooled("L2_VACUUM", symbol)) {
    const v = depth.vacuum;
    if (v.edgeDistPct <= 0.35 && v.widthPct >= 0.4) {
      const side = v.side === "ABOVE" ? "LONG" : "SHORT";
      const sweptIntoIt = sweep && sweep.sweepSide === side;
      fired.push(fire("L2_VACUUM", symbol, side, Math.min(1, v.widthPct / 1.2), `liquidity vacuum ${v.widthPct}% wide ${v.side.toLowerCase()} mid (edge ${v.edgeDistPct}% away) — ${sweptIntoIt ? "sweep already filling it: momentum fuel with open path" : "air pocket ahead; sweep into it accelerates"}`, !!sweptIntoIt, px));
    }
  }

  // wall opposite the vacuum path is reported inside detail when relevant (wall data feeds flow display)

  // L3 — REAL liquidation cascade (forceOrder stream) + anti-cascade veto window
  const snap = await getLiquidationSnapshot();
  if (snap && snap.status.connected && !snap.status.dataStalled && cooled("L3_LIQ_CASCADE", symbol)) {
    const row = snap.bySymbol[symbol];
    if (row && row.usd10m >= 1_500_000) {
      const dom = Math.max(row.longsUsd10m, row.shortsUsd10m) / Math.max(1, row.usd10m);
      if (dom >= 0.6) {
        const wreckedSide = row.longsUsd10m > row.shortsUsd10m ? "LONG" : "SHORT";
        cascadeUntil.set(symbol, Date.now() + COUNTER_CASCADE_SUPPRESS_MS);
        fired.push(fire("L3_LIQ_CASCADE", symbol, wreckedSide === "LONG" ? "SHORT" : "LONG", Math.min(1, row.usd10m / 5_000_000), `cascade: $${(row.usd10m / 1e6).toFixed(2)}M ${wreckedSide.toLowerCase()}s liquidated in 10m (${Math.round(dom * 100)}% one-sided) — counter-cascade entries suppressed 10min; exhaustion setup armed`, false, px));
      }
    }
  }

  // L3P — v8.1 P1 PREDICTIVE PRE-CASCADE (engineering opinion, operator-approved):
  // L3 only reacts once a cascade is ALREADY flowing through the forceOrder
  // stream. This layer watches the LIQUIDATION HEATMAP estimate + the OI board:
  // price drifting within reach of a dense cluster WHILE positions are still
  // piling in (OI Δ1h ≥ +1% or OI z ≥ +1) is the cascade BEFORE it happens —
  // the magnet warning. Zero extra fetches: both caches are warm from the
  // tick rotation. Telemetry fuel (acted=false) — deploys still pass the gates.
  if (cooled("L3P_LIQ_PRE", symbol, 8 * 60_000)) {
    const heat = peekLiqHeat(symbol);
    const oif = peekOiFund(symbol);
    if (heat && oif) {
      const nearest = heat.nearestBelow && heat.nearestAbove
        ? (Math.abs(heat.nearestBelow.distPct) <= Math.abs(heat.nearestAbove.distPct) ? heat.nearestBelow : heat.nearestAbove)
        : (heat.nearestBelow ?? heat.nearestAbove);
      const volRow = peekVolForecast(symbol);
      const reachPct = Math.max(0.35, (volRow?.atr15mPct ?? 1) * 0.35); // 0.35×ATR band, 0.35% floor
      const oiPiling = (oif.oiDelta1h !== null && oif.oiDelta1h >= 1) || (oif.oiZ1h !== null && oif.oiZ1h >= 1);
      if (nearest && Math.abs(nearest.distPct) <= reachPct && oiPiling) {
        const cascadeSide: "LONG" | "SHORT" = nearest.side === "LONGS_BELOW" ? "SHORT" : "LONG";
        fired.push(fire("L3P_LIQ_PRE", symbol, cascadeSide, Math.min(1, nearest.sharePct / 25), `PRE-CASCADE: est. ${nearest.estUsdM}${heat.oiScaled ? "M OI-scaled" : "M (unscaled est.)"} ${nearest.side === "LONGS_BELOW" ? "long" : "short"} liq cluster ${Math.abs(nearest.distPct).toFixed(2)}% ${nearest.distPct < 0 ? "below" : "above"} price (reach ${reachPct.toFixed(2)}%) + OI ${oif.oiDelta1h !== null ? `${oif.oiDelta1h >= 0 ? "+" : ""}${oif.oiDelta1h.toFixed(2)}%/1h` : `z ${oif.oiZ1h}`} still piling — cascade magnet armed ${cascadeSide === "SHORT" ? "down" : "up"}`, false, px));
      }
    }
  }

  // L3.5 — leverage crowding: funding extreme + OI acceleration
  if (cooled("L35_CROWD_JUMP", symbol)) {
    const m = await fetchFlowMetrics(symbol);
    if (m && m.funding8h !== null && m.oiDelta1h !== null) {
      const hist = getFlowHistory(symbol);
      const mean = hist.length >= 5 ? hist.reduce((a, h) => a + h.oiDelta1h, 0) / hist.length : 0;
      const jump = m.oiDelta1h >= Math.max(1.5, mean * 2 + 1);
      if (Math.abs(m.funding8h) >= 0.06 && jump) {
        crowdCutUntil.set(symbol, Date.now() + CROWD_CUT_MS);
        const side = m.funding8h > 0 ? "SHORT" : "LONG"; // crowded side gets punished
        fired.push(fire("L35_CROWD_JUMP", symbol, side, Math.min(1, Math.abs(m.funding8h) / 0.15), `leverage crowded: funding ${m.funding8h.toFixed(4)}%/8h + OI ${m.oiDelta1h >= 0 ? "+" : ""}${m.oiDelta1h.toFixed(2)}%/1h (≥2× recent mean) — same-direction size cut 30min`, false, px));
      }
    }
  }

  // L4 — macro flows (v6.2): the key-less Fear & Greed feed gives the layer a
  // REAL measurable source. Extremes (≤20 EXTREME FEAR / ≥80 EXTREME GREED)
  // fire a contrarian context trigger — recorded as fuel, never an auto-spawn
  // (macro context informs, the deployment gates still decide). While the
  // source is unreachable the honest OBSERVING declaration remains.
  if (cooled("L4_MACRO", "MACRO")) {
    const macro = await getMacroSnapshot();
    if (macro && (macro.value <= 20 || macro.value >= 80)) {
      const extremeFear = macro.value <= 20;
      fired.push(fire("L4_MACRO", "MACRO", extremeFear ? "LONG" : "SHORT", Math.min(1, Math.abs(macro.value - 50) / 50), `macro sentiment extreme: Fear & Greed ${macro.value}/100 (${macro.classification}) — contrarian ${extremeFear ? "LONG" : "SHORT"} context fuel (source: alternative.me, key-less, 30min cache)`));
    } else if (!macro && !macroAnnounced && fired.length === 0) {
      macroAnnounced = true;
      counts.L4_MACRO++; // count the honest declaration itself
      fired.push(fire("L4_MACRO", "—", "NEUTRAL", 0, "macro layer — Fear & Greed feed unreachable, no key-less measurable source right now: layer stays OBSERVING, never fabricated"));
    }
  }

  return fired;
}

function strength0(d: number): number {
  return Number(Math.min(1, Math.max(0, (d - 0.62) / 0.38)).toFixed(2));
}

// ── bus cycle: rotate the FULL scan domain, 3 per cycle (v5.1: domain up to 64) ──
// v5.2 WEDGE ARMOR: a cycle is wrapped in a hard timeout — a single hung probe
// (socket that never settles, DB write lock) previously wedged `cycleInFlight`
// forever and silently killed the whole event-driven layer (observed live:
// counts frozen at 0, lastCycleAt null while regimes kept refreshing). Now the
// bus can stall at most one cycle, then self-heals with an audited error.
const CYCLE_TIMEOUT_MS = 60_000;
const SYMBOL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

let cyclesStarted = 0;
let cyclesCompleted = 0;
let lastCycleMs: number | null = null;
let lastCycleError: string | null = null;

async function runTriggerCycleInner(symbols: string[]): Promise<void> {
  await restore();
  rotationSize = Math.max(6, Math.min(64, symbols.length));
  const batch = [symbols[cursor % symbols.length], symbols[(cursor + 1) % symbols.length], symbols[(cursor + 2) % symbols.length]].filter(Boolean) as string[];
  cursor = (cursor + 3) % symbols.length;
  for (const s of batch) {
    await withTimeout(scanSymbolTriggers(s), SYMBOL_TIMEOUT_MS, `trigger scan ${s}`);
  }
  S.lastCycleAt = Date.now();
}

export async function runTriggerCycle(symbols: string[]): Promise<void> {
  if (cycleInFlight || symbols.length === 0) return;
  cycleInFlight = true;
  cyclesStarted++;
  const t0 = Date.now();
  try {
    await withTimeout(runTriggerCycleInner(symbols), CYCLE_TIMEOUT_MS, "trigger cycle");
    cyclesCompleted++;
    lastCycleMs = Date.now() - t0;
    lastCycleError = null;
  } catch (err) {
    lastCycleError = String(err);
    console.error("[trigger-bus] cycle failed:", err);
  } finally {
    cycleInFlight = false;
  }
}

export function canTriggerSpawn(): boolean {
  return Date.now() - S.lastSpawnAt > SPAWN_COOLDOWN_MS;
}

export function markTriggerSpawn(): void {
  S.lastSpawnAt = Date.now();
  void persist();
}

export function getTriggerBusSummary(): TriggerBusSummary {
  // TASK-40: kick the restore on the READ path too — a fresh process used to
  // report zero counts until the first bus cycle ran (a seconds-wide window
  // that reads exactly like "the data was wiped again"). The kick is
  // fire-and-forget; the first poll may still be cold, the next one (≤5s) is
  // already MAX-merged from EngineSetting.
  void restore();
  return {
    counts: { ...S.counts },
    last: S.ring.slice(0, 12),
    rotation: cursor,
    rotationSize,
    lastCycleAt: S.lastCycleAt,
    lastSpawnAt: S.lastSpawnAt || null,
    suppressed: [...cascadeUntil.entries()].filter(([, t]) => Date.now() < t).map(([s]) => s),
    crowdCut: [...crowdCutUntil.entries()].filter(([, t]) => Date.now() < t).map(([s]) => s),
    macroNote: (() => {
      const m = peekMacro();
      return m ? `L4 macro: Fear & Greed ${m.value}/100 (${m.classification}) — key-less source live, 30min cache` : "L4 macro flows: Fear & Greed feed not yet reachable — OBSERVING, never fabricated";
    })(),
    cyclesStarted,
    cyclesCompleted,
    cycleInFlight,
    lastCycleMs,
    lastCycleError,
  };
}

// TASK-40: module-load self-restore — every Turbopack per-route module instance
// pulls its persisted counters/ring the moment it is imported, so even the
// FIRST dashboard poll after a restart/recompile serves real state (the
// getTriggerBusSummary read-path kick is the second line of defense).
void restore().catch(() => undefined);
