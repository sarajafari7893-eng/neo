/**
 * ── NEXUS//SIGNALS — DQ-ORACLES v2.0 (v14.0 BINANCE-ONLY, trace 1a185042c872b4f9)
 * Operator mandate: «ردپای OKX/Bybit در کجا وجود دارد و با بایننس جایگزین شود».
 *
 * THE THREE ENGINEERED PRIORITY APIS (Binance-only rewrite of the v1.1 stack):
 *   P1  Binance FUTWS ring (per-symbol futures bookTicker WS, price-ws :3003)
 *       → the exchange-native WS plane — INDEPENDENT of the REST reference
 *         ladder (different process, different transport) — the MIRROR-LAG +
 *         Binance-anomaly guard, now pure Binance.
 *   P2  Coinlore (keyless aggregator)
 *       → independent aggregated spot price + global metrics, no key, no caps.
 *   P3  CoinPaprika (keyless aggregator)
 *       → second independent aggregation with a SELF-TIMESTAMP (last_updated)
 *         so trust can be measured, not assumed.
 * (DefiLlama — the stablecoin substrate — was already engineered into
 *  stable-feed :3017 in v1.4.5 STABLEFLOW; it is benchmarked, not re-built.)
 *
 * Doctrine: fail-soft everywhere — a provider error degrades to null fields,
 * NEVER throws into callers. 45s in-process cache keeps the hot paths cheap.
 * Server-only: uses plain fetch; no keys, no secrets.
 *
 * BINANCE-REFERENCE-LADDER (v1.1, kept): the REFERENCE plane never dies with
 * one host — spot bookTicker walks the full official spot-REST ladder
 * (vision → api-gcp → api1-4 → api) with the shared per-host 418/429 backoff
 * gate. fapi (premiumIndex/openInterest) stays single-host: probe 2026-10-28
 * re-confirmed fapi1/fapi2 are NOT API hosts (HTTP 202 empty — a wildcard CDN
 * trap, not a mirror); fapi-gate's per-IP pool rotation owns that plane.
 */

import { noteSpotHostThrottle, spotHostsReady } from "./spot-host-gate"; // v1.1 reference ladder

export type DqProviderId = "binance-futws" | "coinlore" | "coinpaprika";

export type DqProviderQuote = {
  provider: DqProviderId;
  label: string;
  status: "OK" | "DOWN";
  httpStatus: number;
  latencyMs: number;
  px: number | null;
  funding: number | null;
  oiUsd: number | null;
  sourceTs: number | null;
  ageSec: number | null;
  /** |px − binanceMid| / binanceMid × 10⁴ */
  devBps: number | null;
  /** |funding − binanceFunding| / max(1e-8, |binanceFunding|) × 10⁴ */
  fundingDevBps: number | null;
  verdict: "ALIGNED" | "DIVERGENT" | "STALE" | "DOWN";
  note: string;
};

export type DqReport = {
  ok: boolean;
  at: string;
  symbol: string;
  binance: {
    status: "OK" | "DOWN";
    mid: number | null;
    funding: number | null;
    markPrice: number | null;
    openInterestUsd: number | null;
    latencyMs: number;
  };
  providers: DqProviderQuote[];
  verdict: "GREEN" | "AMBER" | "RED";
  summary: string;
};

// ── symbol mapping (BTC + ETH verified ids; other symbols degrade to nulls) ─
const COINLORE_ID: Record<string, string> = { BTCUSDT: "90", ETHUSDT: "80" };
const PAPRIKA_ID: Record<string, string> = { BTCUSDT: "btc-bitcoin", ETHUSDT: "eth-ethereum" };

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

async function getJson(url: string, timeoutMs = 7000): Promise<{ status: number; ms: number; j: unknown | null }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    const ms = Date.now() - t0;
    let j: unknown = null;
    try { j = await r.json(); } catch { /* non-json */ }
    return { status: r.status, ms, j };
  } catch {
    return { status: 0, ms: Date.now() - t0, j: null };
  }
}

// ── Binance reference plane (the venue the mirror is validated AGAINST) ─────
// v1.1 — spot leg walks the ladder (vision → api-gcp → api1-4 → api) with the
// shared 418/429 host gate; one dead host no longer turns the reference RED.
const REF_SPOT_HOSTS = [
  "https://data-api.binance.vision",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://api.binance.com",
];

