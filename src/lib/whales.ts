// ── NEXUS//SIGNALS WHALE & SMART-MONEY TELEMETRY (server-only, v6.4.2) ──
// Operator request (chat): the AI analyst needed live whale tracking and
// smart-money positioning in its grounding bundle. This module measures, from
// Binance USDT-M futures public endpoints:
//   · WHALE TAPE — individual trades ≥ WHALE_MIN_USD in the last 15min window
//     (count, buy vs sell notional, NET aggressive flow direction)
//   · SMART MONEY — top-trader long/short POSITION ratio (accounts with the
//     largest positions — the "smart money" cohort, distinct from the retail
//     crowd L/S the flow gate already reads)
//   · BOOK PRESSURE — top-100 order-book notional imbalance (resting liquidity)
//   · OPEN INTEREST — absolute OI in USD (context for the OIΔ1h the flow shows)
// Every number is measured live; per-symbol failures degrade honestly, nothing
// is invented. Cached 60s — the chat route is hot but the tape does not need
// sub-minute freshness.
//
// v6.4.2 FLOW-RULED DISCOVERY (operator challenge: «چرا باندل نهنگ برای ۶
// نماد ثابت طراحی شده؟ باید طبق قوانین ردیابی جریانات سیستم باشد — فقط
// شناسایی جریانات مهم، نه تمرکز بر ارزهای خاص»): the old bundle hard-sliced
// the top-6 by 24h volume — a FIXED currency bias. Now the whale lens covers
// the SAME dynamic flow-ranked universe the engine scans (UNIVERSE tunable),
// with a two-tier budget:
//   · PINNED tier (full 4-endpoint deep read) — symbols that matter RIGHT
//     NOW: every symbol with an OPEN signal (deployment votes) + every
//     symbol the DISCOVERY sweep caught with live whale prints (hit ring,
//     15min decay). This is exactly how the flow rules behave: attention
//     follows measured flow, never a hardcoded symbol list.
//   · DISCOVERY tier (tape-only, 1 endpoint) — a ROTATING sweep walks the
//     WHOLE tracked universe (SWEEP_BATCH symbols per pass, ~60s cadence),
//     so a 40-symbol domain gets full tape coverage every ~5min. Fresh
//     print clusters pin the symbol into the deep tier and emit a WHALE
//     event via the notifier hook (engine wires it to fireEvent).
// Coverage stats (universe / swept-per-pass / cursor / hits) ship in the
// bundle so the dashboard and the analyst can state honestly what was
// measured vs not-yet-reswept.

import { db } from "@/lib/db";
import { gateFetch } from "./fapi-gate";
import { bridgeTape, bybitTickerRow, bridgeDepth, type TapeTrade } from "./flow-bridge";

const WHALE_MIN_USD = 150_000;
const WHALE_WINDOW_MS = 15 * 60_000;
const CACHE_TTL = 60_000;
const SWEEP_BATCH = 8;            // tape probes per sweep pass (weight ≈ 20/call → ~160/min, inside budget)
const SWEEP_MIN_INTERVAL = 60_000; // sweep passes at most once per minute regardless of pollers
const HIT_TTL_MS = 15 * 60_000;   // a whale hit keeps its pin for 15min after the last print cluster
const HIT_DEEP_CAP = 8;           // max hit-ring symbols promoted to deep reads per bundle
const OPEN_PIN_CAP = 8;           // max open-signal symbols deep-read per bundle
const READS_CAP = 14;             // final display cap, sorted by |net whale flow|

// v10.24 Task 34-a: routed through the central fapi-gate (telemetry lane —
// sheddable; discovery sweep simply retries next rotation). Throw semantics
// preserved for the allSettled/catch callers below.
async function fapi<T>(path: string, timeoutMs = 6000): Promise<T> {
  const v = await gateFetch<T>(path, { priority: "telemetry", timeoutMs });
  if (v === null) throw new Error(`fapi ${path} → unavailable`);
  return v;
}

export interface WhaleSymbolRead {
  symbol: string;
  whales: { count: number; buyUsd: number; sellUsd: number; netUsd: number; largestUsd: number } | null;
  smartLs: number | null; // top-trader position long/short ratio (>1 = smart money net long)
  book: { bidUsd: number; askUsd: number; bidPct: number } | null;
  oiUsd: number | null;
  stale: boolean; // true when this symbol's reads partially failed
}

export type WhalePin = "OPEN" | "WHALE-HIT"; // why this symbol holds a deep-read slot
export type PinnedWhaleRead = WhaleSymbolRead & { pin: WhalePin; hitNetUsd?: number; hitAt?: number };

