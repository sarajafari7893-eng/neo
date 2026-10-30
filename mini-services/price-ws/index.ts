// ── NEXUS price-ws (:3003, socket.io) — sub-second price push ──────────────
// Fuel priority (honest labeling, Task 35 + v13.5):
//   1. WS PUSH     — Binance futures miniTicker combined stream
//   2. WS·FUT-BOOK — Binance futures per-symbol bookTicker ring (v13.5 — the
//                    ONLY live Binance FUTURES lane from this egress; see the
//                    probe matrix at the ring below)
//   3. WS·SPOT     — Binance SPOT !miniTicker@arr WS (v12.8 AUDIT-20261023:
//                    measured 10:30Z — fstream (futures) delivers ZERO frames
//                    from this egress while stream.binance.com (spot) is
//                    ALIVE (8 frames/8s direct test). Spot lives in a separate
//                    rate/ban pool — feeding it as rung-2 restores Binance
//                    price parity while the futures plane is IP-suppressed,
//                    instead of jumping straight to the REST rungs and losing
//                    the reference venue. Same row shape; spot symbols that
//                    have no futures twin simply never arrive (v14.0: the
//                    fuel ladder is Binance-only — cross-venue rungs retired).
//   4. WS·REST 2.5S— Binance fapi /ticker/24hr poll (ban-aware, v10.7)
//   5. WS OFFLINE  — everything down; badge never lies
// Universe auto-syncs from the terminal pulse every 5min.

import { Server } from "socket.io";
import { renameSync, writeFileSync } from "node:fs"; // v13.4 direct spot-print file ownership

const PORT = 3003;
const WS_URL = "wss://fstream.binance.com/stream?streams=!miniTicker@arr";
// v12.8 AUDIT-20261023 — SPOT-ARR ring: raw spot all-market miniTicker WS.
// ALIVE from this egress while fstream is silent (measured + verified live).
// v13.3 BINANCE-LADDER (trace 1a184429d4bd0d05, restored 1a1849f647778885) —
// three-mirror ladder, each verified live from this box (first-frame measured):
//   9443 = 375-515ms · data-stream.binance.vision = 1000-1998ms · :443 = 1001ms.
// Rotation: every reconnect advances the index — a dead host self-heals.
const SPOT_WS_MIRRORS = [
  "wss://stream.binance.com:9443/ws/!miniTicker@arr",
  "wss://data-stream.binance.vision/ws/!miniTicker@arr",
  "wss://stream.binance.com:443/ws/!miniTicker@arr",
];
let spotWsMirrorIdx = 0;
const REST_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
// v12.2 TASK-52 — SPOT-MIRROR rung: api.binance.com lives in a SEPARATE
// rate-limit/ban pool from fapi.binance.com. While the fapi pool is banned
// and both WS lanes are dead, the fuel ladder burns SPOT (same exchange,
// same row shape, weight 80 on a fresh pool) instead of going dark or poking
// the banned fapi pool (Task-50 law: every contact during a ban escalates).
const SPOT_URL = "https://api.binance.com/api/v3/ticker/24hr";
const STALL_MS = 60_000;

interface PriceRow {
  symbol: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  at: number;
}

const prices = new Map<string, PriceRow>();
let source: "WS PUSH" | "WS·FUT-BOOK" | "WS·SPOT" | "WS·REST 2.5S" | "WS·REST·SPOT" | "WS OFFLINE" = "WS PUSH";
let lastWsFrame = 0;
// v12.8 — spot-arr ring state
let spotWsLastFrame = 0;
let lastEventAt: number | null = null;
// v10.7 ban-awareness (2026-09-17 dashboard audit): Binance 418/429 IP bans
// auto-extend when the REST fallback keeps hammering. Respect retry-after,
// stop polling while banned, and label the source honestly (WS OFFLINE)
// instead of a live-looking "WS·REST 2.5S" badge over frozen rows.
let restBannedUntil = 0;
let spotBannedUntil = 0; // separate pool — NEVER shares the fapi ledger
let spotLastOkAt = 0;
// v10.8 TASK-49 — shared-ledger discipline: parse the REAL "banned until"
// body (retry-after is often absent → the old 60s default re-poked every
// minute all ban long), write named-IP discoveries to the shared ledger, and
// defer resume while ANY pool IP is still banned (NAT lottery — one banned
// IP means any request may land on it and re-escalate the expiry).
import { ledgerUnknownScopeBanUntil, writeLedgerBan } from "../_shared/ban-ledger";

