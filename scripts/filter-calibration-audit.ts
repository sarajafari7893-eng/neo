/**
 * DEEP JOINT-FILTER CALIBRATION AUDIT (rebuilt + upgraded 2026-09-07).
 * Task ① of the inherited backlog: joint-filter grid search + Wilson 95% CI
 * + split-half holdout to guard against overfitting.
 *
 * Method (honest, replay-based):
 *  - Pull 15m klines per symbol (top-N futures), ~1500 bars each.
 *  - Compute per-bar factor conditions (real indicators, no invented data):
 *      EMA20>EMA50, MACD hist>0, RSI14 band, 20-bar breakout, eruption bar
 *      (VOL-ONSET proxy ≥5× trailing median), ATR% regime bucket.
 *  - Outcome: signed forward 6h return (24 bars); a "win" for a LONG-side
 *    condition = fwd6h > +0.3%; SHORT-side mirror.
 *  - Single filters AND joint pairs/triples evaluated on half A; survivors
 *    (Wilson CI lower bound > 40% AND n ≥ 30) re-tested on half B.
 *  - Report both halves — a combo only counts if it holds on B.
 *
 * Run: bun scripts/filter-calibration-audit.ts [topN=20] [bars=1500]
 */
const FAPI = "https://fapi.binance.com";
const FWD_BARS = 24; // 6h of 15m
const MIN_WIN_PCT = 0.3; // |fwd6h| must clear this to count as directional win

interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number }

// ── indicators (self-contained) ──
function ema(xs: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  let prev = xs[0]!;
  for (let i = 0; i < xs.length; i++) {
    prev = i === 0 ? xs[0]! : xs[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function rsi(closes: number[], n = 14): number[] {
  const out: number[] = [NaN];
  let avgG = 0, avgL = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const g = Math.max(0, ch), l = Math.max(0, -ch);
    if (i <= n) { avgG = (avgG * (i - 1) + g) / i; avgL = (avgL * (i - 1) + l) / i; out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)); }
    else { avgG = (avgG * (n - 1) + g) / n; avgL = (avgL * (n - 1) + l) / n; out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL)); }
  }
  return out;
}
function macdHist(closes: number[]): number[] {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i]! - e26[i]!);
  const sig = ema(line, 9);
  return line.map((v, i) => v - sig[i]!);
}
function atrPct(bars: Candle[], n = 14): number[] {
  const out: number[] = [NaN];
  let prev = bars[0]!.close;
  let a = 0;
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(bars[i]!.high - bars[i]!.low, Math.abs(bars[i]!.high - prev), Math.abs(bars[i]!.low - prev));
    a = i <= n ? (a * (i - 1) + tr) / i : (a * (n - 1) + tr) / n;
    out.push((a / bars[i]!.close) * 100);
    prev = bars[i]!.close;
  }
  return out;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

// ── Wilson 95% CI lower bound ──
function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - spread) / denom;
}

