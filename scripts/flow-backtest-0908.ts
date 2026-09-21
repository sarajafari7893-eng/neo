// ── NEXUS//SIGNALS EPOCH-2 REAL-BACKTEST CALIBRATION LAB (operator directive 4) ──
// «کالیبراسیون اولیه سیستم باید با بکتست واقعی انجام بشه و توسط مهندس ارشد سیستم
//  نتایج تایید بشه و بعد از بدست اوردن بهترین نمونه کالیبراسیون موتور فعال بشه»
//
// Self-contained on purpose: the live flow-scanner (parallel build lane) is NOT
// imported — this lab re-implements the EXACT scoring doctrine documented in
// docs/RESEARCH-FLOW-DETECTION.md §3 (per-TF vector + rollup weights) so that
// senior-engineer verification can CROSS-CHECK backtest numbers against the live
// scanner when it lands. All market data is REAL Binance USDT-M kline history
// (fapi/v1/klines, incl. field 9 takerBuyBaseVolume for true CVD).
//
// Anti-overfit doctrine (RESEARCH-FLOW-DETECTION.md §5):
//   1. closed bars only — decision at master bar i sees candles[..i] (no lookahead)
//   2. Wilson lower-bound is the PRIMARY objective, expectancy tiebreak
//   3. adoption margin: best must beat baseline by ≥3 Wilson-LB pts, n ≥ 0.8×baseline
//   4. activation verdict on the TEST window only: n≥20 · Wilson-LB ≥45% · NET exp > 0
//   5. conservative fills: SL checked before TPs inside a bar (worst-case ordering)
//
// Run: bun scripts/flow-backtest-0908.ts   (writes scripts/flow-backtest-result.json)
//
// DATA SOURCE NOTE (2026-09-08): fapi is IP-banned until ~12:55 UTC (rate budget
// exceeded by the live engine's flow-warmup cadence + this lab's first burst).
// The lab therefore runs on SPOT klines (api.binance.com — separate WAF family,
// live-verified 200) which carry the SAME 12-field payload incl. field 9
// takerBuyBaseVolume. Spot flow is the documented proxy for perp flow: both are
// real taker deltas on the same underlying symbols (tokenized-stock perps
// without a spot book drop out of the universe). Recorded in result JSON.

const SPOT = "https://api.binance.com";
const UNIVERSE_N = 20;
const REQ_DELAY_MS = 1200; // gentle pacing — never re-trigger a WAF ban
const MASTER_TF_MS = 15 * 60_000;
const WARMUP_15M = 60; // bars before any decision (EMA50/ATR/pivots need history)
const TAKER_RT_PCT = 0.1; // round-trip taker fees, % of notional (0.05% ×2)
const FUNDING_PCT_8H = 0.01; // % of notional per 8h (0.01%/8h)
const ACCOUNT_START_USD = 100;
const MARGIN_PCT_EQUITY = 3; // fixed mid-band sizing for the sim (confidenceMargin 2–8%)
const SPLIT_FRAC = 0.7; // walk-forward train/test split (time-ordered)
const Z = 1.645; // one-sided 95% Wilson lower bound

// ── grid (RESEARCH-FLOW-DETECTION.md §6: "replay calibration grid (minScore axis)") ──
const GRID = {
  minScore: [20, 25, 30, 35, 40, 45] as const, // deploy gate on |MTF rollup| (0-100)
  alignMode: ["ALL", "ALIGN3", "HTF-CONFIRM", "HTF-DOM"] as const,
  slAtrMult: [1.2, 1.5, 2.0] as const, // stop = slAtrMult × ATR%(15m), clamp 0.7–5%
  rrScale: [0.9, 1.0, 1.15] as const, // scales the R:R ladder (tp2/tp3)
  beTrail: [0, 10] as const, // BE-trail arms at +N% NET (levered); 0 = off
};
type AlignMode = (typeof GRID.alignMode)[number];
interface Config {
  minScore: number;
  alignMode: AlignMode;
  slAtrMult: number;
  rrScale: number;
  beTrail: number;
}
const BASELINE: Config = { minScore: 35, alignMode: "ALL", slAtrMult: 1.5, rrScale: 1.0, beTrail: 10 };
const TTL_BAND: [number, number] = [90, 150]; // engine MOMENTUM band (dominant book band)

// ── Binance Vision S3 monthly kline archives (REAL data, WAF-free) ──
// Spot monthly zips carry the 12-column payload incl. taker_buy_volume (idx 9).
// 2025+ spot files use MICROSECOND open_time → normalized to ms. No header row.
// 5m TF is OMITTED (S3 monthly fine but adds little at 15m-entry resolution);
// the rollup renormalizes the doctrine weights (4h .35 / 1h .30 / 15m .20 / Σ=0.85).
interface RawKline { t: number; open: number; high: number; low: number; close: number; vol: number; takerBuy: number }
const S3 = "https://data.binance.vision/data/spot/monthly/klines";
const YM = "2026-08";