// ── v12.10 CASCADE-ALERT — tick-velocity freeze (AUDIT-20261023 follow-up) ──
// Root cause measured: the app's L3_LIQ_CASCADE layer is LIQUIDATION-STREAM
// based — structurally silent for microcaps that emit zero forceOrder events
// (JCT/IRYS forensics), so a −40%/8.5min flush stayed invisible until the
// deploy was already 359s late. This detector watches the TICK plane itself:
// a ≥±5% move measured inside a 60s sliding window (≥15s span, ≥3 ticks,
// price-change deduped) is a live cascade either way (flush OR squeeze) —
// the engine freezes BOTH-direction deploys for 10min via the ingest route.
// Detection latency: the window of the tape itself (15-60s), not the 6min
// rotation lag. Re-fires extend the freeze; 8min per-symbol alert cooldown.
const CASCADE_WINDOW_MS = 60_000;
const CASCADE_MOVE_PCT = 5;
const CASCADE_MIN_SPAN_MS = 15_000;
const CASCADE_MIN_TICKS = 3;
const CASCADE_ALERT_COOLDOWN_MS = 8 * 60_000;
const cascadeRing = new Map<string, Array<{ at: number; price: number }>>();
const cascadeLastAlert = new Map<string, number>();
const cascadeLastPrice = new Map<string, number>();

// ── v12.11 TICK-ONSET — leading VolCause event plane (trace 1a16ac1614…) ────
// Root cause (IRYS forensics): the slow capture plane (|Δ24h| board, 6h
// per-symbol dedupe) recorded ONE event 16h into the +565% pump (at the
// tick-top) and ZERO for the following −77.4%/40min collapse — events were
// LAGGING, never LEADING. This detector watches the same tick plane as
// CASCADE with calibrated pump/flush-onset thresholds and posts IMMEDIATELY
// to /api/internal/onset-event → a VolCauseEvent row (rank 0 = tick-plane
// origin) that volCauseBoost / the board / the daily report read in seconds.
// Calibration (from the measured microcap forensics):
//   FAST tier (90s window): ±3/6/12/25% — burst onsets (MAGMA-style waves,
//     JCT −40%/8.5min flash legs trip within seconds-to-a-minute)
//   SLOW tier (300s window): ±5/10/20/35% — sustained regimes; IRYS
//     −1.94%/min average trips the 5% level ~155s into a 40min flush
// Each (symbol, side, level) fires once per 6h → a big regime produces a
// STAGED ladder (3→6→12→25), not one late event. CASCADE alerts also emit
// an onset event tagged CASCADE-FREEZE so the vol-cause book never misses a
// freeze. DB-side 90s dedupe on the route guards reload re-fires.
const ONSET_RING_MS = 300_000;
const ONSET_RING_MAX = 240;
const ONSET_FAST_MS = 90_000;
const ONSET_FAST_MIN_SPAN_MS = 2_000;
const ONSET_SLOW_MIN_SPAN_MS = 30_000;
const ONSET_LEVELS_FAST = [3, 6, 12, 25];
const ONSET_LEVELS_SLOW = [5, 10, 20, 35];
const ONSET_LEVEL_DEDUPE_MS = 6 * 3600_000;
const onsetRing = new Map<string, Array<{ at: number; price: number }>>();
const onsetFired = new Map<string, number>(); // `sym|side|tier+lvl` → fired at
const onsetPostAt = new Map<string, number>(); // `sym|side` → last post (60s pacing)

function postOnset(symbol: string, side: "UP" | "DOWN", movePct: number, windowMs: number, lane: string, tier: "FAST" | "SLOW" | "CASCADE", level: number | null, price: number, change24h: number | null): void {
  const now = Date.now();
  if (tier !== "CASCADE") {
    const paceKey = `${symbol}|${side}`;
    if (now - (onsetPostAt.get(paceKey) ?? 0) < 60_000) return;
    onsetPostAt.set(paceKey, now);
  }
  console.log(`[price-ws] TICK-ONSET ${symbol} ${side} ${tier}${level ? `-lvl${level}` : ""} ${movePct.toFixed(2)}% in ${Math.round(windowMs / 1000)}s (${lane}) — onset event posted`);
  void fetch("http://localhost:3000/api/internal/onset-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ symbol, side, movePct: Number(movePct.toFixed(2)), windowMs, lane, tier, level, price, change24h, at: now }),
  }).catch(() => {});
}