export interface WhaleBundle {
  at: number;
  windowMin: number;
  minUsd: number;
  reads: PinnedWhaleRead[];
  netWhaleUsd: number; // aggregate net aggressive whale flow across measured symbols
}

export interface WhaleFlowBundle extends WhaleBundle {
  universe: number;       // tracked scan-domain size (same set the engine's flow rules walk)
  sweptLastPass: number;  // symbols tape-probed in the most recent sweep pass
  sweepCursor: number;    // rotation position (debug/coverage honesty)
  sweepSymbols: string[]; // the symbols probed in that last pass
  hitSymbols: string[];   // discovery pins currently alive (15min decay)
  openSymbols: string[];  // open-signal pins (deployment-relevant)
}

export interface WhaleHit {
  symbol: string;
  netUsd: number;
  count: number;
  largestUsd: number;
  fresh: boolean; // true when this is a NEW detection (was not in the hit ring)
}

// v6.4.1: PER-SYMBOL cache (Map) — per-symbol tape caches independently so the
// flow-shortlist, the deploy path, the sweep and the chat share ONE coherent
// cache (the old whole-bundle cache returned STALE SYM_A data for SYM_B).
const symCache = new Map<string, { at: number; read: WhaleSymbolRead | null }>();

export async function getWhaleRead(symbol: string): Promise<WhaleSymbolRead | null> {
  const hit = symCache.get(symbol);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.read;
  const read = await readSymbol(symbol).catch(() => null);
  symCache.set(symbol, { at: Date.now(), read });
  return read;
}

// ── v6.4.2 FLOW-RULED SWEEP — discovery over the WHOLE scan domain ──
// The sweep state is module-global so the dashboard poller, the analyst chat
// and any other caller advance ONE shared rotation (no duplicated probes —
// the per-symbol 60s cache would absorb them anyway, but one cursor keeps
// coverage accounting honest).
const hitRing = new Map<string, { at: number; netUsd: number; count: number; largestUsd: number }>();
let sweepCursor = 0;
let lastSweepAt = 0;
let lastSweepSymbols: string[] = [];
let hitNotifier: ((hit: WhaleHit) => void) | null = null;

/** engine.ts wires this to fireEvent — a NEW whale detection becomes an
 * audited WHALE event in the pulse feed (NOT relayed to Telegram — the
 * RELAYABLE_TYPES set does not include WHALE, so no phone spam). */
export function setWhaleHitNotifier(fn: (hit: WhaleHit) => void): void {
  hitNotifier = fn;
}

/** Tape-only aggregation shared by the deep read and the cheap sweep probe. */
function aggregateWhales(trades: TapeTrade[]): WhaleSymbolRead["whales"] {
  const cutoff = Date.now() - WHALE_WINDOW_MS;
  let buyUsd = 0, sellUsd = 0, count = 0, largestUsd = 0;
  for (const tr of trades) {
    const notional = Number(tr.quoteQty) || Number(tr.price) * Number(tr.qty);
    if (notional < WHALE_MIN_USD || tr.time < cutoff) continue;
    count++;
    if (tr.isBuyerMaker) sellUsd += notional; // maker on bid side ⇒ aggressor sold
    else buyUsd += notional;
    if (notional > largestUsd) largestUsd = notional;
  }
  if (count === 0 && trades.length === 0) return null;
  return { count, buyUsd, sellUsd, netUsd: buyUsd - sellUsd, largestUsd };
}

/** Cheap discovery probe — v12.2 TASK-52: tape LADDER (fapi aggTrades →
 * BYBIT linear recent-trade → SPOT-MIRROR trades) instead of a raw weight-20
 * fapi hit per symbol; during ban windows the sweep keeps flowing on the
 * bridge instead of starving the discovery ring. */
async function probeTape(symbol: string): Promise<WhaleSymbolRead["whales"]> {
  const b = await bridgeTape(symbol);
  if (!b) throw new Error(`tape ${symbol} → unavailable`);
  return aggregateWhales(b.trades);
}