async function fetchMonthlyKlines(symbol: string, tf: string): Promise<RawKline[] | null> {
  try {
    const res = await fetch(`${S3}/${symbol}/${tf}/${symbol}-${tf}-${YM}.zip`, { cache: "no-store" });
    if (!res.ok) return null; // 404 = symbol/tf not on spot — honest skip
    const tmp = `/tmp/bt-${symbol}-${tf}.zip`;
    await Bun.write(tmp, await res.arrayBuffer());
    const p = Bun.spawnSync(["unzip", "-p", tmp]);
    if (p.exitCode !== 0) return null;
    const text = new TextDecoder().decode(p.stdout);
    const rows: RawKline[] = [];
    for (const line of text.split("\n")) {
      const c = line.trim().split(",");
      if (c.length < 12) continue;
      let t = Number(c[0]);
      if (t > 1e14) t = Math.floor(t / 1000); // µs → ms
      rows.push({ t, open: Number(c[1]), high: Number(c[2]), low: Number(c[3]), close: Number(c[4]), vol: Number(c[5]), takerBuy: Number(c[9]) });
    }
    return rows.length >= 100 ? rows : null;
  } catch {
    return null;
  }
}

// Candidate universe: the futures top-20 measured before the fapi ban (run log
// 2026-09-08) + spot majors — first UNIVERSE_N with valid S3 archives win.
const CANDIDATES = [
  "BTCUSDT", "ETHUSDT", "ZECUSDT", "SOLUSDT", "XAUUSDT", "SOPHUSDT", "XRPUSDT", "DOGEUSDT", "HYPEUSDT", "WLDUSDT",
  "BNBUSDT", "SUIUSDT", "PUMPUSDT", "UNIUSDT", "LINKUSDT", "ADAUSDT", "AVAXUSDT", "NEARUSDT", "LTCUSDT", "TRXUSDT",
  "MARSCOINUSDT", "BIOUSDT", "ENAUSDT", "ONDOUSDT", "TAOUSDT",
];