function highestUnfiredLevel(symbol: string, side: string, tier: string, levels: number[], moveAbs: number, now: number): number | null {
  let best: number | null = null;
  for (const lvl of levels) {
    if (moveAbs < lvl) break;
    if (now - (onsetFired.get(`${symbol}|${side}|${tier}${lvl}`) ?? 0) >= ONSET_LEVEL_DEDUPE_MS) best = lvl;
  }
  return best;
}
function markLevelsFired(symbol: string, side: string, tier: "FAST" | "SLOW", top: number, now: number): void {
  for (const lvl of tier === "FAST" ? ONSET_LEVELS_FAST : ONSET_LEVELS_SLOW) {
    if (lvl > top) break;
    onsetFired.set(`${symbol}|${side}|${tier}${lvl}`, now);
  }
}

function observeOnset(symbol: string, price: number, lane: string, change24h: number | null): void {
  const now = Date.now();
  const ring = onsetRing.get(symbol) ?? [];
  ring.push({ at: now, price });
  while (ring.length > ONSET_RING_MAX || (ring.length > 1 && now - ring[0]!.at > ONSET_RING_MS)) ring.shift();
  onsetRing.set(symbol, ring);
  if (ring.length < 2) return;
  // FAST ref = oldest tick still inside the 90s window; SLOW ref = oldest ≤300s
  let fi = 0;
  while (fi < ring.length - 1 && now - ring[fi]!.at > ONSET_FAST_MS) fi++;
  const fastRef = ring[fi]!;
  const slowRef = ring[0]!;
  const fastMove = fastRef.price > 0 ? ((price - fastRef.price) / fastRef.price) * 100 : 0;
  const slowMove = slowRef.price > 0 ? ((price - slowRef.price) / slowRef.price) * 100 : 0;
  let fired: { tier: "FAST" | "SLOW"; level: number; move: number; span: number } | null = null;
  const fastSpan = now - fastRef.at;
  const slowSpan = now - slowRef.at;
  if (fastSpan >= ONSET_FAST_MIN_SPAN_MS && Math.abs(fastMove) >= ONSET_LEVELS_FAST[0]!) {
    const side = fastMove < 0 ? "DOWN" : "UP";
    const lvl = highestUnfiredLevel(symbol, side, "FAST", ONSET_LEVELS_FAST, Math.abs(fastMove), now);
    if (lvl !== null) fired = { tier: "FAST", level: lvl, move: fastMove, span: fastSpan };
  }
  if (!fired && slowSpan >= ONSET_SLOW_MIN_SPAN_MS && Math.abs(slowMove) >= ONSET_LEVELS_SLOW[0]!) {
    const side = slowMove < 0 ? "DOWN" : "UP";
    const lvl = highestUnfiredLevel(symbol, side, "SLOW", ONSET_LEVELS_SLOW, Math.abs(slowMove), now);
    if (lvl !== null) fired = { tier: "SLOW", level: lvl, move: slowMove, span: slowSpan };
  }
  if (!fired) return;
  const side = fired.move < 0 ? "DOWN" : "UP";
  markLevelsFired(symbol, side, fired.tier, fired.level, now);
  postOnset(symbol, side, fired.move, fired.span, lane, fired.tier, fired.level, price, change24h);
}

function observeTick(symbol: string, price: number, lane: string, change24h: number | null = null): void {
  if (!(price > 0)) return;
  if (cascadeLastPrice.get(symbol) === price) return; // unchanged-tick dedupe (WS heartbeat reprints)
  cascadeLastPrice.set(symbol, price);
  observeOnset(symbol, price, lane, change24h); // v12.11 leading onset plane
  const now = Date.now();
  const ring = cascadeRing.get(symbol) ?? [];
  ring.push({ at: now, price });
  while (ring.length > CASCADE_MIN_TICKS && now - ring[0]!.at > CASCADE_WINDOW_MS) ring.shift();
  cascadeRing.set(symbol, ring);
  const first = ring[0]!;
  if (ring.length < CASCADE_MIN_TICKS || now - first.at < CASCADE_MIN_SPAN_MS) return;
  const movePct = ((price - first.price) / first.price) * 100;
  if (Math.abs(movePct) < CASCADE_MOVE_PCT) return;
  if (now - (cascadeLastAlert.get(symbol) ?? 0) < CASCADE_ALERT_COOLDOWN_MS) return;
  cascadeLastAlert.set(symbol, now);
  const side = movePct < 0 ? "DOWN" : "UP";
  console.log(`[price-ws] CASCADE-ALERT ${symbol} ${side} ${movePct.toFixed(2)}% in ${(now - first.at) / 1000}s (${lane}) — freeze posted to engine (both-direction deploys 10min)`);
  postOnset(symbol, side, movePct, now - first.at, lane, "CASCADE", null, price, change24h); // v12.11 — the vol-cause book records every freeze (leading LIQ-CASCADE evidence)
  void fetch("http://localhost:3000/api/internal/cascade-alert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ symbol, side, movePct: Number(movePct.toFixed(2)), windowMs: now - first.at, lane, at: now }),
  }).catch(() => {});
}