async function sweepPass(universe: string[], openSet: Set<string>): Promise<void> {
  const candidates = universe.filter((s) => !openSet.has(s)); // open pins get deep reads anyway — don't double-spend
  if (!candidates.length) return;
  const batch: string[] = [];
  for (let i = 0; i < Math.min(SWEEP_BATCH, candidates.length); i++) {
    batch.push(candidates[(sweepCursor + i) % candidates.length]);
  }
  sweepCursor = (sweepCursor + SWEEP_BATCH) % candidates.length;
  lastSweepSymbols = batch;
  lastSweepAt = Date.now();
  const results = await Promise.allSettled(batch.map((s) => probeTape(s)));
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || !r.value) return; // probe failed or empty slice — retry next rotation, honest absence
    const sym = batch[i]!;
    const w = r.value;
    if (w.count === 0) return; // no prints ≥ threshold in the scanned slice — nothing to pin
    const prev = hitRing.get(sym);
    const fresh = !prev || Date.now() - prev.at > HIT_TTL_MS;
    hitRing.set(sym, { at: Date.now(), netUsd: w.netUsd, count: w.count, largestUsd: w.largestUsd });
    if (fresh && hitNotifier) {
      try {
        hitNotifier({ symbol: sym, netUsd: w.netUsd, count: w.count, largestUsd: w.largestUsd, fresh });
      } catch { /* notifier must never break the sweep */ }
    }
  });
}

function purgeHitRing(): void {
  const now = Date.now();
  for (const [sym, h] of hitRing) if (now - h.at > HIT_TTL_MS) hitRing.delete(sym);
}

/** v6.4.2 — the flow-ruled bundle: pinned deep reads + rotating discovery.
 * Replaces the old fixed top-6 getWhaleBundle for every consumer. */
export async function getWhaleFlowBundle(): Promise<WhaleFlowBundle | null> {
  const [universeRows, openRows] = await Promise.all([
    db.marketAsset.findMany({ orderBy: { volume24h: "desc" }, select: { symbol: true } }),
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true }, distinct: ["symbol"] }),
  ]);
  const universe = universeRows.map((r) => r.symbol);
  const openSymbols = openRows.map((r) => r.symbol).slice(0, OPEN_PIN_CAP);
  const openSet = new Set(openSymbols);

  purgeHitRing();
  if (universe.length && Date.now() - lastSweepAt >= SWEEP_MIN_INTERVAL) {
    await sweepPass(universe, openSet).catch(() => { /* sweep failure degrades to pinned-only coverage */ });
  }

  // hit-ring pins: strongest flows first, capped
  const hits = [...hitRing.entries()].sort((a, b) => Math.abs(b[1].netUsd) - Math.abs(a[1].netUsd)).slice(0, HIT_DEEP_CAP);
  const pinList: Array<{ symbol: string; pin: WhalePin; hitNetUsd?: number; hitAt?: number }> = [
    ...openSymbols.map((symbol) => ({ symbol, pin: "OPEN" as const })),
    ...hits.map(([symbol, h]) => ({ symbol, pin: "WHALE-HIT" as const, hitNetUsd: h.netUsd, hitAt: h.at })),
  ];
  // dedupe (a symbol can be both open and hit — OPEN label wins)
  const seen = new Set<string>();
  const pins = pinList.filter((p) => (seen.has(p.symbol) ? false : (seen.add(p.symbol), true)));

  const reads: PinnedWhaleRead[] = [];
  for (const p of pins) {
    const r = await getWhaleRead(p.symbol).catch(() => null);
    if (!r) continue;
    const pinned: PinnedWhaleRead = { ...r, pin: p.pin };
    if (p.hitNetUsd !== undefined) pinned.hitNetUsd = p.hitNetUsd;
    if (p.hitAt !== undefined) pinned.hitAt = p.hitAt;
    reads.push(pinned);
  }

  if (!reads.length && !universe.length) return null;
  const netWhaleUsd = reads.reduce((a, r) => a + (r.whales?.netUsd ?? 0), 0);
  const display = [...reads].sort((a, b) => Math.abs(b.whales?.netUsd ?? 0) - Math.abs(a.whales?.netUsd ?? 0)).slice(0, READS_CAP);
  return {
    at: Date.now(),
    windowMin: WHALE_WINDOW_MS / 60_000,
    minUsd: WHALE_MIN_USD,
    reads: display,
    netWhaleUsd,
    universe: universe.length,
    sweptLastPass: lastSweepSymbols.length,
    sweepCursor,
    sweepSymbols: lastSweepSymbols,
    hitSymbols: [...hitRing.keys()],
    openSymbols,
  };
}