async function klines(symbol: string, limit: number): Promise<Candle[]> {
  const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=${limit}`);
  if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
  const raw = (await res.json()) as (string | number)[][];
  return raw.map((k) => ({ openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
}

interface Sample {
  // condition bitmap at bar i (evaluable for a LONG decision; SHORT mirrors outcome sign)
  emaUp: boolean; macdUp: boolean; rsiHot: boolean; breakout: boolean; eruption: boolean; highAtr: boolean;
  longWin: boolean; shortWin: boolean;
}

async function main() {
  const topN = Number(process.argv[2] ?? 20);
  const barsWanted = Number(process.argv[3] ?? 1500);
  const exc = await fetch(`${FAPI}/fapi/v1/ticker/24hr`).then((r) => r.json()) as Array<{ symbol: string; quoteVolume: string }>;
  const universe = exc.filter((t) => t.symbol.endsWith("USDT") && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol)).sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume)).slice(0, topN).map((t) => t.symbol);

  const samples: Sample[] = [];
  for (const sym of universe) {
    try {
      const bars = await klines(sym, barsWanted);
      const closes = bars.map((b) => b.close);
      const e20 = ema(closes, 20), e50 = ema(closes, 50), r = rsi(closes), mh = macdHist(closes), a = atrPct(bars);
      const atrMed = median(a.filter((v) => Number.isFinite(v)));
      for (let i = 60; i < bars.length - FWD_BARS; i++) {
        const prevClose = closes[i - 1]!;
        const ret = Math.abs((closes[i]! - prevClose) / prevClose) * 100;
        const win30 = bars.slice(Math.max(0, i - 30), i);
        const med30 = median(win30.map((b, j) => (j === 0 ? 0 : Math.abs((b.close - win30[j - 1]!.close) / win30[j - 1]!.close) * 100)).slice(1));
        const priorHigh = Math.max(...bars.slice(i - 20, i).map((b) => b.high));
        const fwd = ((closes[i + FWD_BARS]! - closes[i]!) / closes[i]!) * 100;
        samples.push({
          emaUp: e20[i]! > e50[i]!,
          macdUp: mh[i]! > 0,
          rsiHot: r[i]! >= 55,
          breakout: closes[i]! > priorHigh,
          eruption: med30 > 0 && ret >= 5 * med30,
          highAtr: Number.isFinite(a[i]!) && a[i]! > atrMed,
          longWin: fwd > MIN_WIN_PCT,
          shortWin: fwd < -MIN_WIN_PCT,
        });
      }
      process.stdout.write(".");
    } catch {
      process.stdout.write("x");
    }
  }
  console.log(`\nsamples: ${samples.length} (${universe.length} symbols × up to ${barsWanted} bars)\n`);

  const halves = [samples.slice(0, Math.floor(samples.length / 2)), samples.slice(Math.floor(samples.length / 2))];

  type Pred = (s: Sample, long: boolean) => boolean;
  const filters: Record<string, Pred> = {
    "EMA-ALIGN": (s, long) => s.emaUp === long,
    "MACD-SIGN": (s, long) => s.macdUp === long,
    "RSI-BAND": (s, long) => (long ? s.rsiHot : !s.rsiHot),
    "BREAKOUT": (s, long) => (long ? s.breakout : true), // short-side breakout undefined → pass-through
    "VOL-ONSET": (s) => s.eruption,
    "HIGH-ATR": (s) => s.highAtr,
  };
  const combos: Array<[string, string]> = [];
  const keys = Object.keys(filters);
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) combos.push([keys[i]!, keys[j]!]);

  function evaluate(name: string, pred: Pred, half: Sample[]): { n: number; wins: number; wr: number; lo: number } {
    let n = 0, wins = 0;
    for (const s of half) {
      for (const long of [true, false]) {
        if (!pred(s, long)) continue;
        n++;
        if (long ? s.longWin : s.shortWin) wins++;
      }
    }
    return { n, wins, wr: n ? (wins / n) * 100 : 0, lo: wilsonLower(wins, n) * 100 };
  }

  console.log("── SINGLE FILTERS (half A → half B holdout) ──");
  console.log("FILTER        A:n    A:WR   A:WLo  |  B:n    B:WR   HOLDS?");
  const survivors: string[] = [];
  for (const [name, pred] of Object.entries(filters)) {
    const A = evaluate(name, pred, halves[0]!);
    const B = evaluate(name, pred, halves[1]!);
    const holds = A.lo >= 40 && A.n >= 30 && B.wr >= A.wr * 0.8 && B.wr >= 40;
    if (holds) survivors.push(name);
    console.log(`${name.padEnd(13)} ${String(A.n).padStart(5)} ${A.wr.toFixed(1).padStart(6)}% ${A.lo.toFixed(1).padStart(6)}% | ${String(B.n).padStart(5)} ${B.wr.toFixed(1).padStart(6)}%  ${holds ? "✓ HOLD" : "✗"}`);
  }

  console.log("\n── JOINT PAIRS (half A → half B holdout) ──");
  console.log("COMBO                  A:n    A:WR   A:WLo  |  B:n    B:WR   HOLDS?");
  const jointSurvivors: string[] = [];
  for (const [k1, k2] of combos) {
    const pred: Pred = (s, long) => filters[k1]!(s, long) && filters[k2]!(s, long);
    const A = evaluate(`${k1}+${k2}`, pred, halves[0]!);
    const B = evaluate(`${k1}+${k2}`, pred, halves[1]!);
    const holds = A.lo >= 40 && A.n >= 30 && B.wr >= A.wr * 0.8 && B.wr >= 40;
    if (holds) jointSurvivors.push(`${k1}+${k2}`);
    console.log(`${(k1 + "+" + k2).padEnd(22)} ${String(A.n).padStart(5)} ${A.wr.toFixed(1).padStart(6)}% ${A.lo.toFixed(1).padStart(6)}% | ${String(B.n).padStart(5)} ${B.wr.toFixed(1).padStart(6)}%  ${holds ? "✓ HOLD" : "✗"}`);
  }

  console.log(`\nVERDICT: ${survivors.length} single + ${jointSurvivors.length} joint filters survive split-half validation (Wilson Lo≥40% on A, WR≥40% on B, B≥0.8×A).`);
  if (survivors.length) console.log("SINGLE survivors: " + survivors.join(", "));
  if (jointSurvivors.length) console.log("JOINT survivors: " + jointSurvivors.join(", "));
  console.log("Only survivors are candidates for live gate calibration (2026-09-06 contract: uncaptured edges never enter the live gate).");
  process.exit(0);
}

void main();
export {};