async function binanceReference(symbol: string) {
  // spot bookTicker via ladder — first rung that answers 200 + parsable wins
  let book: { status: number; ms: number; j: unknown | null } = { status: 0, ms: 0, j: null };
  for (const host of spotHostsReady(REF_SPOT_HOSTS)) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${host}/api/v3/ticker/bookTicker?symbol=${symbol}`, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
      const ms = Date.now() - t0;
      if (r.status === 418 || r.status === 429) { noteSpotHostThrottle(host, r.status, r.headers); continue; }
      if (!r.ok) continue;
      let j: unknown = null;
      try { j = await r.json(); } catch { continue; }
      book = { status: r.status, ms, j };
      break;
    } catch {
      /* next rung */
    }
  }
  const [prem, oi] = await Promise.all([
    getJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, 5000),
    getJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, 5000),
  ]);
  const b = (book.j ?? null) as { bidPrice?: string; askPrice?: string } | null;
  const p = (prem.j ?? null) as { markPrice?: string; lastFundingRate?: string } | null;
  const o = (oi.j ?? null) as { openInterest?: string } | null;
  const bid = num(b?.bidPrice), ask = num(b?.askPrice);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
  const mark = num(p?.markPrice);
  const oiCoins = num(o?.openInterest);
  return {
    status: (book.status === 200 && mid !== null ? "OK" : "DOWN") as "OK" | "DOWN",
    mid,
    funding: num(p?.lastFundingRate),
    markPrice: mark,
    openInterestUsd: oiCoins !== null && mark !== null ? oiCoins * mark : null,
    latencyMs: Math.max(book.ms, prem.ms, oi.ms),
  };
}

type Parsed = { px: number | null; funding: number | null; oiUsd: number | null; sourceTs: number | null };

// ── P1: Binance FUTWS ring (exchange-native futures WS plane) ────────────────
// price-ws :3003 holds the SUSTAINED per-symbol fstream bookTicker ring and
// pushes .data/futws-quotes.json — REAL futures mids with zero REST weight.
// Independent of the REST reference by transport AND by process.
const FUTWS_FILE = "data/futws-quotes.json";
const FUTWS_FILE_MAX_AGE_MS = 15_000;
const FUTWS_QUOTE_FRESH_MS = 90_000;
let futwsCache: { at: number; map: Map<string, { m: number; t: number }> } | null = null;
async function futwsMirror(symbol: string): Promise<Parsed> {
  try {
    const now = Date.now();
    if (!futwsCache || now - futwsCache.at > 3_000) {
      const map = new Map<string, { m: number; t: number }>();
      const { readFileSync } = await import("node:fs");
      const raw = JSON.parse(readFileSync(FUTWS_FILE, "utf8")) as { at?: number; rows?: Array<{ s?: string; m?: number; t?: number }> };
      if (raw.at && now - raw.at <= FUTWS_FILE_MAX_AGE_MS && Array.isArray(raw.rows)) {
        for (const r of raw.rows) {
          const s = String(r.s ?? "").toUpperCase();
          const m = Number(r.m);
          const t = Number(r.t);
          if (s.endsWith("USDT") && m > 0 && t > 0) map.set(s, { m, t });
        }
      }
      futwsCache = { at: now, map };
    }
    const row = futwsCache.map.get(symbol);
    if (!row || now - row.t > FUTWS_QUOTE_FRESH_MS) return { px: null, funding: null, oiUsd: null, sourceTs: null } satisfies Parsed;
    return { px: row.m, funding: null, oiUsd: null, sourceTs: row.t } satisfies Parsed;
  } catch {
    return { px: null, funding: null, oiUsd: null, sourceTs: null } satisfies Parsed;
  }
}

// ── P2: Coinlore (keyless aggregator) ────────────────────────────────────────
async function coinloreSpot(symbol: string): Promise<Parsed> {
  const id = COINLORE_ID[symbol];
  if (!id) return { px: null, funding: null, oiUsd: null, sourceTs: null };
  const { j } = await getJson(`https://api.coinlore.net/api/ticker/?id=${id}`, 6000);
  const row = ((j as Array<{ price_usd?: string }> | null) ?? [])[0];
  return { px: num(row?.price_usd), funding: null, oiUsd: null, sourceTs: null };
}

// ── P3: CoinPaprika (keyless aggregator with self-timestamp) ─────────────────
async function paprikaSpot(symbol: string): Promise<Parsed> {
  const id = PAPRIKA_ID[symbol];
  if (!id) return { px: null, funding: null, oiUsd: null, sourceTs: null };
  const { j } = await getJson(`https://api.coinpaprika.com/v1/tickers/${id}`, 7000);
  const row = (j ?? null) as { quotes?: { USD?: { price?: number } }; last_updated?: string } | null;
  const price = num(row?.quotes?.USD?.price);
  const ts = row?.last_updated ? Date.parse(row.last_updated) : NaN;
  return { px: price, funding: null, oiUsd: null, sourceTs: Number.isFinite(ts) ? ts : null };
}

// ── verdict engine (thresholds calibrated on the 2026-10-28 benchmark) ──────
const ALIGNED_BPS = 15;       // ≤ 15 bps vs Binance mid = normal cross-venue spread
// Per-provider staleness tolerance (benchmark 2026-10-28 + ring cadence 1-3s:
// the futws row is stale past 90s by construction; Coinpaprika self-ts ≈ 5min
// update cadence — 312s measured, healthy for it).
const STALE_SEC_BY_PROVIDER: Record<DqProviderId, number> = { "binance-futws": 120, coinlore: 300, coinpaprika: 600 };

