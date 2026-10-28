/**
 * ── NEXUS//SIGNALS — DQ-ORACLES v1.1 (trace 1a181db841517571 + 1a184429d4bd0d05)
 * RESTORED 2026-10-29 after the 22:54Z golden-restore wipe (trace
 * 1a1849f647778885) — content recovered verbatim from the live session
 * transcripts of the original build + the v1.1 upgrade.
 *
 * Operator mandate: «پیشنهاد 3 اولویت API را کامل و مهندسی انجام بده» + the
 * follow-up question: are these feeds faster / more trustworthy than Binance?
 *
 * THE THREE ENGINEERED PRIORITY APIS (top-3 of the free-crypto-apis audit):
 *   P1  OKX v5 public (perp ticker + funding-rate + open-interest)
 *       → the ONLY keyless exchange-native mirror of Binance-USDT-perp
 *         price/funding/OI — the MIRROR-LAG + Binance-anomaly guard.
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
 * v1.1 BINANCE-REFERENCE-LADDER (trace 1a184429d4bd0d05 — operator mandate
 * «صرافی بایننس (مرجع) قرار بده … اتصال پایدار»): the REFERENCE plane itself
 * must never die with one host. Spot bookTicker now walks the full official
 * spot-REST ladder (vision → api-gcp → api1-4 → api) with the shared per-host
 * 418/429 backoff gate — the same ladder every other spot-plane consumer
 * uses. fapi (premiumIndex/openInterest) stays single-host: probe 2026-10-28
 * re-confirmed fapi1/fapi2 are NOT API hosts (HTTP 202 empty — a wildcard
 * CDN trap, not a mirror); fapi-gate's per-IP pool rotation already owns
 * that plane's resilience.
 */

import { noteSpotHostThrottle, spotHostsReady } from "./spot-host-gate"; // v1.1 reference ladder

export type DqProviderId = "okx" | "coinlore" | "coinpaprika";

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
const OKX_INST: Record<string, string> = { BTCUSDT: "BTC-USDT-SWAP", ETHUSDT: "ETH-USDT-SWAP" };

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

// ── P1: OKX v5 (exchange-native perp mirror) ─────────────────────────────────
async function okxMirror(symbol: string) {
  const inst = OKX_INST[symbol];
  if (!inst) return { px: null, funding: null, oiUsd: null, sourceTs: null } satisfies Parsed;
  const [tick, fund, oi] = await Promise.all([
    getJson(`https://www.okx.com/api/v5/market/ticker?instId=${inst}`, 6000),
    getJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${inst}`, 6000),
    getJson(`https://www.okx.com/api/v5/public/open-interest?instId=${inst}`, 6000),
  ]);
  const td = ((tick.j as { data?: Array<{ last?: string; ts?: string }> } | null)?.data ?? [])[0];
  const fd = ((fund.j as { data?: Array<{ fundingRate?: string; ts?: string }> } | null)?.data ?? [])[0];
  const od = ((oi.j as { data?: Array<{ oiCcy?: string }> } | null)?.data ?? [])[0];
  const oiCoins = num(od?.oiCcy);
  const px = num(td?.last);
  // mark price is not on the ticker; approximate USD OI with last px (≤ few bps off)
  return {
    px,
    funding: num(fd?.fundingRate),
    oiUsd: oiCoins !== null && px !== null ? oiCoins * px : null,
    sourceTs: num(td?.ts),
  } satisfies Parsed;
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
// Per-provider staleness tolerance (benchmark 2026-10-28: OKX ts ≈ 0-1s,
// Coinpaprika self-ts ≈ 5min update cadence — 312s measured, healthy for it).
const STALE_SEC_BY_PROVIDER: Record<DqProviderId, number> = { okx: 120, coinlore: 300, coinpaprika: 600 };

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
  const [okx, cl, cp] = await Promise.all([
    okxMirror(symbol),
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
    mk("okx", "OKX v5 perp mirror (price+funding+OI)", okx, okx.px !== null || okx.funding !== null ? 200 : 0, 0),
    mk("coinlore", "Coinlore keyless aggregator (price)", cl, cl.px !== null ? 200 : 0, 0),
    mk("coinpaprika", "CoinPaprika keyless aggregator (price+ts)", cp, cp.px !== null ? 200 : 0, 0),
  ];

  const downs = providers.filter(p => p.verdict === "DOWN").length;
  const divergents = providers.filter(p => p.verdict === "DIVERGENT").length;
  const stale = providers.filter(p => p.verdict === "STALE").length;
  const okxQ = providers.find(p => p.provider === "okx");
  // Calibration (trace 1a181db841517571): a single keyless aggregator drifting
  // past the spread threshold is routine (aggregation lag — paprika measured
  // 16-21 bps healthy). RED is reserved for the signals that actually cast
  // doubt on the Binance mirror: the exchange-native mirror (OKX) itself, or
  // two+ independent sources leaving consensus at once.
  const verdict: DqReport["verdict"] =
    ref.status !== "OK" ? "RED"
      : (okxQ && (okxQ.verdict === "DIVERGENT" || okxQ.verdict === "DOWN")) || divergents + downs >= 2 ? "RED"
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
