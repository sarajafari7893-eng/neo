// ── FlowRadar Neo multi-exchange consensus (server-only) ──
// Median price across Binance + OKX + Bybit + Hyperliquid + GATE (outlier-resistant).
// v10.16 P1 FUTURES PRICE UNIFICATION — every venue now quotes the SAME
// instrument class the engine trades (USDT-M linear perps), not a spot/perp
// mix: Binance = real futures batch (the null-price BINANCE quote is gone),
// OKX = instType SWAP, Bybit = category linear. A venue that errors degrades
// to "no quote for that venue" — never to sim; the terminal price stays live
// if ANY real venue responded.
// v10.24 Task 34-a: ONLY the Binance futures leg goes through the fapi-gate
// (weight 40 full-universe ticker, critical lane). OKX/Bybit/Hyperliquid are
// different hosts with different budgets — they keep their direct fetch.
// v12.10 VENUE-EXPANSION (AUDIT-20261023 follow-up, operator mandate «وتوی یک
// ارز ... ریشه‌ای احیا و کالیبره شود»): GATE USDT-futures wired as venue #5 —
// the coverage probe proved JCT/BTW/MAGMA/IRYS list on Gate while being
// Binance-absent, so the "single-venue" vetoes were a DATA-COVERAGE artifact,
// not a market fact. One full-tickers GET per sweep (15s shared cache).

import { getFeedStatus } from "./market-feed";
import { gateFetch } from "./fapi-gate";
import { HL_KEY_ALLOWLIST } from "./hl-allowlist";
import { promises as fs } from "fs";
import { noteSpotHostThrottle, spotHostsReady } from "./spot-host-gate";
import path from "path";

const TIMEOUT_MS = 6500;

export interface VenueQuote {
  venue: string;
  price: number | null;
  latencyMs: number | null;
  ok: boolean;
  /** v10.30 PHANTOM-FEED-0930: set when robustMedian rejected this quote as an outlier. */
  rejected?: string;
}

