// ── FlowRadar Neo BINANCE MULTI-PLANE consensus (server-only) ──
// v14.0 BINANCE-ONLY RE-ARCHITECTURE (operator mandate trace 1a185042c872b4f9
// — «ردپای OKX/Bybit در کجا وجود دارد و با بایننس جایگزین شود»): the old
// cross-exchange median (Binance+OKX+Bybit+Hyperliquid+GATE) is replaced by
// FOUR Binance planes — ONE exchange, FOUR independent network paths — so the
// outlier defense (robustMedian) survives on pure Binance data:
//   ① BINANCE       — composite: rung 0 spot-ws prints (price-ws :3003 push
//                     file) → gated fapi batch → SPOT-POOL mirror ladder
//   ② BINANCE-SPOT  — the vision-primary spot-pool ladder (data-api.binance.
//                     vision → api-gcp → api1-4 → api), separate ban budget
//   ③ BINANCE-FUTWS — the futures bookTicker ring pushed by price-ws (:3003,
//                     per-symbol fstream WS) — REAL futures plane, zero REST
//                     weight, mid = (bid+ask)/2 from .data/futws-quotes.json
//   ④ BINANCE-GCP   — gcp-pinned spot ladder (api-gcp → api1-4 → api) — an
//                     independent host path from the vision-primary ladder
// A plane that errors degrades to "no quote for that plane" — never to sim;
// the terminal price stays live if ANY real plane responded.
// v10.24 Task 34-a: only the composite leg's fapi batch rides the fapi-gate
// (weight 40 full-universe ticker, critical lane); the spot ladders keep their
// own direct fetch + shared spot-host gate (v13.2.1).
// The v12.10 venue-expansion (GATE) and Task-49 HL allowlist are RETIRED here —
// the system is Binance-only by mandate; PHANTOM-FEED outlier defense is now
// carried by robustMedian across the four Binance planes (v10.30 doctrine).

import { getFeedStatus } from "./market-feed";
import { gateFetch } from "./fapi-gate";
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// ── v10.30 PHANTOM-FEED-0930 — robust median + outlier refusal ─────────────
// Rule: the median is trusted only while every quote is within 8% of it.
// Otherwise: if a CLEAR MAJORITY exists (strictly fewer deviants than
// agreements) reject the minority quotes and recompute; if two or more
// disagreeing clusters remain (no majority), return null — the engine then
// falls back to the real Binance fapi ticker instead of inventing a midpoint
// that no market ever printed. (QNT phantom-print doctrine, carried over.)
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

// v10.16 (a) REAL Binance composite quote — rung 0 spot prints → batch
// /fapi/v1/ticker/24hr once per sweep (15s cache) → SPOT-POOL mirror on ban.
// v12.11 RUNG 0 — SPOT-PRINT FILE STORE: price-ws :3003 (the process that
// holds the SUSTAINED Binance spot WS plane) pushes lane-isolated spot prints
// every 3s; this file read costs zero REST weight. REST rungs fill only what
// it cannot price; futures-only microcaps stay honestly NULL.
// v14.0 — unchanged leg, now venue "BINANCE" of the four-plane consensus.

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
      console.log(`[multi-exchange] v14.0 BINANCE plane fully spotws-fed (${out.size}/${symbols.length} spot prints ≤90s) — zero Binance REST contact this sweep`);
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
    // v12.8 SPOT-POOL MIRROR rung: a banned fapi poll must not leave the
    // BINANCE venue null — the spot pool (separate ban budget) keeps the
    // reference venue priced (spot ≈ perp within bps on shared tickers);
    // futures-only tickers stay null (honest).
    const mirrored = await spotLadderBatch(symbols, SPOT_LADDER_VISION, "BINANCE-SPOT");
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
        console.log(`[multi-exchange] v14.0 BINANCE plane fed by SPOT-POOL MIRROR (${mirrored.size} tickers) — fapi plane banned, spot pool alive`);
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

// v14.0 — the two SPOT ladders as consensus planes. The vision-primary ladder
// (v13.3, shared with flow-bridge via the spot-host gate) is plane ②; the
// gcp-pinned ladder is plane ④ — an independent host path so a vision outage
// or a bad vision snapshot cannot take BOTH spot planes down at once.
const SPOT_LADDER_VISION = ["https://data-api.binance.vision", "https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"]; // v13.3 ladder + api-gcp
const SPOT_LADDER_GCP = ["https://api-gcp.binance.com", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api4.binance.com", "https://api.binance.com"]; // v14.0 — gcp-pinned independent path

interface SpotBatchState { at: number; data: Map<string, number> }
const spotPlaneCache = new Map<string, SpotBatchState>();
let lastSpotMirrorLogAt = 0;

async function spotLadderBatch(symbols: string[], hosts: string[], plane: string): Promise<Map<string, number>> {
  const hit = spotPlaneCache.get(plane);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const out = new Map<string, number>();
  const ready = spotHostsReady(hosts);
  if (ready.length === 0) return hit?.data ?? out;
  for (const host of ready) {
    const t0 = Date.now();
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
      spotPlaneCache.set(plane, { at: Date.now(), data: out });
      if (out.size > 0 && Date.now() - lastSpotMirrorLogAt > 600_000) {
        lastSpotMirrorLogAt = Date.now();
        console.log(`[multi-exchange] v14.0 ${plane} plane fed by ${host.replace("https://", "")} (${out.size} tickers, ${Date.now() - t0}ms)`);
      }
      return out;
    } catch {
      continue; // next rung — honest nulls downstream if all fail
    }
  }
  return out;
}