function verdictOf(q: Omit<DqProviderQuote, "verdict" | "note">): { verdict: DqProviderQuote["verdict"]; note: string } {
  if (q.status !== "OK" || (q.px === null && q.funding === null)) return { verdict: "DOWN", note: `http=${q.httpStatus} — feed unreachable or unparsable` };
  if (q.devBps !== null && q.devBps > ALIGNED_BPS) return { verdict: "DIVERGENT", note: `${q.devBps.toFixed(1)} bps away from Binance mid (> ${ALIGNED_BPS})` };
  const staleSec = STALE_SEC_BY_PROVIDER[q.provider] ?? 300;
  if (q.ageSec !== null && q.ageSec > staleSec) return { verdict: "STALE", note: `source timestamp ${Math.round(q.ageSec)}s old (> ${staleSec}s)` };
  const bits: string[] = [];
  if (q.devBps !== null) bits.push(`${q.devBps.toFixed(1)} bps vs Binance`);
  if (q.ageSec !== null) bits.push(`ts ${Math.round(q.ageSec)}s old`);
  return { verdict: "ALIGNED", note: bits.join(" · ") || "keyless feed reachable" };
}

// ── 45s cache (hot-path friendly; DQ never needs sub-minute freshness) ──────
type CacheRow = { at: number; report: DqReport };
const g = globalThis as unknown as { __nexusDqCache?: Map<string, CacheRow> };
const cache = (g.__nexusDqCache ??= new Map<string, CacheRow>());
const CACHE_MS = 45_000;

export async function dqSnapshot(symbol = "BTCUSDT"): Promise<DqReport> {
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;

  const ref = await binanceReference(symbol);
  const [fw, cl, cp] = await Promise.all([
    futwsMirror(symbol),
    coinloreSpot(symbol),
    paprikaSpot(symbol),
  ]);

  const mk = (
    provider: DqProviderId, label: string, parsed: Parsed,
    httpStatus: number, latencyMs: number,
  ): DqProviderQuote => {
    const ageSec = parsed.sourceTs !== null ? Math.max(0, (Date.now() - parsed.sourceTs) / 1000) : null;
    const devBps = parsed.px !== null && ref.mid ? Math.abs(parsed.px - ref.mid) / ref.mid * 1e4 : null;
    const fundingDevBps = parsed.funding !== null && ref.funding !== null
      ? Math.abs(parsed.funding - ref.funding) / Math.max(1e-8, Math.abs(ref.funding)) * 1e4
      : null;
    const partial = {
      provider, label,
      status: (httpStatus >= 200 && httpStatus < 300 ? "OK" : "DOWN") as "OK" | "DOWN",
      httpStatus, latencyMs,
      px: parsed.px, funding: parsed.funding, oiUsd: parsed.oiUsd,
      sourceTs: parsed.sourceTs, ageSec, devBps, fundingDevBps,
    };
    const { verdict, note } = verdictOf(partial);
    return { ...partial, verdict, note };
  };

  const providers: DqProviderQuote[] = [
    mk("binance-futws", "Binance FUTWS ring (futures WS mid)", fw, fw.px !== null ? 200 : 0, 0),
    mk("coinlore", "Coinlore keyless aggregator (price)", cl, cl.px !== null ? 200 : 0, 0),
    mk("coinpaprika", "CoinPaprika keyless aggregator (price+ts)", cp, cp.px !== null ? 200 : 0, 0),
  ];

  const downs = providers.filter(p => p.verdict === "DOWN").length;
  const divergents = providers.filter(p => p.verdict === "DIVERGENT").length;
  const stale = providers.filter(p => p.verdict === "STALE").length;
  const fwQ = providers.find(p => p.provider === "binance-futws");
  // Calibration (trace 1a181db841517571, v14.0 retune): a single keyless
  // aggregator drifting past the spread threshold is routine (aggregation
  // lag — paprika measured 16-21 bps healthy). RED is reserved for the
  // signals that actually cast doubt on the Binance mirror: the exchange-
  // native WS ring (futws) itself, or two+ independent sources leaving
  // consensus at once.
  const verdict: DqReport["verdict"] =
    ref.status !== "OK" ? "RED"
      : (fwQ && (fwQ.verdict === "DIVERGENT" || fwQ.verdict === "DOWN")) || divergents + downs >= 2 ? "RED"
      : divergents + downs + stale > 0 ? "AMBER"
      : "GREEN";

  const report: DqReport = {
    ok: true,
    at: new Date().toISOString(),
    symbol,
    binance: ref,
    providers,
    verdict,
    summary:
      `binance ${ref.status} (mid=${ref.mid ?? "?"}) · ` +
      providers.map(p => `${p.provider}:${p.verdict}`).join(" · ") +
      ` → ${verdict}` +
      (verdict === "RED" ? " — mirror/anomaly suspected, treat Binance-only prints with suspicion" : ""),
  };

  cache.set(symbol, { at: Date.now(), report });
  return report;
}