// ── v12.11 SPOT-PRINT STORE — Binance spot venue plane for the app ──────────
// The app must NOT hold WS clients (dev-mode per-bundle module instances churn
// connections + teardown, and the compile-ramp OOM budget is precious). The
// ONE sustained Binance plane from this egress is the spot !miniTicker@arr WS
// ALREADY running here (v12.8 ring-2, hours-proven). This store keeps the
// last genuine SPOT print per symbol (lane-isolated — futures/REST lanes can
// never contaminate it) and pushes a compact snapshot to the app every 3s
// (POST /api/internal/spotws-quotes → .data/spotws-quotes.json). The app's
// venue consensus reads that file as rung 0 — real Binance prices, zero REST
// weight, zero WS in the Next process. Futures-only microcaps are simply
// absent from the store → honest nulls downstream (+12 surcharge intact).
const spotPrints = new Map<string, { price: number; at: number }>();
const SPOT_PRINT_FRESH_MS = 90_000;
const SPOTWS_OUT_FILE = "/home/z/my-project/.data/spotws-quotes.json"; // v13.4 direct ownership
let spotwsPushInFlight = false;
let lastSpotwsPushLogAt = 0;

async function pushSpotPrints(): Promise<void> {
  if (spotwsPushInFlight) return;
  const now = Date.now();
  const rows: Array<{ s: string; p: number; t: number }> = [];
  for (const [sym, q] of spotPrints) {
    if (now - q.at > SPOT_PRINT_FRESH_MS) continue;
    rows.push({ s: sym, p: q.price, t: q.at });
  }
  if (rows.length === 0) return;
  spotwsPushInFlight = true;
  try {
    // v13.4 (trace 1a1849f647778885) — DIRECT file ownership: the app being
    // down must NOT blind the live-print plane (measured: 21min stale during
    // an OOM window while price-ws held ~400 fresh prints). price-ws writes
    // .data/spotws-quotes.json itself (atomic tmp+rename); the POST stays as
    // the in-app door for the venue plane.
    writeFileSync(`${SPOTWS_OUT_FILE}.tmp`, JSON.stringify({ at: now, rows }), "utf8");
    renameSync(`${SPOTWS_OUT_FILE}.tmp`, SPOTWS_OUT_FILE);
    const res = await fetch("http://localhost:3000/api/internal/spotws-quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ at: now, rows }),
    });
    if (res.ok && Date.now() - lastSpotwsPushLogAt > 600_000) {
      lastSpotwsPushLogAt = Date.now();
      console.log(`[price-ws] spot-prints push active — ${rows.length} fresh Binance spot quotes → app venue plane (v12.11)`);
    }
  } catch {
    /* app restarting — file ages out honestly, venue rung 0 skips */
  } finally {
    spotwsPushInFlight = false;
  }
}
setInterval(() => void pushSpotPrints(), 3000);

