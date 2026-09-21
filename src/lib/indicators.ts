// ── FlowRadar Neo quant library (pure, client-safe) ──
// EMA / RSI / MACD / ATR / Bollinger / swing levels + 6-factor confluence scorer.

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FactorVote {
  factor: string;
  vote: number; // signed contribution
  detail: string;
}

export interface IndicatorSnapshot {
  symbol: string;
  price: number;
  emaFast: number;
  emaSlow: number;
  emaSpreadPct: number;
  rsi: number;
  rsiPrev: number;
  macdHist: number;
  macdHistPrev: number;
  atrPct: number;
  percentB: number;
  rangeHigh: number; // 20-bar swing high
  rangeLow: number; // 20-bar swing low
  rangePos: number; // 0..1 position inside 20-bar range
  volRatio: number; // last COMPLETED candle volume vs SMA20 of volumes
  trendPct: number; // ema spread normalized by ATR
}

export interface Confluence {
  score: number; // -100..+100 (positive = long bias)
  direction: "LONG" | "SHORT";
  strategy: string;
  confidence: number; // 55..96
  votes: FactorVote[];
  rawScore: number;
  calibrated: boolean;
}

// ── primitives ────────────────────────────────────────────────
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/** Wilder RSI */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export function macdHist(closes: number[]): { hist: number; prev: number } {
  if (closes.length < 35) return { hist: 0, prev: 0 };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = e12.map((v, i) => v - e26[i]!);
  const signal = ema(line, 9);
  return { hist: line[line.length - 1]! - signal[signal.length - 1]!, prev: line[line.length - 2]! - signal[signal.length - 2]! };
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  let a = 0;
  let n = 0;
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    a += tr;
    n++;
  }
  return n === 0 ? 0 : a / n;
}

export function bollingerPercentB(closes: number[], period = 20, mult = 2): number {
  if (closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  if (upper === lower) return 0.5;
  return (closes[closes.length - 1]! - lower) / (upper - lower);
}

// ── snapshot from candles ─────────────────────────────────────
export function buildSnapshot(symbol: string, candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 40) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1]!;
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const emaFast = e9[e9.length - 1]!;
  const emaSlow = e21[e21.length - 1]!;
  const spreadPct = ((emaFast - emaSlow) / emaSlow) * 100;
  const r = rsi(closes);
  const rPrev = rsi(closes.slice(0, -1));
  const m = macdHist(closes);
  const a = atr(candles);
  const atrPct = (a / price) * 100;
  const percentB = bollingerPercentB(closes);
  const window = candles.slice(-21, -1); // exclude in-progress candle
  const rangeHigh = Math.max(...window.map((c) => c.high));
  const rangeLow = Math.min(...window.map((c) => c.low));
  const rangePos = rangeHigh === rangeLow ? 0.5 : (price - rangeLow) / (rangeHigh - rangeLow);
  // volume ratio: last COMPLETED candle vs SMA20 volume (partial-candle bias suppressed)
  const completed = candles.slice(-21, -1);
  const lastCompleted = completed[completed.length - 1]!;
  const volSma = completed.reduce((s, c) => s + c.volume, 0) / completed.length;
  const volRatio = volSma === 0 ? 1 : lastCompleted.volume / volSma;
  return {
    symbol,
    price,
    emaFast,
    emaSlow,
    emaSpreadPct: spreadPct,
    rsi: r,
    rsiPrev: rPrev,
    macdHist: m.hist,
    macdHistPrev: m.prev,
    atrPct,
    percentB,
    rangeHigh,
    rangeLow,
    rangePos,
    volRatio,
    trendPct: a === 0 ? 0 : ((emaFast - emaSlow) / a) * 100,
  };
}

// ── confluence scorer (v4.8: optional calibrated weights) ─────
export type FactorWeights = Record<string, number>; // factor name → 0.75..1.25