// ── WHALE FLOW VOTE (v6.4.1 — operator challenge: «نهنگ فقط تزئین چت است؟») ──
// The whale tape now participates in DEPLOYMENT: the flow-shortlist candidates
// get a signed WHALE FLOW vote (±10 scale, same magnitude class as the
// confluence factors) that is persisted into factorsJson — so the net-PNL
// calibrator learns its real weight from realized outcomes over time — and a
// STRONG opposing read (≤ −5) vetoes the candidate, mirroring the flow-veto
// semantics. Components (all measured, none invented):
//   · 0.5 × tanh(net whale flow $ / 400K)      — aggressive tape direction
//   · 0.3 × smart-money L/S alignment (±0.8)   — top-trader positioning
//   · 0.2 × book imbalance skew (±12%)         — resting liquidity pressure
// A missing/degraded read yields vote 0 with an honest detail — never a veto.
export function whaleVote(
  read: WhaleSymbolRead | null,
  direction: "LONG" | "SHORT"
): { factor: "WHALE FLOW"; vote: number; detail: string } {
  const NO: { factor: "WHALE FLOW"; vote: number; detail: string } = { factor: "WHALE FLOW", vote: 0, detail: "whale tape unavailable — no whale vote (degraded feed, honestly absent)" };
  if (!read) return NO;
  const long = direction === "LONG";
  const sgn = long ? 1 : -1;
  let comp = 0;
  const parts: string[] = [];
  if (read.whales && read.whales.count > 0) {
    const net = read.whales.netUsd;
    const a = Math.tanh(net / 400_000) * sgn; // signed toward the TRADE direction
    comp += 0.5 * a;
    parts.push(`whale net ${net >= 0 ? "+" : "−"}${usd(net)}/15m`);
  } else if (read.whales) {
    parts.push(`no whale prints ≥${usd(WHALE_MIN_USD)}/15m`);
  }
  if (read.smartLs !== null) {
    const align = long ? read.smartLs - 1 : 1 - read.smartLs; // >0 ⇒ smart cohort agrees
    const a = Math.max(-1, Math.min(1, align / 0.8));
    comp += 0.3 * a;
    parts.push(`smart L/S ${read.smartLs.toFixed(2)} ${align > 0.15 ? "agrees" : align < -0.15 ? "opposes" : "neutral"}`);
  }
  if (read.book) {
    const a = Math.max(-1, Math.min(1, (read.book.bidPct - 50) / 12)) * sgn;
    comp += 0.2 * a;
    parts.push(`book ${read.book.bidPct.toFixed(0)}% bid`);
  }
  if (!parts.length) return NO;
  const vote = Number((Math.max(-1, Math.min(1, comp)) * 10).toFixed(1));
  const verdict = vote >= 5 ? "CONFIRMS" : vote >= 2 ? "supports" : vote <= -5 ? "OPPOSES" : vote <= -2 ? "against" : "neutral";
  return { factor: "WHALE FLOW", vote, detail: `${parts.join(" · ")} → ${verdict} the ${direction}` };
}