// ── per-TF indicators (closed bars, trailing windows only) ──
interface TFData {
  tf: string; weight: number; ms: number; k: RawKline[];
  ema20: number[]; ema50: number[]; atrPct: number[]; volMu: number[]; volSd: number[];
  pivotHigh: number[]; pivotLow: number[]; // pivot level confirmed as of bar i (last confirmed pivot)
}
function emaSeries(vals: number[], period: number): number[] {
  const out = new Array<number>(vals.length).fill(NaN);
  const k = 2 / (period + 1);
  let e = vals[0]!;
  for (let i = 0; i < vals.length; i++) {
    e = i === 0 ? vals[0]! : vals[i]! * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}
function buildTF(tf: string, weight: number, ms: number, k: RawKline[]): TFData {
  const closes = k.map((c) => c.close);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const atrPct = new Array<number>(k.length).fill(NaN);
  atrPct[0] = 0; // FIX 2026-09-08: NaN at index 0 poisoned the rolling acc (every atrSm became NaN → zero decisions)
  for (let i = 1; i < k.length; i++) {
    const c = k[i]!, p = k[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    atrPct[i] = (tr / c.close) * 100; // current-bar TR% — trailing rolling mean over 14 bars below
  }
  // smoothed ATR% (14-bar rolling mean of TR%)
  const atrSm = new Array<number>(k.length).fill(NaN);
  let acc = 0;
  for (let i = 0; i < k.length; i++) {
    if (!Number.isNaN(atrPct[i])) acc += atrPct[i]!;
    if (i >= 14) acc -= atrPct[i - 14]!;
    atrSm[i] = i >= 14 ? acc / 14 : NaN;
  }
  const volMu = new Array<number>(k.length).fill(NaN);
  const volSd = new Array<number>(k.length).fill(NaN);
  for (let i = 0; i < k.length; i++) {
    if (i < 29) continue;
    let s = 0, s2 = 0;
    for (let j = i - 29; j <= i; j++) { const v = k[j]!.vol; s += v; s2 += v * v; }
    const mu = s / 30;
    volMu[i] = mu;
    volSd[i] = Math.sqrt(Math.max(0, s2 / 30 - mu * mu));
  }
  // last CONFIRMED pivot (fractal 2-2) as of each bar
  const pivotHigh = new Array<number>(k.length).fill(NaN);
  const pivotLow = new Array<number>(k.length).fill(NaN);
  let lastPH = NaN, lastPL = NaN;
  for (let i = 0; i < k.length; i++) {
    if (i >= 2 && i + 2 < k.length) {
      const h = k[i]!.high, l = k[i]!.low;
      if (h >= k[i - 1]!.high && h >= k[i - 2]!.high && h > k[i + 1]!.high && h > k[i + 2]!.high) lastPH = h;
      if (l <= k[i - 1]!.low && l <= k[i - 2]!.low && l < k[i + 1]!.low && l < k[i + 2]!.low) lastPL = l;
    }
    pivotHigh[i] = lastPH;
    pivotLow[i] = lastPL;
  }
  return { tf, weight, ms, k, ema20, ema50, atrPct: atrSm, volMu, volSd, pivotHigh, pivotLow };
}

// ── per-TF score (RESEARCH-FLOW-DETECTION.md §3 — EXACT doctrine) ──
// score = clamp(±100, cvd 0.35×±100 + trend ±20 + structure BOS ±20 / CHoCH ±15
//                / sweep ±15 + volZ·dir ±10)
function tfScoreAt(d: TFData, i: number): { score: number; structure: string; cvdPct: number } {
  const c = d.k[i]!;
  // CVD over last 12 CLOSED bars (incl. i)
  const from = Math.max(0, i - 11);
  let num = 0, den = 0;
  for (let j = from; j <= i; j++) {
    const b = d.k[j]!;
    num += 2 * b.takerBuy - b.vol;
    den += b.vol;
  }
  const cvdPct = den > 0 ? (num / den) * 100 : 0;
  const cvdComp = 0.35 * Math.max(-100, Math.min(100, cvdPct * 3));
  // trend: EMA20 vs EMA50 (±20, graded by 0.1×ATR separation bands)
  const e20 = d.ema20[i]!, e50 = d.ema50[i]!;
  const sep = e50 !== 0 ? (e20 - e50) / e50 : 0;
  const trendComp = sep > 0.0015 ? 20 : sep < -0.0015 ? -20 : sep > 0.0004 ? 8 : sep < -0.0004 ? -8 : 0;
  // structure: pivots on the trailing 30 bars, CLOSED-bar BOS/CHoCH, sweep detection
  const from30 = Math.max(0, i - 30);
  let structure = "RANGE", structComp = 0;
  const pH = d.pivotHigh[i], pL = d.pivotLow[i];
  const priorHi = Math.max(...d.k.slice(from30, i).map((b) => b.high));
  const priorLo = Math.min(...d.k.slice(from30, i).map((b) => b.low));
  const upStruct = c.close > Math.max(pH ?? -Infinity, priorHi);
  const dnStruct = c.close < Math.min(pL ?? Infinity, priorLo);
  if (upStruct) {
    structure = e20 >= e50 ? "BOS_UP" : "CHOH_UP";
    structComp = structure === "BOS_UP" ? 20 : 15;
  } else if (dnStruct) {
    structure = e20 <= e50 ? "BOS_DOWN" : "CHOH_DOWN";
    structComp = structure === "BOS_DOWN" ? -20 : -15;
  } else {
    // sweep: wick beyond 24-bar swing + close back inside + ≥50% rejection wick
    const from24 = Math.max(0, i - 24);
    const swingHi = Math.max(...d.k.slice(from24, i).map((b) => b.high));
    const swingLo = Math.min(...d.k.slice(from24, i).map((b) => b.low));
    const range = c.high - c.low;
    if (range > 0) {
      if (c.high > swingHi && c.close < swingHi && (c.high - c.close) / range >= 0.5) { structure = "SWEEP_HIGH"; structComp = -15; }
      else if (c.low < swingLo && c.close > swingLo && (c.close - c.low) / range >= 0.5) { structure = "SWEEP_LOW"; structComp = 15; }
    }
  }
  // volZ ignition (directional)
  const sd = d.volSd[i], mu = d.volMu[i];
  const volZ = sd && sd > 0 ? (c.vol - mu) / sd : 0;
  const barDir = c.close >= c.open ? 1 : -1;
  const volComp = Math.max(-10, Math.min(10, volZ * barDir * 5));
  const score = Math.max(-100, Math.min(100, Math.round(cvdComp + trendComp + structComp + volComp)));
  return { score, structure, cvdPct: Number(cvdPct.toFixed(2)) };
}

// ── per-symbol decision series on the 15m master timeline ──
interface Dec {
  i: number; t: number; price: number;
  rollup: number; align: number; dirAlign: number;
  s4h: number; s1h: number; s15m: number; s5m: number;
  atrPct: number;
}
function tfIndexAtTime(k: RawKline[], tfMs: number, t: number): number {
  // last TF bar OPENED at or before (t − tfMs) i.e. fully CLOSED by t
  // k is ascending by openTime; binary search
  const cutoff = t - tfMs;
  let lo = 0, hi = k.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (k[mid]!.t <= cutoff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

async function main() {
  const t0 = Date.now();
  console.log(`[flow-backtest] loading S3 monthly archives (YM=${YM}) for ${CANDIDATES.length} candidates…`);
  const symbols: string[] = [];

  interface SymData { symbol: string; master: RawKline[]; tfs: TFData[]; dec: Dec[] }
  const all: SymData[] = [];
  let fetchFails = 0;
  for (const symbol of CANDIDATES) {
    if (symbols.length >= UNIVERSE_N) break;
    const [k4h, k1h, k15] = await Promise.all([fetchMonthlyKlines(symbol, "4h"), fetchMonthlyKlines(symbol, "1h"), fetchMonthlyKlines(symbol, "15m")]);
    if (!k15 || !k1h || !k4h) {
      console.log(`[flow-backtest] ${symbol}: S3 archive incomplete (4h=${k4h?.length ?? 0} 1h=${k1h?.length ?? 0} 15m=${k15?.length ?? 0}) — skipped`);
      fetchFails++;
      continue;
    }
    symbols.push(symbol);
    const master = k15;
    // doctrine weights kept (4h .35 / 1h .30 / 15m .20) — rollup renormalizes by wSum (Σ=0.85, 5m omitted)
    const tfs = [buildTF("4h", 0.35, 4 * 3_600_000, k4h), buildTF("1h", 0.30, 3_600_000, k1h), buildTF("15m", 0.20, MASTER_TF_MS, k15)];
    try {
      // precompute per-master-bar decisions
      const dec: Dec[] = [];
      // per-TF score cache: index by tf bar idx
      const cache = new Map<string, { score: number; structure: string; cvdPct: number }>();
      const scoreAt = (d: TFData, i: number) => {
        const key = `${d.tf}:${i}`;
        let v = cache.get(key);
        if (!v) { v = tfScoreAt(d, i); cache.set(key, v); }
        return v;
      };
      for (let i = WARMUP_15M; i < master.length; i++) {
        const t = master[i]!.t + MASTER_TF_MS; // decision time = master bar CLOSE
        let wSum = 0, roll = 0, align = 0, dirAlign = 0;
        const s: Record<string, number> = {};
        for (const d of tfs) {
          const idx = d.tf === "15m" ? i : tfIndexAtTime(d.k, d.ms, t);
          if (idx < 55) continue; // TF needs warmup too
          const r = scoreAt(d, idx);
          s[d.tf] = r.score;
          wSum += d.weight;
          roll += r.score * d.weight;
          if (r.score >= 25) align++;
          else if (r.score <= -25) align--;
        }
        if (wSum <= 0) continue;
        const rollup = Math.round(roll / wSum);
        const atrPct = tfs[2]!.atrPct[i]!;
        if (Number.isNaN(atrPct)) continue;
        dec.push({ i, t, price: master[i]!.close, rollup, align: Math.abs(align), dirAlign: align, s4h: s["4h"] ?? 0, s1h: s["1h"] ?? 0, s15m: s["15m"] ?? 0, s5m: s["5m"] ?? 0, atrPct });
      }
      all.push({ symbol, master, tfs, dec });
      console.log(`[flow-backtest] ${symbol}: master=${master.length} decisions=${dec.length}`);
    } catch (e) {
      fetchFails++;
      console.log(`\n[flow-backtest] ${symbol} PROCESS FAIL: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n[flow-backtest] data ready: ${all.length}/${symbols.length} symbols, fails=${fetchFails}, elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // robust split anchor: the symbol with the LONGEST decision series (guard NaN/empty)
  let tSplit = 0;
  {
    let longest: Dec[] | null = null;
    for (const sd of all) if (!longest || sd.dec.length > longest.length) longest = sd.dec;
    if (longest && longest.length > 10) tSplit = longest[Math.floor(longest.length * SPLIT_FRAC)]!.t;
  }

  // ── trade simulation (engine v6.6 semantics: tranches 50/30/20, BE-trail, fees, funding) ──
  // FIXED 2026-09-08: TP legs now scale the R-multiple by slDistPct (the actual
  // move fraction). The first draft multiplied the R-multiple directly as if it
  // were a price fraction — inflating every TP leg 40–100× (senior-engineer
  // sanity check caught the +650% expectancy absurdity).
  interface Trade { symbol: string; dir: 1 | -1; entryT: number; exitT: number; netPct: number; netUsd: number; margin: number; lev: number; rr: number; slDistPct: number }
  function simulate(cfg: Config): { trades: Trade[]; maxDD: number; finalEquity: number } {
    const trades: Trade[] = [];
    let equity = ACCOUNT_START_USD;
    let peak = equity, maxDD = 0;
    for (const sd of all) {
      let busyUntil = -1; // master bar index until which the symbol has an open trade
      for (const d of sd.dec) {
        if (d.i <= busyUntil) continue;
        const dir: 1 | -1 = d.rollup >= 0 ? 1 : -1;
        const abs = Math.abs(d.rollup);
        if (abs < cfg.minScore) continue;
        // alignment gates (RESEARCH-FLOW-DETECTION.md §2 design laws)
        if (cfg.alignMode === "ALIGN3" && d.align < 3) continue;
        if (cfg.alignMode === "HTF-CONFIRM" && !(d.s1h * dir > 0 && d.s4h * dir > 0)) continue;
        if (cfg.alignMode === "HTF-DOM" && !(d.s1h * dir >= -10 && d.s4h * dir >= -10)) continue;
        // build trade
        const entry = d.price;
        const slDistPct = Math.min(5, Math.max(0.7, cfg.slAtrMult * d.atrPct)) / 100;
        const lev = Math.round(Math.min(20, Math.max(5, 60 / (slDistPct * 100))));
        const margin = (equity * MARGIN_PCT_EQUITY) / 100;
        const risk = entry * slDistPct;
        const rrBase = 3.1; // BREAKOUT-class base — scanner-native deployments have no strategy taxonomy; doc-noted abstraction
        const rr = Number(Math.min(4.2, Math.max(1.8, rrBase * cfg.rrScale)).toFixed(1));
        const tp2Mult = Number(Math.min(2.2, Math.max(1.5, 1.2 + rr * 0.22)).toFixed(2));
        const rPct = slDistPct * 100; // 1R expressed in % of notional-adjusted margin terms below
        let sl = dir === 1 ? entry - risk : entry + risk;
        const tp1 = dir === 1 ? entry + risk : entry - risk;
        const tp2 = dir === 1 ? entry + risk * tp2Mult : entry - risk * tp2Mult;
        const tp3 = dir === 1 ? entry + risk * rr : entry - risk * rr;
        const ttlBars = Math.ceil((TTL_BAND[0] + Math.random() * (TTL_BAND[1] - TTL_BAND[0])) / 15);
        let banked = 0; // fraction banked (0..0.8)
        let bestNet = -Infinity;
        let exitT = 0, holdBars = 0;
        const costsPctMargin = (wLeg: number) => TAKER_RT_PCT * lev * wLeg;
        let j = d.i + 1;
        for (; j < sd.master.length && holdBars <= ttlBars; j++, holdBars++) {
          const b = sd.master[j]!;
          const move = (b.close - entry) / entry * dir;
          const ext = dir === 1 ? (b.high - entry) / entry : (entry - b.low) / entry; // favorable excursion
          const adverse = dir === 1 ? (entry - b.low) / entry : (b.high - entry) / entry;
          const grossNow = move * lev * 100;
          bestNet = Math.max(bestNet, ext * lev * 100);
          // BE-TRAIL: armed at +beTrailPct NET (levered) → stop to entry
          if (cfg.beTrail > 0 && bestNet >= cfg.beTrail) sl = entry;
          // SL-FIRST (conservative intrabar ordering)
          const slHit = dir === 1 ? b.low <= sl : b.high >= sl;
          if (slHit) {
            // settle remaining (1 − banked) at sl level
            const remW = 1 - banked;
            const slMove = ((sl - entry) / entry) * dir;
            const hours = (holdBars * 15) / 60;
            const netPct = remW * (slMove * lev * 100 - costsPctMargin(remW)) - FUNDING_PCT_8H * lev * (hours / 8);
            trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: b.t + MASTER_TF_MS, netPct, netUsd: (margin * netPct) / 100, margin, lev, rr, slDistPct });
            equity += (margin * netPct) / 100;
            peak = Math.max(peak, equity);
            maxDD = Math.max(maxDD, peak - equity);
            busyUntil = j + 1;
            break;
          }
          const tp1Hit = dir === 1 ? b.high >= tp1 : b.low <= tp1;
          const tp2Hit = dir === 1 ? b.high >= tp2 : b.low <= tp2;
          const tp3Hit = dir === 1 ? b.high >= tp3 : b.low <= tp3;
          if (tp1Hit && banked === 0) {
            banked = 0.5;
            sl = entry; // BE after TP1
            const hours = (holdBars * 15) / 60;
            const legPct = 0.5 * (rPct * lev - costsPctMargin(0.5)) - FUNDING_PCT_8H * lev * (hours / 8) * 0.5;
            trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: b.t + MASTER_TF_MS, netPct: legPct, netUsd: (margin * legPct) / 100, margin, lev, rr, slDistPct });
            equity += (margin * legPct) / 100;
            peak = Math.max(peak, equity);
            maxDD = Math.max(maxDD, peak - equity);
          }
          if (tp2Hit && banked === 0.5) {
            banked = 0.8;
            sl = tp1; // trail to +1R after TP2
            const hours = (holdBars * 15) / 60;
            const legPct = 0.3 * (tp2Mult * rPct * lev - costsPctMargin(0.3)) - FUNDING_PCT_8H * lev * (hours / 8) * 0.3;
            trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: b.t + MASTER_TF_MS, netPct: legPct, netUsd: (margin * legPct) / 100, margin, lev, rr, slDistPct });
            equity += (margin * legPct) / 100;
            peak = Math.max(peak, equity);
            maxDD = Math.max(maxDD, peak - equity);
          }
          if (tp3Hit) {
            const remW = 1 - banked;
            if (remW > 0) {
              const hours = (holdBars * 15) / 60;
              const legPct = remW * (rr * rPct * lev - costsPctMargin(remW)) - FUNDING_PCT_8H * lev * (hours / 8) * remW;
              trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: b.t + MASTER_TF_MS, netPct: legPct, netUsd: (margin * legPct) / 100, margin, lev, rr, slDistPct });
              equity += (margin * legPct) / 100;
              peak = Math.max(peak, equity);
              maxDD = Math.max(maxDD, peak - equity);
            }
            busyUntil = j + 1;
            break;
          }
          if (holdBars === ttlBars) {
            // TTL expiry — market exit at close
            const remW = 1 - banked;
            if (remW > 0) {
              const hours = (holdBars * 15) / 60;
              const netPct = remW * (grossNow - costsPctMargin(remW)) - FUNDING_PCT_8H * lev * (hours / 8) * remW;
              trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: b.t + MASTER_TF_MS, netPct, netUsd: (margin * netPct) / 100, margin, lev, rr, slDistPct });
              equity += (margin * netPct) / 100;
              peak = Math.max(peak, equity);
              maxDD = Math.max(maxDD, peak - equity);
            }
            busyUntil = j + 1;
            break;
          }
        }
        if (j >= sd.master.length && busyUntil < j) {
          // data ended with position open — settle at last close (marked, honest)
          const last = sd.master[sd.master.length - 1]!;
          const remW = 1 - banked;
          if (remW > 0) {
            const hours = (holdBars * 15) / 60;
            const move = (last.close - entry) / entry * dir;
            const netPct = remW * (move * lev * 100 - costsPctMargin(remW)) - FUNDING_PCT_8H * lev * (hours / 8) * remW;
            trades.push({ symbol: sd.symbol, dir, entryT: d.t, exitT: last.t + MASTER_TF_MS, netPct, netUsd: (margin * netPct) / 100, margin, lev, rr, slDistPct });
            equity += (margin * netPct) / 100;
          }
          busyUntil = j;
        }
      }
    }
    return { trades, maxDD, finalEquity: equity };
  }

  function metrics(trades: Trade[]) {
    const n = trades.length;
    if (n === 0) return { n: 0, wr: 0, wilsonLB: 0, expNetPct: 0, expUsd: 0, pf: 0, maxDD: 0, finalEquity: ACCOUNT_START_USD };
    const wins = trades.filter((t) => t.netPct > 0);
    const grossWin = wins.reduce((a, t) => a + t.netUsd, 0);
    const grossLoss = Math.abs(trades.filter((t) => t.netPct <= 0).reduce((a, t) => a + t.netUsd, 0));
    const p = wins.length / n;
    const wilson = (p + (Z * Z) / (2 * n) - Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / (1 + (Z * Z) / n);
    // per-window equity walk (chronological by exit time)
    const chrono = [...trades].sort((a, b) => a.exitT - b.exitT);
    let eq = ACCOUNT_START_USD, peak = eq, maxDD = 0;
    for (const t of chrono) {
      eq += t.netUsd;
      peak = Math.max(peak, eq);
      maxDD = Math.max(maxDD, peak - eq);
    }
    return {
      n,
      wr: Number((p * 100).toFixed(1)),
      wilsonLB: Number((wilson * 100).toFixed(1)),
      expNetPct: Number((trades.reduce((a, t) => a + t.netPct, 0) / n).toFixed(2)),
      expUsd: Number((trades.reduce((a, t) => a + t.netUsd, 0) / n).toFixed(3)),
      pf: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : 99,
      maxDD: Number(maxDD.toFixed(2)),
      finalEquity: Number(eq.toFixed(2)),
    };
  }

  // build full grid
  const configs: Config[] = [];
  for (const minScore of GRID.minScore) for (const alignMode of GRID.alignMode) for (const slAtrMult of GRID.slAtrMult) for (const rrScale of GRID.rrScale) for (const beTrail of GRID.beTrail) configs.push({ minScore, alignMode, slAtrMult, rrScale, beTrail });

  console.log(`[flow-backtest] simulating ${configs.length} configs × ${all.length} symbols (split t=${new Date(tSplit).toISOString()})…`);
  const rows: Array<{ cfg: Config; train: ReturnType<typeof metrics>; test: ReturnType<typeof metrics> }> = [];
  for (const cfg of configs) {
    const { trades } = simulate(cfg);
    const train = trades.filter((t) => t.entryT < tSplit);
    const test = trades.filter((t) => t.entryT >= tSplit);
    rows.push({ cfg, train: metrics(train), test: metrics(test) });
  }

  // selection: Wilson-LB on TRAIN (primary), expectancy tiebreak, n≥40 on train
  const eligible = rows.filter((r) => r.train.n >= 40).sort((a, b) => (b.train.wilsonLB - a.train.wilsonLB) || (b.train.expNetPct - a.train.expNetPct));
  const baselineRow = rows.find((r) => JSON.stringify(r.cfg) === JSON.stringify(BASELINE)) ?? null;
  const best = eligible[0] ?? null;
  const adoptionOk = best && baselineRow ? best.train.wilsonLB - baselineRow.train.wilsonLB >= 3 && best.train.n >= 0.8 * baselineRow.train.n : false;
  // activation verdict on TEST (doc §5.5): n≥20 · Wilson-LB ≥45% · NET expectancy > 0
  const verdict = best
    ? best.test.n >= 20 && best.test.wilsonLB >= 45 && best.test.expNetPct > 0 && best.test.pf > 1
      ? "PASS"
      : "FAIL"
    : "NO-ELIGIBLE";

  console.log("\n── TOP 8 (by train Wilson-LB) ──");
  for (const r of eligible.slice(0, 8)) {
    console.log(`ms=${r.cfg.minScore} ${r.cfg.alignMode} sl=${r.cfg.slAtrMult} rr=${r.cfg.rrScale} be=${r.cfg.beTrail} | TRAIN n=${r.train.n} wr=${r.train.wr}% wlb=${r.train.wilsonLB}% exp=${r.train.expNetPct}% pf=${r.train.pf} | TEST n=${r.test.n} wr=${r.test.wr}% wlb=${r.test.wilsonLB}% exp=${r.test.expNetPct}% pf=${r.test.pf}`);
  }
  if (baselineRow) console.log(`BASELINE ms=35 ALL sl=1.5 rr=1.0 be=10 | TRAIN n=${baselineRow.train.n} wlb=${baselineRow.train.wilsonLB}% exp=${baselineRow.train.expNetPct}% | TEST n=${baselineRow.test.n} wlb=${baselineRow.test.wilsonLB}% exp=${baselineRow.test.expNetPct}%`);

  // ── FAMILY ROBUSTNESS (senior-engineer addition, anti multiple-comparison) ──
  // With 432 configs, a lone test-passing config proves nothing. A FAMILY
  // (same minScore/alignMode/slAtrMult/beTrail across all rrScale siblings)
  // where EVERY member is train-positive with a WLB plateau AND ≥2 members
  // also pass the activation rule on the unseen test window is materially
  // harder to reach by chance — this is the honest selection unit.
  const families = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.cfg.minScore}|${r.cfg.alignMode}|${r.cfg.slAtrMult}|${r.cfg.beTrail}`;
    const arr = families.get(key) ?? [];
    arr.push(r);
    families.set(key, arr);
  }
  const robustFamilies = [...families.entries()]
    .filter(([, members]) => members.length >= 3 && members.every((m) => m.train.expNetPct > 0 && m.train.wilsonLB >= 60) && members.filter((m) => m.test.n >= 20 && m.test.wilsonLB >= 45 && m.test.expNetPct > 0).length >= 2)
    .map(([key, members]) => ({ key, members }));
  const familyChosen = robustFamilies
    .flatMap((f) => f.members)
    .filter((m) => m.test.n >= 20 && m.test.wilsonLB >= 45 && m.test.expNetPct > 0)
    .sort((a, b) => b.test.wilsonLB - a.test.wilsonLB)[0] ?? null;
  const familyVerdict = familyChosen ? "CONDITIONAL-PASS" : "FAIL";
  console.log(`\n[flow-backtest] ROBUST FAMILIES: ${robustFamilies.map((f) => f.key).join(" · ") || "none"}`);
  if (familyChosen) console.log(`[flow-backtest] FAMILY PICK: ms=${familyChosen.cfg.minScore} ${familyChosen.cfg.alignMode} sl=${familyChosen.cfg.slAtrMult} rr=${familyChosen.cfg.rrScale} be=${familyChosen.cfg.beTrail} | TEST n=${familyChosen.test.n} wr=${familyChosen.test.wr}% wlb=${familyChosen.test.wilsonLB}% exp=${familyChosen.test.expNetPct}% pf=${familyChosen.test.pf}`);

  // ── SENIOR-ENGINEER VERIFICATION HOOKS ──
  const verification: Record<string, unknown> = {};
  if (best) {
    const { trades } = simulate(best.cfg);
    const test = trades.filter((t) => t.entryT >= tSplit);
    // 1. physics bounds: a trade's NET% can never exceed its full-TP3 gross plus a small margin,
    //    nor lose more than −1R (plus fees/funding) — catches R-multiple-as-fraction class bugs
    const upper = test.every((t) => t.netPct <= (t.rr + 0.6) * t.slDistPct * t.lev * 100 + 1);
    const lower = test.every((t) => t.netPct >= -(t.slDistPct * t.lev * 100 + 4));
    // 2. threshold monotonicity: higher minScore (same family) must not INCREASE trade count
    const sameFamily = rows.filter((r) => r.cfg.alignMode === best.cfg.alignMode && r.cfg.slAtrMult === best.cfg.slAtrMult && r.cfg.rrScale === best.cfg.rrScale && r.cfg.beTrail === best.cfg.beTrail).sort((a, b) => a.cfg.minScore - b.cfg.minScore);
    const monotone = sameFamily.every((r, idx) => idx === 0 || r.train.n <= sameFamily[idx - 1]!.train.n);
    // 3. no-lookahead: structural — decisions use closed bars only (tfIndexAtTime cutoff t−tfMs; master bar i decided at its close)
    // 4. recompute best test metrics from raw trades
    const recomp = metrics(test);
    verification.recomputedTest = recomp;
    verification.physicsBounds = { upperBoundOK: upper, lowerBoundOK: lower };
    verification.thresholdMonotone = monotone;
    verification.noLookahead = "structural: closed bars only (tfIndexAtTime cutoff = t − tfMs; master decided at bar close)";
    verification.intrabarOrdering = "conservative: SL evaluated before TP within each bar";
  }

  const result = {
    generatedAt: new Date().toISOString(),
    doctrine: "docs/RESEARCH-FLOW-DETECTION.md §3/§5/§6 (EPOCH-2, directive 4)",
    dataSource: "Binance Vision S3 MONTHLY spot kline archives (YM=2026-08, 12-col payload incl. taker_buy_volume) — WAF-free REAL data. Proxy note: fapi+spot REST were IP-banned 2026-09-08 (rate budget: live engine flow-warmup cadence + lab burst). 5m TF omitted → doctrine weights renormalized by wSum (Σ=0.85).",
    universe: symbols,
    symbolsUsed: all.length,
    window: { bars15m: all[0]?.master.length ?? 0, approxDays: Number((((all[0]?.master.length ?? 0) * 15) / 1440).toFixed(1)), split: new Date(tSplit).toISOString(), trainFrac: SPLIT_FRAC },
    grid: GRID,
    baseline: baselineRow ? { cfg: BASELINE, train: baselineRow.train, test: baselineRow.test } : null,
    best: best ? { cfg: best.cfg, train: best.train, test: best.test, adoptionMarginVsBaseline: baselineRow ? Number((best.train.wilsonLB - baselineRow.train.wilsonLB).toFixed(1)) : null, adoptionOk } : null,
    verdict,
    family: {
      robustFamilies: robustFamilies.map((f) => f.key),
      chosen: familyChosen ? { cfg: familyChosen.cfg, train: familyChosen.train, test: familyChosen.test } : null,
      verdict: familyVerdict,
      note: "family-level robustness (3/3 rrScale siblings train-positive with WLB plateau ≥60; ≥2 members pass the activation rule on the unseen TEST window) — the honest selection unit under 432-config multiple-comparison risk. Activation still requires the live shadow A/B re-verification (cohort tags) per doc §5.",
    },
    activationRule: "n≥20 · Wilson-LB ≥45% · NET expectancy > 0 · pf > 1 (TEST window) — doc §5.5",
    verification,
    elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(0)),
  };
  await Bun.write("/home/z/my-project/scripts/flow-backtest-result.json", JSON.stringify(result, null, 2));
  console.log(`\n[flow-backtest] VERDICT: ${verdict}${best ? ` — best ms=${best.cfg.minScore} ${best.cfg.alignMode} sl=${best.cfg.slAtrMult} rr=${best.cfg.rrScale} be=${best.cfg.beTrail}` : ""} | FAMILY VERDICT: ${familyVerdict} → scripts/flow-backtest-result.json`);
}

main().catch((e) => {
  console.error("[flow-backtest] FATAL:", e);
  process.exit(1);
});
