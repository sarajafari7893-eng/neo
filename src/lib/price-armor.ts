// ── NEXUS//SIGNALS PRICE-ARMOR (v12.0 · Task 44-① — write-side phantom anchor) ──
// Operator order 2026-10-18: «ترمیم writer فید (خنثی‌سازی anchor فانتوم سمت
// نوشتن، نه فقط deploy)»
//
// FORENSIC ROOT (Task 45/44, hard evidence): Binance serves ZOMBIE spot
// listings — XMRUSDT spot answers lastPrice=118.70 with bidPrice=0 AND
// askPrice=0 (empty order book, frozen delisting-era print) while the real
// perp trades ~592. The v10.16 spot-overlay fallback (fetchTickers) trusted
// that print as source:"live" whenever fapi was IP-banned → the engine WROTE
// 118.7 into MarketAsset and PricePoint → NX-2736/2744 phantom stops (Task 43).
// The v11.9 PHANTOM-FEED gate catches this at DEPLOY time; this module kills
// the class at WRITE time — the tape itself must never carry phantom prints.
//
// Three writer-side weapons:
//   1. ZOMBIE-TICKER REJECTION — a ticker with a two-sided-empty book
//      (bid=0 && ask=0) is not a market; never a terminal price.
//   2. CROSS-PLANE DIVERGENCE GUARD — a spot-overlay quote deviating >10%
//      from the last live-verified perp anchor (or from the venue consensus)
//      is refused as a terminal source (perp↔spot basis is normally <1%;
//      real crashes are fapi/consensus-sourced and unaffected).
//   3. ANCHOR-LOCKED SIM DRIFT — the sim fallback drifts around the last
//      LIVE-verified price (not around MarketAsset.price, which a platform
//      restore can rewind to an era value — the 118.7 anchor class), with a
//      hard ±0.25% excursion cap, and sim ticks NEVER reach PricePoint /
//      tick-archive (a gap in the tape is honest; a phantom print is poison).
//
// Pure + client-safe. Consumers: market-feed (zombie filter), engine writer
// (resolveTerminalPrice), verify scripts (offline decision tests).

/** A ticker that has no two-sided market is a zombie/halted listing. */
export function isTradeableTicker(t: { bidPrice?: string | number | null; askPrice?: string | number | null }): boolean {
  const bid = Number(t.bidPrice ?? 0);
  const ask = Number(t.askPrice ?? 0);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return true; // fields absent (some planes) → cannot disprove
  return !(bid === 0 && ask === 0);
}

/** v12.0 divergence cap: spot-overlay quote vs live perp anchor / consensus. */
export const SPOT_PERP_DIVERGENCE_PCT = 10;
/** restore-rewind detection: stored row vs live anchor. */
export const REWIND_DETECT_PCT = 5;
/** sim drift total excursion cap from the live anchor (per-tick walk ±0.05%). */
export const SIM_DRIFT_CAP_PCT = 0.25;

export interface TerminalPriceInput {
  /** live Binance ticker price (already Number()-ed), null when absent */
  tPrice: number | null;
  /** true when the ticker row failed isTradeableTicker (zombie book) */
  tZombie: boolean;
  /** TRUE when the ticker came from the SPOT overlay (fetchTickers fallback
   * plane) — the cross-plane divergence guard applies ONLY to overlay quotes:
   * a fapi perp print IS the perp market (a real AGT-class −16%/100s crash is
   * fapi-sourced and must NEVER be blocked by a spot-basis guard). */
  tSpotOverlay: boolean;
  /** venue-consensus robust median + how many venues agreed */
  consMedian: number | null;
  consVenues: number;
  /** last LIVE-verified price for this symbol (globalThis anchor map) */
  anchor: number | null;
  /** current MarketAsset.price (can be a rewound/phantom row) */
  storedPrice: number;
}

export type PriceClass = "live-consensus" | "live-ticker" | "sim-drift" | "frozen";

export interface TerminalPriceResult {
  next: number;
  liveNow: boolean;
  priceClass: PriceClass;
  /** spot-overlay quote refused (zombie book or cross-plane divergence) */
  zombieRejected: boolean;
  /** stored row deviates from the live anchor — restore-rewind class detected */
  rewound: boolean;
}

const rnd = () => Math.random();

export function resolveTerminalPrice(inp: TerminalPriceInput, jitter: () => number = rnd): TerminalPriceResult {
  const { tPrice, tZombie, tSpotOverlay, consMedian, consVenues, anchor, storedPrice } = inp;
  const out: TerminalPriceResult = { next: 0, liveNow: false, priceClass: "frozen", zombieRejected: false, rewound: false };

  // ① consensus (≥2 venues, robust median) — always trusted, wins over ticker
  if (consVenues >= 2 && consMedian && consMedian > 0) {
    return { ...out, next: consMedian, liveNow: true, priceClass: "live-consensus" };
  }

  // ② ticker — but only a tradeable one; the cross-plane divergence guard is
  // SPOT-OVERLAY-ONLY (fapi perp prints are the market itself — a real crash
  // must pass; an overlay quote deviating >10% from the perp truth is zombie-adjacent)
  if (tPrice && tPrice > 0 && !tZombie) {
    let reject = false;
    if (tSpotOverlay) {
      if (consMedian && consMedian > 0 && (Math.abs(tPrice - consMedian) / consMedian) * 100 > SPOT_PERP_DIVERGENCE_PCT) reject = true;
      if (!reject && anchor && anchor > 0 && (Math.abs(tPrice - anchor) / anchor) * 100 > SPOT_PERP_DIVERGENCE_PCT) reject = true;
    }
    if (!reject) return { ...out, next: tPrice, liveNow: true, priceClass: "live-ticker" };
    out.zombieRejected = true;
  } else if (tPrice && tPrice > 0 && tZombie) {
    out.zombieRejected = true;
  }

  // ③ sim drift — ANCHOR-LOCKED: drift around the last live-verified price.
  const base = anchor && anchor > 0 ? anchor : storedPrice;
  if (base > 0) {
    if (anchor && anchor > 0 && storedPrice > 0 && (Math.abs(storedPrice - anchor) / anchor) * 100 > REWIND_DETECT_PCT) out.rewound = true;
    const walk = base * (1 + (jitter() - 0.5) * 0.001);
    // excursion cap keeps a long outage from walking the sim price away
    const capped = Math.max(base * (1 - SIM_DRIFT_CAP_PCT / 100), Math.min(base * (1 + SIM_DRIFT_CAP_PCT / 100), walk));
    out.next = capped;
    out.liveNow = false;
    out.priceClass = "sim-drift";
    return out;
  }

  // ④ nothing sane — freeze (caller keeps the previous stored price untouched)
  out.next = 0;
  out.priceClass = "frozen";
  return out;
}