export interface Consensus {
  symbol: string;
  median: number | null;
  quotes: VenueQuote[];
  maxDevBps: number;
  venuesOk: number;
  sweptAt: number;
  /** v10.30: true when at least one outlier quote was rejected (or trust was refused). */
  degraded?: boolean;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

/** "ETHUSDT" → OKX SWAP instId "ETH-USDT-SWAP" (v10.16 perp unification). */
export function toOkxInstId(symbol: string): string {
  return `${symbol.replace(/USDT$/, "")}-USDT-SWAP`;
}

async function okxBatch(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // v10.16 (b) SWAP (linear perp) instruments — the SPOT endpoint mis-priced
  // perp settlement; instIds map BTCUSDT → BTC-USDT-SWAP.
  const res = await fetchWithTimeout("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
  if (!res.ok) return out;
  const json = (await res.json()) as { data?: Array<{ instId: string; last: string }> };
  const want = new Set(symbols.map(toOkxInstId));
  for (const row of json.data ?? []) if (want.has(row.instId)) out.set(row.instId.replace("-USDT-SWAP", "USDT"), Number(row.last));
  return out;
}

async function bybitBatch(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // v10.16 (c) linear perps — the engine trades USDT-M perpetuals, so the
  // consensus must read category=linear, not the spot book.
  const res = await fetchWithTimeout("https://api.bybit.com/v5/market/tickers?category=linear");
  if (!res.ok) return out;
  const json = (await res.json()) as { result?: { list?: Array<{ symbol: string; lastPrice: string }> } };
  const want = new Set(symbols);
  for (const row of json.result?.list ?? []) if (want.has(row.symbol)) out.set(row.symbol, Number(row.lastPrice));
  return out;
}

// v12.10 VENUE-EXPANSION — Gate USDT-M futures batch (one full-tickers GET,
// shared 30s cache). "BTCUSDT" → Gate contract "BTC_USDT".
let gateCache: { at: number; data: Map<string, number> } | null = null;

async function gateBatch(symbols: string[]): Promise<Map<string, number>> {
  if (gateCache && Date.now() - gateCache.at < 30_000) {
    const out = new Map<string, number>();
    for (const s of symbols) {
      const p = gateCache.data.get(s);
      if (p) out.set(s, p);
    }
    return out;
  }
  const out = new Map<string, number>();
  try {
    const res = await fetchWithTimeout("https://api.gateio.ws/api/v4/futures/usdt/tickers");
    if (!res.ok) return out;
    const rows = (await res.json()) as Array<{ contract: string; last: string }>;
    const all = new Map<string, number>();
    for (const r of rows) {
      const p = Number(r.last);
      if (Number.isFinite(p) && p > 0) all.set(r.contract.replace("_USDT", "USDT"), p);
    }
    gateCache = { at: Date.now(), data: all };
    for (const s of symbols) {
      const p = all.get(s);
      if (p) out.set(s, p);
    }
  } catch {
    /* keep stale/empty — honest nulls downstream */
  }
  return out;
}

async function hyperliquidAll(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (Date.now() < hlCooldownUntil) return out; // 429 backoff — stay silent, retry after cooldown
  const res = await fetchWithTimeout("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
  if (res.status === 429) {
    hlCooldownUntil = Date.now() + 120_000;
    if (!hlCooldownJournaled) {
      hlCooldownJournaled = true;
      console.log("[multi-exchange] HYPERLIQUID 429 — leg paused 2min (backoff, Task 49)");
      setTimeout(() => {
        hlCooldownJournaled = false;
      }, 120_000);
    }
    return out;
  }
  if (!res.ok) return out;
  const json = (await res.json()) as Record<string, string>;
  // v11.1 TASK-56 HL-ALLOWLIST (operator: «نگاشت کلید Hyperliquid به allowlist
  // محدود شود»): the old map-every-key `${k}USDT` loop let same-ticker-
  // different-asset HL tokens (HL "ARK"=0.1067 vs Binance ARKUSDT) impersonate
  // traded symbols — the PHANTOM-FEED-0930 root. Only keys vetted by
  // scripts/hl-vet.ts (plain ticker + exists on Binance fapi + price within
  // 3% of the real perp) are mapped; unvetted/colliding keys are dropped and
  // journaled once per process so new collisions stay visible, not silent.
  const want = new Set(symbols);
  for (const [k, v] of Object.entries(json)) {
    const sym = `${k}USDT`;
    if (!want.has(sym)) continue;
    if (!HL_KEY_ALLOWLIST.has(k)) {
      if (!hlBlockedJournaled.has(k)) {
        hlBlockedJournaled.add(k);
        console.log(`[multi-exchange] HL key "${k}" in allMids but NOT allowlisted (unvetted/colliding ticker) — quote dropped at root (Task 56)`);
      }
      continue;
    }
    const p = Number(v);
    if (Number.isFinite(p) && p > 0) out.set(sym, p);
  }
  return out;
}

const hlBlockedJournaled = new Set<string>(); // Task 56: one journal line per blocked key per process

// v12.1 TASK-49 — HL 429 cooldown: the venue 429s under pool-wide throttling;
// re-poking every 15s sweep extends it. On 429 the HL leg goes silent for
// 2min (quotes degrade to "no quote" — the robust median handles that) and
// a single journal line marks the pause instead of silent dark bars.
let hlCooldownUntil = 0;
let hlCooldownJournaled = false;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ── v10.30 PHANTOM-FEED-0930 — robust median + outlier refusal ─────────────
// Root cause (NX-0884/0887 phantom full-TP): OKX QNT-USDT-SWAP quotes ~49.2
// with a FRESH timestamp while Binance/Bybit agree at ~298. With one healthy
// venue temporarily absent, the plain median of [49.2, 298] = 173.6 — a price
// that exists on NO exchange — flowed into PricePoint and the settlement
// engine, instantly "full-TP"ing shorts anchored at the real ~290. A frozen
// timestamp filter can NOT catch this (OKX ts is live); the guard must be
// statistical.
//
// Rule: the median is trusted only while every quote is within 8% of it.
// Otherwise: if a CLEAR MAJORITY exists (strictly fewer deviants than
// agreements) reject the minority quotes and recompute; if two or more
// disagreeing clusters remain (no majority), return null — the engine then
// falls back to the real Binance fapi ticker instead of inventing a midpoint
// that no market ever printed.
const ROBUST_DEV_PCT = 8;

export function robustMedian(quotes: VenueQuote[]): { median: number | null; degraded: boolean } {
  const priced = quotes.filter((q): q is VenueQuote & { price: number } => typeof q.price === "number" && q.price > 0);
  if (priced.length === 0) return { median: null, degraded: false };
  if (priced.length === 1) return { median: priced[0]!.price, degraded: false };
  const deviates = (p: number, ref: number) => (Math.abs(p - ref) / ref) * 100 > ROBUST_DEV_PCT;
  let mdn = median(priced.map((q) => q.price));
  const deviants = priced.filter((q) => deviates(q.price, mdn));
  if (deviants.length === 0) return { median: mdn, degraded: false };
  if (deviants.length * 2 < priced.length) {
    // clear majority — reject the minority outliers and take the majority median
    for (const q of deviants) q.rejected = `outlier >${ROBUST_DEV_PCT}% vs majority median`;
    const kept = priced.filter((q) => !q.rejected);
    mdn = median(kept.map((q) => q.price));
    return { median: mdn, degraded: true };
  }
  // no majority (two clusters of comparable size) — refuse to invent a midpoint
  return { median: null, degraded: true };
}

// v10.16 (a) REAL Binance futures quote — batch /fapi/v1/ticker/24hr once per
// sweep (15s cache so concurrent sweeps/venues share one call).
// v12.11 RUNG 0 — SPOT-PRINT FILE STORE (operator mandate: Binance anchor from
// a REAL Binance plane while both REST pools are 418-banned). EVIDENCE CHAIN
// 2026-10-23: fstream (futures WS) was ATTEMPTED and REFUTED — handshake OK,
// data MUTED from this egress (sustain probe: 240s ZERO frames on
// btcusdt@aggTrade with the socket open; the v12.10 p50=30ms reading was a
// short-window burst artifact — probe kept as re-runnable evidence). In-app
// WS rings were also refuted (dev-mode per-bundle module instances churn
// connections; compile-ramp OOM budget). FINAL DESIGN: price-ws :3003 — the
// one process that already holds the SUSTAINED Binance plane (spot
// !miniTicker@arr WS, hours-proven) — pushes lane-isolated spot prints every
// 3s to /api/internal/spotws-quotes which persists .data/spotws-quotes.json.
// Rung 0 reads that file (real-time Binance spot, zero REST weight); REST
// rungs below fill only what it cannot price; futures-only microcaps are
// absent from the store → honestly NULL → NO-BINANCE-CONFIRM +12 keeps
// firing exactly where no Binance ticket exists (market fact, not blindness).

const SPOTWS_FILE = path.resolve(".data/spotws-quotes.json");
const SPOTWS_FILE_MAX_AGE_MS = 12_000; // pushes every 3s — older means price-ws down
const SPOTWS_QUOTE_FRESH_MS = 90_000;
let binanceFutCache: { at: number; data: Map<string, number> } | null = null;
let spotwsFileCache: { at: number; data: Map<string, { price: number; at: number }> } | null = null;
let lastSpotwsLogAt = 0;

async function spotwsFileQuotes(): Promise<Map<string, { price: number; at: number }>> {
  const now = Date.now();
  if (spotwsFileCache && now - spotwsFileCache.at < 3_000) return spotwsFileCache.data;
  const out = new Map<string, { price: number; at: number }>();
  try {
    const raw = await fs.readFile(SPOTWS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { at?: number; rows?: Array<{ s?: string; p?: number; t?: number }> };
    if (parsed.at && now - parsed.at <= SPOTWS_FILE_MAX_AGE_MS && Array.isArray(parsed.rows)) {
      for (const r of parsed.rows) {
        const sym = String(r.s ?? "").toUpperCase();
        const p = Number(r.p);
        const t = Number(r.t);
        if (!sym.endsWith("USDT") || !(p > 0) || !(t > 0)) continue;
        out.set(sym, { price: p, at: t });
      }
    }
  } catch {
    /* no file yet / unreadable — rung 0 skips honestly, REST rungs cover */
  }
  spotwsFileCache = { at: now, data: out };
  return out;
}

async function binanceFuturesBatch(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  // RUNG 0 — live spot prints from the sustained Binance WS plane (pushed file)
  try {
    const spotws = await spotwsFileQuotes();
    const now = Date.now();
    for (const s of symbols) {
      const q = spotws.get(s);
      if (q && now - q.at <= SPOTWS_QUOTE_FRESH_MS) out.set(s, q.price);
    }
  } catch {
    /* rung never throws — REST rungs below are the safety net */
  }
  if (symbols.length > 0 && out.size === symbols.length) {
    if (Date.now() - lastSpotwsLogAt > 600_000) {
      lastSpotwsLogAt = Date.now();
      console.log(`ulti-exchange] v12.11 BINANCE venue fully spotws-fed (${out.size}/${symbols.length} spot prints ≤90s) — zero Binance REST contact this sweep`);
    }
    return out;
  }
  const miss = symbols.filter((s) => !out.has(s));
  if (binanceFutCache && Date.now() - binanceFutCache.at < CACHE_TTL) {
    for (const s of miss) {
      const p = binanceFutCache.data.get(s);
      if (p) out.set(s, p);
    }
    return out;
  }
  // v10.24 Task 34-a: full-universe /fapi/v1/ticker/24hr — weight 40, gated.
  const json = await gateFetch<Array<{ symbol: string; lastPrice: string }>>("/fapi/v1/ticker/24hr", { priority: "critical", weight: 40, timeoutMs: TIMEOUT_MS });
  if (!json) {
    // v12.8 AUDIT-20261023 — SPOT-POOL MIRROR rung: measured 10:20-10:35Z the
    // whole fapi plane is 418-banned from this egress while api.binance.com
    // (spot — SEPARATE pool) answers 200. A banned fapi poll used to leave the
    // BINANCE venue null → consensus degraded to 2 venues → dislocation
    // warnings fired while the engine still deployed. The mirror keeps the
    // reference venue priced (spot ≈ perp within bps on shared tickers);
    // futures-only tickers stay null (honest). NOT routed through fapi-gate —
    // this is the spot pool with its own budget and its own soft backoff.
    const mirrored = await binanceSpotMirrorBatch();
    if (mirrored.size > 0) {
      binanceFutCache = { at: Date.now(), data: mirrored };
      // v12.11 — fill ONLY the ring's misses: a 15s-old spot REST quote must
      // never overwrite a live aggTrade print (fresher wins, always).
      for (const s of miss) {
        const p = mirrored.get(s);
        if (p) out.set(s, p);
      }
      if (Date.now() - lastSpotMirrorLogAt > 600_000) {
        lastSpotMirrorLogAt = Date.now();
        console.log(`[multi-exchange] v12.8 BINANCE venue fed by SPOT-POOL MIRROR (${mirrored.size} tickers) — fapi plane banned, spot pool alive`);
      }
    }
    return out;
  }
  const all = new Map<string, number>();
  for (const row of json) {
    const p = Number(row.lastPrice);
    if (Number.isFinite(p) && p > 0) all.set(row.symbol, p);
  }
  binanceFutCache = { at: Date.now(), data: all };
  for (const s of miss) {
    const p = all.get(s);
    if (p) out.set(s, p);
  }
  return out;
}

// v12.8 — spot-pool mirror state (separate budget/pool from fapi, by design)
let binanceSpotMirrorCache: { at: number; data: Map<string, number> } | null = null;
let lastSpotMirrorLogAt = 0;

async function binanceSpotMirrorBatch(): Promise<Map<string, number>> {
  if (binanceSpotMirrorCache && Date.now() - binanceSpotMirrorCache.at < 60_000) return binanceSpotMirrorCache.data;
  const out = new Map<string, number>();
  // v13.2 SPOT-HOST LADDER (operator mandate trace 1a1704d407f00dad — «جریان زندهٔ لحظه‌ای باید با بایننس باشد»):
  // data-api.binance.vision is the PRIMARY spot host — measured 32/32 HTTP 200 p50 57ms on 2026-10-25
  // while api.binance.com rides 418 ban-storms from this shared egress; api stays as the fallback rung.
  // v13.2.1 — per-host 418/429 backoff via the shared spot-host gate (the old
  // last-rung-only 10min ban let the primary rung be re-poked during its own
  // ban every sweep — live evidence: vision 418 @467wt/min, retry-after 889s).
  // v13.2.3 (trace 1a170bba02dff781): api1-4 added as mid rungs (200 @356-408ms probed 2026-10-25), api last.
  const HOSTS = ["https://data-api.binance.vision", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"];
  const ready = spotHostsReady(HOSTS);
  if (ready.length === 0) return binanceSpotMirrorCache?.data ?? out;
  for (const host of ready) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(`${host}/api/v3/ticker/24hr`, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
      clearTimeout(t);
      if (res.status === 418 || res.status === 429) {
        noteSpotHostThrottle(host, res.status, res.headers);
        continue; // gate armed — next rung serves until expiry
      }
      if (!res.ok) continue;
      const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string }>;
      for (const r of rows) {
        const p = Number(r.lastPrice);
        if (Number.isFinite(p) && p > 0) out.set(r.symbol, p);
      }
      binanceSpotMirrorCache = { at: Date.now(), data: out };
      return out;
    } catch {
      continue; // next rung — honest nulls downstream if all fail
    }
  }
  return out;
}

// cached sweep (15s TTL, in-flight dedupe)
const CACHE_TTL = 15_000;
let cache: { at: number; data: Map<string, Consensus> } | null = null;
let inFlight: Promise<Map<string, Consensus>> | null = null;

// v10.16 (e) per-venue health — lastOkAt stamped on every successful batch
// contribution inside sweepConsensus; a venue is ok ONLY while its last
// success is ≤90s old (cache existence alone no longer counts).
const venueLastOkAt = new Map<string, number>();
const VENUE_OK_WINDOW_MS = 90_000;

export async function sweepConsensus(symbols: string[]): Promise<Map<string, Consensus>> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const [binance, okx, bybit, hl, gate] = await Promise.allSettled([binanceFuturesBatch(symbols), okxBatch(symbols), bybitBatch(symbols), hyperliquidAll(symbols), gateBatch(symbols)]);
    const binanceMap = binance.status === "fulfilled" ? binance.value : new Map<string, number>();
    const okxMap = okx.status === "fulfilled" ? okx.value : new Map<string, number>();
    const bybitMap = bybit.status === "fulfilled" ? bybit.value : new Map<string, number>();
    const hlMap = hl.status === "fulfilled" ? hl.value : new Map<string, number>();
    const gateMap = gate.status === "fulfilled" ? gate.value : new Map<string, number>();
    const binanceStatus = getFeedStatus();

    const now = Date.now();
    if (binanceMap.size > 0) venueLastOkAt.set("BINANCE", now);
    if (okxMap.size > 0) venueLastOkAt.set("OKX", now);
    if (bybitMap.size > 0) venueLastOkAt.set("BYBIT", now);
    if (hlMap.size > 0) venueLastOkAt.set("HYPERLIQUID", now);
    if (gateMap.size > 0) venueLastOkAt.set("GATE", now);

    const out = new Map<string, Consensus>();
    for (const sym of symbols) {
      const quotes: VenueQuote[] = [
        { venue: "BINANCE", price: binanceMap.get(sym) ?? null, latencyMs: binanceStatus.latencyMs, ok: binanceMap.has(sym) },
        { venue: "OKX", price: okxMap.get(sym) ?? null, latencyMs: null, ok: okxMap.has(sym) },
        { venue: "BYBIT", price: bybitMap.get(sym) ?? null, latencyMs: null, ok: bybitMap.has(sym) },
        { venue: "HYPERLIQUID", price: hlMap.get(sym) ?? null, latencyMs: null, ok: hlMap.has(sym) },
        { venue: "GATE", price: gateMap.get(sym) ?? null, latencyMs: null, ok: gateMap.has(sym) },
      ];
      const prices = quotes.map((q) => q.price).filter((p): p is number => typeof p === "number" && p > 0);
      // v10.30: robust median — rejects outlier venues, refuses impossible midpoints
      const rm = robustMedian(quotes);
      const mdn = rm.median;
      const maxDevBps = mdn && prices.length >= 2 ? Math.max(...prices.map((p) => (Math.abs(p - mdn) / mdn) * 10_000)) : 0;
      out.set(sym, { symbol: sym, median: mdn, quotes, maxDevBps: Number(maxDevBps.toFixed(2)), venuesOk: prices.length, sweptAt: now, degraded: rm.degraded });
    }
    cache = { at: Date.now(), data: out };
    return out;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function getConsensusHealth(): Array<{ venue: string; ok: boolean; latencyMs: number | null }> {
  // v10.16 (e) ok = a real per-venue quote contribution within the last 90s —
  // "a cache exists somewhere" no longer marks a silent venue healthy.
  const fresh = (venue: string) => Date.now() - (venueLastOkAt.get(venue) ?? 0) <= VENUE_OK_WINDOW_MS;
  return [
    { venue: "BINANCE", ok: fresh("BINANCE"), latencyMs: getFeedStatus().latencyMs },
    { venue: "OKX", ok: fresh("OKX"), latencyMs: null },
    { venue: "BYBIT", ok: fresh("BYBIT"), latencyMs: null },
    { venue: "HYPERLIQUID", ok: fresh("HYPERLIQUID"), latencyMs: null },
    { venue: "GATE", ok: fresh("GATE"), latencyMs: null },
  ];
}