// ── v12.8 SPOT-ARR ring — Binance spot WS (rung 2) ──────────────────────────
// Raw stream frames arrive as the event object itself (no combined-wrapper):
// { e:"24hrMiniTicker", E, s, c, o, h, l, v, q }. Symbol parity with futures
// tickers is 1:1 for USDT pairs that exist on both planes (BTCUSDT…);
// futures-only tickers simply never arrive here and stay on REST fuel (honest).
function connectSpotWs(): void {
  try {
    const url = SPOT_WS_MIRRORS[spotWsMirrorIdx % SPOT_WS_MIRRORS.length]!;
    const mirror = new URL(url).host;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      spotWsLastFrame = Date.now();
      console.log(`[price-ws] spot !miniTicker@arr WS open (v13.3 mirror=${mirror} rung=${spotWsMirrorIdx % SPOT_WS_MIRRORS.length})`);
    };
    ws.onmessage = (ev) => {
      try {
        // v12.8.1 — !miniTicker@arr payloads arrive as an ARRAY of miniTicker
        // objects (measured live: frames with e=undefined when parsed as a
        // single object). Accept array / combined-wrapper / single-object.
        const raw = JSON.parse(String(ev.data)) as unknown;
        const items: Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }> = Array.isArray(raw)
          ? (raw as Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }>)
          : raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
            ? ((raw as { data: Array<{ e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }> }).data)
            : [raw as { e?: string; s?: string; c?: string; o?: string; h?: string; l?: string; q?: string; E?: number }];
        for (const d of items) {
          if (!d || !d.s || !d.s.endsWith("USDT")) continue;
          spotWsLastFrame = Date.now();
          const price = Number(d.c);
          if (!(price > 0)) continue;
          prices.set(d.s, {
            symbol: d.s,
            price,
            change24h: d.o ? ((price - Number(d.o)) / Number(d.o)) * 100 : 0,
            high24h: Number(d.h) || price,
            low24h: Number(d.l) || price,
            volume24h: Number(d.q) || 0,
            at: d.E || Date.now(),
          });
          spotPrints.set(d.s, { price, at: d.E || Date.now() }); // v12.11 lane-isolated venue plane
          observeTick(d.s, price, "WS·SPOT", d.o ? ((price - Number(d.o)) / Number(d.o)) * 100 : null); // v12.10 tick-velocity cascade detector
          lastEventAt = Date.now();
        }
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      // v13.3 — advance to the NEXT mirror before reconnecting (failover ring)
      spotWsMirrorIdx = (spotWsMirrorIdx + 1) % SPOT_WS_MIRRORS.length;
      console.log(`[price-ws] spot arr stream closed (${mirror}) — reconnect 5s on mirror=${SPOT_WS_MIRRORS[spotWsMirrorIdx]!.split("/")[2]}`);
      setTimeout(connectSpotWs, 5000);
    };
    ws.onerror = () => {};
  } catch (err) {
    console.error("[price-ws] spot connect error", err);
    setTimeout(connectSpotWs, 5000);
  }
}

// ── v13.5 FUTURES-BOOKTICKER-RING (trace 1a184d8bbb826f0d — operator mandate:
// «اتصال به صرافی بایننس فیوچرز پایدار نیست») ──────────────────────────────
// fstream format matrix probed LIVE from this box 2026-10-29 ~03:05 Tehran
// (three probe runs, /home/z/.audit/probe-fstream{,2,3}.ts):
//   !miniTicker@arr / !ticker@arr / !markPrice@arr / !forceOrder@arr → ZERO frames
//   combined /stream?streams=…  → ZERO frames
//   <sym>@miniTicker / @aggTrade / @kline_1m → ZERO frames
//   <sym>@bookTicker → ALIVE ×3 runs: btc 630-5400 fr, eth 1038 fr, first ~250ms
// Engineering verdict: the egress suppresses ALL-MARKET + multiplexed + most
// raw lanes but passes RAW bookTicker. So the futures plane gets a per-symbol
// bookTicker ring over the liquid perp core — best bid/ask → mid = the LIVE
// exchange-pushed perp price (zero REST weight, zero fapi 418 exposure).
// Frames are parse-throttled per symbol (250ms — majors burst 100-300 fr/s on
// a 2-vCPU box). Quotes land in .data/futws-quotes.json every 3s (atomic
// tmp+rename, direct ownership v13.4-style) — the app reads that file for
// futures liveness + ticker overlay; app restarts never blind it.
const FUT_WS_BASE = "wss://fstream.binance.com/ws/";
// v13.5.1 — ring repair (trace 1a18a758cb887281, operator report «NX-3196 چرا
// همچنان نمایش داده می‌شود»): five entries produced ZERO frames — spot-named
// symbols that do not exist on the futures plane (PEPEUSDT/SHIBUSDT/BONKUSDT/
// FLOKIUSDT — the perps are the 1000-prefix listings) plus a dead TONUSDT
// stream. 44 entries − 5 silent = the 39 rows the ring actually printed.
// With fapi REST IP-banned (418), futures-only symbols outside the ring had
// NO perp-native quote at all → sim tape → v10.16 settlement deferral froze
// open cards (NX-3196 held past TTL, unsettled by doctrine). Corrected to the
// real perp symbols (WS-probed live: bid frames confirmed for all four) and
// the dead TON entry dropped — 43 fully-streaming liquid perps.
const FUT_CORE_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "1000SHIBUSDT", "1000PEPEUSDT", "SUIUSDT", "DOTUSDT", "NEARUSDT", "LTCUSDT", "APTUSDT",
  "1000BONKUSDT", "UNIUSDT", "ARBUSDT", "OPUSDT", "FILUSDT", "INJUSDT", "SEIUSDT", "TIAUSDT",
  "ATOMUSDT", "ETCUSDT", "BCHUSDT", "XLMUSDT", "HBARUSDT", "TRXUSDT", "AAVEUSDT", "WIFUSDT",
  "1000FLOKIUSDT", "FETUSDT", "ORDIUSDT", "RUNEUSDT", "WLDUSDT", "ONDOUSDT", "ENAUSDT", "JUPUSDT",
  "PYTHUSDT", "ALGOUSDT", "CRVUSDT",
];
const FUT_PARSE_THROTTLE_MS = 250;
const FUT_BOOK_FRESH_MS = 30_000;
interface FutQuote { bid: number; ask: number; mid: number; at: number }
const futBook = new Map<string, FutQuote>();
const futLastParse = new Map<string, number>();
const futCloses = new Map<string, number>();
let futBookLastFrame = 0;
let futOpenLogged = 0;
const FUTWS_OUT_FILE = "/home/z/my-project/.data/futws-quotes.json";