const BASE_WEIGHTS: Record<string, number> = {
  "EMA STACK": 25,
  "MACD MOMENTUM": 15,
  "RSI POSITION": 15,
  "RANGE BREAKOUT": 20,
  "BOLLINGER EXTREME": 8,
  "VOLUME CONFIRM": 8,
};

export function scoreConfluence(snap: IndicatorSnapshot, weights?: FactorWeights): Confluence {
  const votes: FactorVote[] = [];
  const w = (f: string) => {
    const base = BASE_WEIGHTS[f] ?? 1;
    const cal = weights?.[f];
    return base * (typeof cal === "number" ? Math.min(1.25, Math.max(0.75, cal)) : 1);
  };
  const cal = !!weights && Object.keys(BASE_WEIGHTS).some((f) => typeof weights[f] === "number");

  // 1. EMA stack (trend)
  const trendVote = snap.emaSpreadPct > 0 ? 1 : -1;
  const trendMag = Math.min(1, Math.abs(snap.trendPct) / 1.2);
  votes.push({
    factor: "EMA STACK",
    vote: Number((trendVote * w("EMA STACK") * (0.4 + 0.6 * trendMag)).toFixed(2)),
    detail: `EMA9 ${snap.emaSpreadPct >= 0 ? "+" : ""}${snap.emaSpreadPct.toFixed(3)}% vs EMA21 · trend ${snap.trendPct.toFixed(2)}×ATR`,
  });

  // 2. MACD momentum
  const expanding = Math.abs(snap.macdHist) > Math.abs(snap.macdHistPrev);
  const macdVote = snap.macdHist > 0 ? 1 : -1;
  votes.push({
    factor: "MACD MOMENTUM",
    vote: Number((macdVote * w("MACD MOMENTUM") * (expanding ? 1 : 0.5)).toFixed(2)),
    detail: `hist ${snap.macdHist.toFixed(snap.price > 100 ? 2 : 4)} ${expanding ? "expanding" : "fading"}`,
  });

  // 3. RSI position (trend-follow + mean-revert hybrid)
  if (snap.rsi >= 70) votes.push({ factor: "RSI POSITION", vote: Number((-0.6 * w("RSI POSITION")).toFixed(2)), detail: `RSI ${snap.rsi.toFixed(1)} overbought — mean-revert pressure` });
  else if (snap.rsi <= 30) votes.push({ factor: "RSI POSITION", vote: Number((0.6 * w("RSI POSITION")).toFixed(2)), detail: `RSI ${snap.rsi.toFixed(1)} oversold — mean-revert pressure` });
  else if (snap.rsi > 55 && snap.rsiPrev <= 55) votes.push({ factor: "RSI POSITION", vote: Number((0.7 * w("RSI POSITION")).toFixed(2)), detail: `RSI ${snap.rsiPrev.toFixed(1)}→${snap.rsi.toFixed(1)} crossed above midline` });
  else if (snap.rsi < 45 && snap.rsiPrev >= 45) votes.push({ factor: "RSI POSITION", vote: Number((-0.7 * w("RSI POSITION")).toFixed(2)), detail: `RSI ${snap.rsiPrev.toFixed(1)}→${snap.rsi.toFixed(1)} crossed below midline` });
  else votes.push({ factor: "RSI POSITION", vote: Number(((snap.rsi - 50) / 50 * 0.5 * w("RSI POSITION")).toFixed(2)), detail: `RSI ${snap.rsi.toFixed(1)} neutral-drift · slope ${(snap.rsi - snap.rsiPrev).toFixed(1)}` });

  // 4. Range breakout (20-bar)
  if (snap.rangePos >= 0.98) votes.push({ factor: "RANGE BREAKOUT", vote: Number((w("RANGE BREAKOUT")).toFixed(2)), detail: `at 20-bar high ${snap.rangeHigh.toFixed(snap.price > 100 ? 1 : 4)} — breakout side` });
  else if (snap.rangePos <= 0.02) votes.push({ factor: "RANGE BREAKOUT", vote: Number((-w("RANGE BREAKOUT")).toFixed(2)), detail: `at 20-bar low ${snap.rangeLow.toFixed(snap.price > 100 ? 1 : 4)} — breakdown side` });
  else if (snap.rangePos > 0.72) votes.push({ factor: "RANGE BREAKOUT", vote: Number((0.55 * w("RANGE BREAKOUT")).toFixed(2)), detail: `upper quartile of 20-bar range (${(snap.rangePos * 100).toFixed(0)}%)` });
  else if (snap.rangePos < 0.28) votes.push({ factor: "RANGE BREAKOUT", vote: Number((-0.55 * w("RANGE BREAKOUT")).toFixed(2)), detail: `lower quartile of 20-bar range (${(snap.rangePos * 100).toFixed(0)}%)` });
  else votes.push({ factor: "RANGE BREAKOUT", vote: 0, detail: `mid-range (${(snap.rangePos * 100).toFixed(0)}%) — no edge` });

  // 5. Bollinger extreme
  if (snap.percentB >= 1) votes.push({ factor: "BOLLINGER EXTREME", vote: Number((-0.5 * w("BOLLINGER EXTREME")).toFixed(2)), detail: `%B ${snap.percentB.toFixed(2)} above upper band — stretched` });
  else if (snap.percentB <= 0) votes.push({ factor: "BOLLINGER EXTREME", vote: Number((0.5 * w("BOLLINGER EXTREME")).toFixed(2)), detail: `%B ${snap.percentB.toFixed(2)} below lower band — stretched` });
  else votes.push({ factor: "BOLLINGER EXTREME", vote: 0, detail: `%B ${snap.percentB.toFixed(2)} inside bands` });

  // 6. Volume confirm
  if (snap.volRatio > 1.4) {
    const dir = snap.emaSpreadPct >= 0 ? 1 : -1;
    votes.push({ factor: "VOLUME CONFIRM", vote: Number((dir * w("VOLUME CONFIRM")).toFixed(2)), detail: `volume ${snap.volRatio.toFixed(2)}× SMA20 — participation confirms ${dir > 0 ? "buyers" : "sellers"}` });
  } else votes.push({ factor: "VOLUME CONFIRM", vote: 0, detail: `volume ${snap.volRatio.toFixed(2)}× SMA20 — unremarkable` });

  const rawScore = Math.max(-100, Math.min(100, votes.reduce((a, v) => a + v.vote, 0)));
  const score = Math.round(rawScore);
  const direction = score >= 0 ? "LONG" : "SHORT";

  // strategy classification from factor fingerprint
  let strategy = "AI-SWING";
  const trendDom = Math.abs(votes[0]!.vote) >= 12;
  const breakout = Math.abs(votes[3]!.vote) >= 10;
  const volSpike = snap.volRatio > 1.4;
  if (breakout && volSpike) strategy = "BREAKOUT";
  else if (Math.abs(snap.percentB - 0.5) > 0.42 && Math.abs(snap.rsi - 50) < 12) strategy = "MEAN-REVERT";
  else if (trendDom && snap.atrPct > 0.55 && Math.abs(snap.trendPct) > 0.9) strategy = "AI-SWING";
  else if (Math.abs(rawScore) >= 30 && volSpike) strategy = "MOMENTUM";
  else if (Math.abs(rawScore) >= 18 && snap.atrPct < 0.55) strategy = "AI-SCALP";

  const volBonus = snap.volRatio > 1.4 ? 4 : 0;
  const confidence = Math.round(Math.min(96, Math.max(55, 55 + 0.42 * Math.abs(score) + volBonus)));

  return { score, direction, strategy, confidence, votes, rawScore, calibrated: cal };
}

export function formatPrice(p: number): string {
  return p >= 1000 ? p.toFixed(1) : p >= 1 ? p.toFixed(4) : p.toFixed(6);
}