async function readSymbol(symbol: string): Promise<WhaleSymbolRead> {
  // v12.2 TASK-52 — the heavy tape leg rides the bridge ladder (fapi → BYBIT
  // → SPOT-MIRROR); the ratio/book/OI legs are Binance-only lanes that
  // degrade honestly (stale flags) — no equivalents exist elsewhere.
  // v12.3 TASK-52 — the book leg now rides the depth ladder too (fapi → BYBIT
  // linear book → SPOT-MIRROR) instead of dying silently during fapi bans.
  const [tape, smart, depth, oiHist] = await Promise.allSettled([
    bridgeTape(symbol),
    fapi<Array<{ longShortRatio: string; longAccount: string; shortAccount: string; timestamp: number }>>(`/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=5m&limit=2`),
    bridgeDepth(symbol, 100),
    fapi<Array<{ sumOpenInterestValue: string; timestamp: number }>>(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=2`),
  ]);

  let stale = false;

  // ── whale tape — buyerMaker=false ⇒ aggressor was a BUY (market buy lifted asks)
  let whales: WhaleSymbolRead["whales"] = null;
  const tapeRows = tape.status === "fulfilled" ? tape.value?.trades ?? null : null;
  if (tapeRows) {
    whales = aggregateWhales(tapeRows);
  } else stale = true;

  let smartLs: number | null = null;
  if (smart.status === "fulfilled" && smart.value.length) smartLs = Number(smart.value[smart.value.length - 1]!.longShortRatio);
  else stale = true;

  let book: WhaleSymbolRead["book"] = null;
  if (depth.status === "fulfilled" && depth.value) {
    const bidUsd = depth.value.bids.reduce((a, [p, q]) => a + p * q, 0);
    const askUsd = depth.value.asks.reduce((a, [p, q]) => a + p * q, 0);
    if (bidUsd + askUsd > 0) book = { bidUsd, askUsd, bidPct: (bidUsd / (bidUsd + askUsd)) * 100 };
  } else stale = true;

  let oiUsd: number | null = null;
  if (oiHist.status === "fulfilled" && oiHist.value.length) oiUsd = Number(oiHist.value[oiHist.value.length - 1]!.sumOpenInterestValue);
  else {
    // v12.2 TASK-52: bybit tickers carry openInterestValue — the absolute OI
    // context survives fapi starvation instead of going stale.
    const t = await bybitTickerRow(symbol).catch(() => null);
    if (t?.openInterestValue) oiUsd = t.openInterestValue;
    else stale = true;
  }

  return { symbol, whales, smartLs, book, oiUsd, stale };
}

const usd = (v: number): string => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${(v / 1e3).toFixed(0)}K`);
export { usd as usdShort }; // shared formatter for engine WHALE event lines

/** Grounding lines for the analyst bundle — honest, compact, measured. */
export function whaleGroundingLines(bundle: WhaleBundle | null): string[] {
  if (!bundle) return ["WHALE/SMART-MONEY: measuring… (tape endpoints unreachable — say the whale feed is degraded rather than inventing flows)"];
  const lines: string[] = [];
  // v6.4.2 coverage honesty — the lens is flow-ruled over the WHOLE scan domain
  if ("universe" in bundle) {
    const fb = bundle as WhaleFlowBundle;
    const hitPart = fb.hitSymbols.length ? fb.hitSymbols.slice(0, 6).join(",") : "none in window";
    lines.push(`WHALE COVERAGE (flow-ruled, NOT a fixed symbol list): universe ${fb.universe} · rotating sweep ${fb.sweptLastPass}/pass (cursor ${fb.sweepCursor}) · deep pins: OPEN ${fb.openSymbols.length} + whale-hit ${fb.hitSymbols.length} [${hitPart}]`);
  }
  const tape = bundle.reads
    .filter((r) => r.whales && r.whales.count > 0)
    .map((r) => {
      const w = r.whales!;
      const bias = w.netUsd >= 0 ? "BUY" : "SELL";
      const pin = "pin" in r ? (r.pin === "OPEN" ? "[OPEN]" : "[HIT]") : "";
      return `${pin}${r.symbol.replace("USDT", "")} ${w.count}×≥${usd(bundle.minUsd)} net ${bias} ${usd(Math.abs(w.netUsd))} (largest ${usd(w.largestUsd)})`;
    });
  lines.push(
    tape.length
      ? `WHALE TAPE (last ${bundle.windowMin}min, aggressive trades ≥${usd(bundle.minUsd)}): ${tape.join(" · ")} — NET aggregate ${bundle.netWhaleUsd >= 0 ? "+" : ""}${usd(bundle.netWhaleUsd)} ${bundle.netWhaleUsd >= 0 ? "BUY" : "SELL"} pressure`
      : `WHALE TAPE: no single trade ≥${usd(bundle.minUsd)} in the last ${bundle.windowMin}min across tracked symbols (measured, not an error)`
  );
  const smart = bundle.reads.filter((r) => r.smartLs !== null).map((r) => `${r.symbol.replace("USDT", "")} ${r.smartLs!.toFixed(2)}`);
  if (smart.length) lines.push(`SMART MONEY top-trader L/S positions: ${smart.join(" · ")} (>1 = large accounts net long; contrast with the retail crowd L/S in ORDER FLOW)`);
  const book = bundle.reads.filter((r) => r.book).map((r) => `${r.symbol.replace("USDT", "")} bid ${r.book!.bidPct.toFixed(0)}%/ask ${(100 - r.book!.bidPct).toFixed(0)}%`);
  if (book.length) lines.push(`BOOK PRESSURE (top-100 resting liquidity): ${book.join(" · ")}`);
  const oi = bundle.reads.filter((r) => r.oiUsd !== null).map((r) => `${r.symbol.replace("USDT", "")} ${usd(r.oiUsd!)}`);
  if (oi.length) lines.push(`OPEN INTEREST absolute: ${oi.join(" · ")}`);
  const stale = bundle.reads.filter((r) => r.stale).map((r) => r.symbol);
  if (stale.length) lines.push(`(whale reads partially stale for: ${stale.join(", ")} — treat those symbols' tape numbers as missing)`);
  return lines;
}