function connectFutBook(sym: string): void {
  try {
    const ws = new WebSocket(`${FUT_WS_BASE}${sym.toLowerCase()}@bookTicker`);
    ws.onopen = () => {
      futBookLastFrame = Date.now();
      futCloses.set(sym, 0);
      futOpenLogged++;
      if (futOpenLogged === 1 || futOpenLogged % 11 === 0) {
        console.log(`[price-ws] futures bookTicker ring open #${futOpenLogged} (${sym}) — live Binance perp best bid/ask plane (v13.5.1)`);
      }
    };
    ws.onmessage = (ev) => {
      const now = Date.now();
      futBookLastFrame = now;
      // parse throttle — bookTicker on majors bursts 100-300 frames/s; 4/s per
      // symbol is far beyond display/overlay needs and keeps the box cool.
      if (now - (futLastParse.get(sym) ?? 0) < FUT_PARSE_THROTTLE_MS) return;
      futLastParse.set(sym, now);
      try {
        const d = JSON.parse(String(ev.data)) as { s?: string; b?: string; a?: string };
        const bid = Number(d.b);
        const ask = Number(d.a);
        if (!(bid > 0) || !(ask > 0) || ask < bid) return;
        const mid = (bid + ask) / 2;
        futBook.set(sym, { bid, ask, mid, at: now });
        const prev = prices.get(sym);
        prices.set(sym, {
          symbol: sym,
          price: mid,
          change24h: prev?.change24h ?? 0,
          high24h: prev?.high24h ?? mid,
          low24h: prev?.low24h ?? mid,
          volume24h: prev?.volume24h ?? 0,
          at: now,
        });
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      const n = (futCloses.get(sym) ?? 0) + 1;
      futCloses.set(sym, n);
      const delay = 5000 + Math.floor(Math.random() * 3000) + Math.min(n, 6) * 5000; // jitter + per-symbol backoff
      setTimeout(() => connectFutBook(sym), delay);
    };
    ws.onerror = () => {};
  } catch {
    setTimeout(() => connectFutBook(sym), 8000);
  }
}

// v13.5 — futures-quotes file writer: atomic direct ownership, mirrors the
// spotws v13.4 contract (the app being down must never blind the live plane).
setInterval(() => {
  if (futBook.size === 0) return;
  const now = Date.now();
  const rows: Array<{ s: string; b: number; a: number; m: number; t: number }> = [];
  for (const [sym, q] of futBook) {
    if (now - q.at > FUT_BOOK_FRESH_MS) continue;
    rows.push({ s: sym, b: q.bid, a: q.ask, m: q.mid, t: q.at });
  }
  if (rows.length === 0) return;
  try {
    writeFileSync(`${FUTWS_OUT_FILE}.tmp`, JSON.stringify({ at: now, rows }), "utf8");
    renameSync(`${FUTWS_OUT_FILE}.tmp`, FUTWS_OUT_FILE);
  } catch {
    /* best-effort telemetry */
  }
}, 3000);

async function restPoll() {
  if (restBannedUntil > 0 && Date.now() >= restBannedUntil) {
    // v10.8 TASK-49 — ledger-gated resume: our window elapsed but the shared
    // ledger may still carry a live pool ban another process discovered.
    // v1.1 scope split: resume defers ONLY while an UNKNOWN-SCOPE ("_pool")
    // ban is live — a single named pool member's ban no longer silences this
    // lane (majority-clean pool measured 2026-10-20; our own 418 discoveries
    // still pause THIS lane via restBannedUntil as before).
    const poolBan = ledgerUnknownScopeBanUntil();
    if (poolBan > Date.now()) {
      if (poolBan > restBannedUntil) {
        restBannedUntil = poolBan;
        console.log(`[price-ws] shared ledger still bans fapi pool (unknown scope) until ${new Date(poolBan).toISOString()} — resume deferred`);
      }
      return;
    }
    restBannedUntil = 0;
    console.log("[price-ws] REST ban window elapsed — probe resume");
  }
  if (Date.now() < restBannedUntil) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    // v12.6.1 connection-recycle: fresh egress draw per poll (see fapi-gate)
    const res = await fetch(REST_URL, { signal: ctrl.signal, cache: "no-store", headers: { Connection: "close" } });
    clearTimeout(timer);
    if (res.status === 418 || res.status === 429) {
      // v10.8: honor the REAL body end first (Binance names IP + epoch),
      // fall back to retry-after, then the 60s soft default.
      let until = 0;
      let namedIp: string | null = null;
      try {
        const body = await res.text();
        const m = /IP\(([\d.]+)\)\s*banned until (\d+)/i.exec(body);
        if (m) {
          namedIp = m[1]!;
          const real = Number(m[2]);
          if (Number.isFinite(real) && real > Date.now()) until = real;
        } else {
          const u = /banned until (\d{10,16})/i.exec(body);
          if (u) {
            let ts = Number(u[1]);
            if (ts < 10_000_000_000) ts *= 1000;
            if (ts > Date.now()) until = ts;
          }
        }
      } catch {
        /* body unreadable */
      }
      if (!until) {
        const ra = Number(res.headers.get("retry-after") ?? 0);
        until = Date.now() + Math.min(Math.max(ra, 60), 4 * 3600) * 1000;
      }
      writeLedgerBan(namedIp, until); // shared truth — other processes stay silent too
      if (until > restBannedUntil) {
        console.log(`[price-ws] REST ${res.status} IP-ban/ratelimit — backing off until ${new Date(until).toISOString()}${namedIp ? ` (IP ${namedIp})` : ""}`);
        restBannedUntil = until;
      }
      return;
    }
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }>;
    for (const r of rows) {
      if (!r.symbol.endsWith("USDT")) continue;
      const prev = prices.get(r.symbol);
      prices.set(r.symbol, {
        symbol: r.symbol,
        price: Number(r.lastPrice),
        change24h: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.quoteVolume),
        at: Date.now(),
      });
      void prev;
    }
    lastEventAt = Date.now();
  } catch {
    /* keep last known prices */
  }
}