// v14.0 — BINANCE-FUTWS plane: the per-symbol futures bookTicker ring pushed
// by price-ws :3003 (.data/futws-quotes.json). Real Binance futures mids with
// ZERO REST weight; the ring is the v13.5 fstream per-symbol design that is
// live-proven from this egress (market-wide !arr streams are muted here, but
// per-symbol bookTicker streams sustain).
const FUTWS_FILE = path.resolve(".data/futws-quotes.json");
const FUTWS_FILE_MAX_AGE_MS = 15_000; // ring pushes continuously — older means the ring is down
const FUTWS_QUOTE_FRESH_MS = 90_000;
let futwsFileCache: { at: number; data: Map<string, number> } | null = null;
let lastFutwsLogAt = 0;

async function futwsRingQuotes(): Promise<Map<string, number>> {
  const now = Date.now();
  if (futwsFileCache && now - futwsFileCache.at < 3_000) return futwsFileCache.data;
  const out = new Map<string, number>();
  try {
    const raw = await fs.readFile(FUTWS_FILE, "utf8");
    const parsed = JSON.parse(raw) as { at?: number; rows?: Array<{ s?: string; m?: number; t?: number }> };
    if (parsed.at && now - parsed.at <= FUTWS_FILE_MAX_AGE_MS && Array.isArray(parsed.rows)) {
      for (const r of parsed.rows) {
        const sym = String(r.s ?? "").toUpperCase();
        const m = Number(r.m);
        const t = Number(r.t);
        if (!sym.endsWith("USDT") || !(m > 0) || !(t > 0) || now - t > FUTWS_QUOTE_FRESH_MS) continue;
        out.set(sym, m);
      }
    }
  } catch {
    /* ring file absent — plane skips honestly */
  }
  if (out.size > 0 && Date.now() - lastFutwsLogAt > 600_000) {
    lastFutwsLogAt = Date.now();
    console.log(`[multi-exchange] v14.0 BINANCE-FUTWS plane fed by the futures bookTicker ring (${out.size} mids, zero REST weight)`);
  }
  futwsFileCache = { at: now, data: out };
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
    // v14.0 — four Binance planes (see header). Order matters only for the
    // quotes array; robustMedian treats them symmetrically.
    const [composite, spot, futws, gcp] = await Promise.allSettled([
      binanceFuturesBatch(symbols),
      spotLadderBatch(symbols, SPOT_LADDER_VISION, "BINANCE-SPOT"),
      futwsRingQuotes(),
      spotLadderBatch(symbols, SPOT_LADDER_GCP, "BINANCE-GCP"),
    ]);
    const compositeMap = composite.status === "fulfilled" ? composite.value : new Map<string, number>();
    const spotMap = spot.status === "fulfilled" ? spot.value : new Map<string, number>();
    const futwsMap = futws.status === "fulfilled" ? futws.value : new Map<string, number>();
    const gcpMap = gcp.status === "fulfilled" ? gcp.value : new Map<string, number>();
    const binanceStatus = getFeedStatus();

    const now = Date.now();
    if (compositeMap.size > 0) venueLastOkAt.set("BINANCE", now);
    if (spotMap.size > 0) venueLastOkAt.set("BINANCE-SPOT", now);
    if (futwsMap.size > 0) venueLastOkAt.set("BINANCE-FUTWS", now);
    if (gcpMap.size > 0) venueLastOkAt.set("BINANCE-GCP", now);

    const out = new Map<string, Consensus>();
    for (const sym of symbols) {
      const quotes: VenueQuote[] = [
        { venue: "BINANCE", price: compositeMap.get(sym) ?? null, latencyMs: binanceStatus.latencyMs, ok: compositeMap.has(sym) },
        { venue: "BINANCE-SPOT", price: spotMap.get(sym) ?? null, latencyMs: null, ok: spotMap.has(sym) },
        { venue: "BINANCE-FUTWS", price: futwsMap.get(sym) ?? null, latencyMs: null, ok: futwsMap.has(sym) },
        { venue: "BINANCE-GCP", price: gcpMap.get(sym) ?? null, latencyMs: null, ok: gcpMap.has(sym) },
      ];
      const prices = quotes.map((q) => q.price).filter((p): p is number => typeof p === "number" && p > 0);
      // v10.30: robust median — rejects outlier planes, refuses impossible midpoints
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
    { venue: "BINANCE-SPOT", ok: fresh("BINANCE-SPOT"), latencyMs: null },
    { venue: "BINANCE-FUTWS", ok: fresh("BINANCE-FUTWS"), latencyMs: null },
    { venue: "BINANCE-GCP", ok: fresh("BINANCE-GCP"), latencyMs: null },
  ];
}