// v12.2 TASK-52 — SPOT-MIRROR fuel poll: active while BOTH WS lanes are dead
// AND the fapi pool is banned (source WS OFFLINE / WS·REST·SPOT). 10s cadence
// (last-resort freshness, ~480 weight/min on the spot pool — trivial).
async function spotPoll() {
  if (Date.now() < spotBannedUntil) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(SPOT_URL, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (res.status === 418 || res.status === 429) {
      spotBannedUntil = Date.now() + 60_000; // own pool, own soft backoff — no ledger write
      spotLastOkAt = 0;
      console.log("[price-ws] SPOT-MIRROR rung rate-limited — spot backoff 60s (separate pool, no fapi poke)");
      return;
    }
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ symbol: string; lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }>;
    for (const r of rows) {
      if (!r.symbol.endsWith("USDT")) continue;
      prices.set(r.symbol, {
        symbol: r.symbol,
        price: Number(r.lastPrice),
        change24h: Number(r.priceChangePercent),
        high24h: Number(r.highPrice),
        low24h: Number(r.lowPrice),
        volume24h: Number(r.quoteVolume),
        at: Date.now(),
      });
      const sp = Number(r.lastPrice); // v12.11 — spot REST prints are genuine Binance spot too
      if (sp > 0) spotPrints.set(r.symbol, { price: sp, at: Date.now() });
    }
    lastEventAt = Date.now();
    if (spotLastOkAt === 0) console.log("[price-ws] SPOT-MIRROR fuel active — spot ticker/24hr feeding prices (fapi banned, WS lanes dead)");
    spotLastOkAt = Date.now();
  } catch {
    /* keep last known prices */
  }
}

function connect() {
  try {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      lastWsFrame = Date.now();
      source = "WS PUSH";
      console.log("[price-ws] miniTicker stream open");
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { data?: { s: string; c: string; o: string; h: string; l: string; q: string; E: number } };
        const d = msg.data;
        if (!d || !d.s.endsWith("USDT")) return;
        lastWsFrame = Date.now();
        prices.set(d.s, {
          symbol: d.s,
          price: Number(d.c),
          change24h: ((Number(d.c) - Number(d.o)) / Number(d.o)) * 100,
          high24h: Number(d.h),
          low24h: Number(d.l),
          volume24h: Number(d.q),
          at: d.E || Date.now(),
        });
        observeTick(d.s, Number(d.c), "WS PUSH", d.o ? ((Number(d.c) - Number(d.o)) / Number(d.o)) * 100 : null); // v12.10 tick-velocity cascade detector
        lastEventAt = Date.now();
      } catch {
        /* skip */
      }
    };
    ws.onclose = () => {
      console.log("[price-ws] stream closed — reconnect 5s");
      setTimeout(connect, 5000);
    };
    ws.onerror = () => {};
  } catch (err) {
    console.error("[price-ws] connect error", err);
    setTimeout(connect, 5000);
  }
}

// v13.5.1 — staggered futures bookTicker ring boot (43 liquid perps after the
// v13.5.1 ring repair; staggered to stay inside fstream's per-IP connection-attempt budget).
FUT_CORE_SYMBOLS.forEach((sym, i) => setTimeout(() => connectFutBook(sym), 1500 + i * 250));

// v14.0 stall watchdog → fuel priority (binance futures WS > futures bookTicker ring > binance spot WS > REST > OFFLINE)
setInterval(() => {
  const wsAlive = Date.now() - lastWsFrame <= STALL_MS;
  const futBookAlive = Date.now() - futBookLastFrame <= STALL_MS;
  const spotWsAlive = Date.now() - spotWsLastFrame <= STALL_MS;
  const banned = Date.now() < restBannedUntil;
  let next: typeof source;
  if (wsAlive) next = "WS PUSH";
  else if (futBookAlive) next = "WS·FUT-BOOK";
  else if (spotWsAlive) next = "WS·SPOT";
  else if (banned) next = Date.now() - spotLastOkAt <= 30_000 ? "WS·REST·SPOT" : "WS OFFLINE";
  else next = "WS·REST 2.5S";
  if (source !== next) {
    console.log(`[price-ws] source → ${next}${!wsAlive && spotWsAlive ? " (futures fstream silent — spot-arr ring fuel, v12.8)" : ""}${banned && !wsAlive && !spotWsAlive && next === "WS OFFLINE" ? ` (REST ban until ${new Date(restBannedUntil).toISOString()})` : ""}${next === "WS·REST·SPOT" ? " (SPOT-MIRROR fuel rung, Task-52)" : ""}`);
    source = next;
  }
}, 5000);

setInterval(() => {
  if (source === "WS·REST 2.5S") void restPoll();
}, 2500);
setInterval(() => {
  // v12.2 TASK-52 — spot rung: while the fapi pool is banned and both WS
  // lanes are dead, feed prices from the spot pool every 10s instead of
  // sitting dark; the stall watchdog promotes the source label once fresh
  // spot rows land. Own pool, own backoff — the fapi ledger stays untouched.
  if (source === "WS OFFLINE" || source === "WS·REST·SPOT") void spotPoll();
}, 10_000);

// universe sync from terminal pulse
async function syncUniverse() {
  try {
    const res = await fetch("http://localhost:3000/api/pulse", { cache: "no-store" });
    if (!res.ok) return;
    const snap = (await res.json()) as { market?: Array<{ symbol: string }> };
    for (const m of snap.market ?? []) {
      if (!prices.has(m.symbol)) prices.set(m.symbol, { symbol: m.symbol, price: 0, change24h: 0, high24h: 0, low24h: 0, volume24h: 0, at: 0 });
    }
  } catch {
    /* terminal may be restarting */
  }
}
void syncUniverse();
setInterval(syncUniverse, 5 * 60_000);

const io = new Server(PORT, { cors: { origin: "*" }, path: "/" });

io.on("connection", (socket) => {
  socket.emit("prices:snapshot", {
    source,
    rows: [...prices.values()].filter((r) => r.price > 0),
  });
  socket.emit("price:source", { source, at: Date.now() });
});

setInterval(() => {
  const rows = [...prices.values()].filter((r) => r.price > 0);
  if (rows.length > 0) io.emit("prices", { source, rows, at: Date.now() });
}, 1000);

setInterval(() => {
  io.emit("price:source", { source, at: Date.now() });
}, 10_000);

console.log(`[price-ws] socket.io listening on :${PORT} — path /`);
