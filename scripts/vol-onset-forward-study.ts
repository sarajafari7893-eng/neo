/**
 * VOL-ONSET FORWARD-RETURN STUDY (research desk, 2026-09-07).
 * The detector's evidence base was n=3 hand samples ("fwd-6h drift +10.7% avg").
 * This study replaces that with a systematic replay over weeks of 15m tape:
 *
 * Method (honest, replay-based, same conventions as filter-calibration-audit):
 *  - Universe: top-N USDT perp futures by quote volume (default 24).
 *  - Per symbol: 1500 × 15m bars (~15.6 days).
 *  - Eruption event: |close-to-close ret| ≥ 5× trailing-96-bar median |ret|,
 *    with a 16-bar (4h) cooldown since the previous eruption (distinct events).
 *  - Forward outcome, signed IN ERUPTION DIRECTION:
 *      fwd6h  = 24-bar drift,  fwd12h = 48-bar drift,
 *      adverse = max move AGAINST the direction within the 24 bars after.
 *  - Win = fwd6h > +0.3% (same bar as the joint-filter audit).
 *  - Baseline: "moderate" bars (2× ≤ |ret| < 5× median) — does a 5× eruption
 *    actually carry MORE forward drift than an ordinary push?
 *  - Split-half stability (events ordered by time) + Wilson 95% lower bound.
 *
 * Artifacts: prints the table, writes docs/vol-onset-forward-study-<ts>.md and
 * persists the verdict to EngineSetting key "vol-onset-study" (radar-citable).
 *
 * Run: bun scripts/vol-onset-forward-study.ts [topN=24] [bars=1500]
 */
import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";

const FAPI = "https://fapi.binance.com";
const TRAIL = 96; // 24h of 15m bars
const MULT = 5; // eruption threshold × trailing median
const COOLDOWN = 16; // 4h between distinct events
const FWD6 = 24; // 6h of 15m bars
const FWD12 = 48;
const MIN_WIN_PCT = 0.3;
const MIN_BARS = 600; // symbol needs ≥ ~6 days of tape to count

const db = new PrismaClient();

interface Candle { openTime: number; open: number; high: number; low: number; close: number; volume: number }
interface Event {
  symbol: string; at: number; dir: 1 | -1; dispX: number;
  fwd6: number; fwd12: number; adverse: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function wilsonLB(wins: number, n: number): number {
  if (n === 0) return 0;
  const p = wins / n, z = 1.96;
  return ((p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n)) * 100;
}
const pct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

async function topSymbols(n: number): Promise<string[]> {
  const r = await fetch(`${FAPI}/fapi/v1/ticker/24hr`);
  if (!r.ok) throw new Error(`ticker ${r.status}`);
  const rows = (await r.json()) as Array<{ symbol: string; quoteVolume: string }>;
  return rows
    .filter((x) => x.symbol.endsWith("USDT"))
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, n)
    .map((x) => x.symbol);
}

async function klines(symbol: string, limit: number): Promise<Candle[]> {
  const r = await fetch(`${FAPI}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=${limit}`);
  if (!r.ok) throw new Error(`klines ${symbol} ${r.status}`);
  const raw = (await r.json()) as unknown[][];
  return raw.map((k) => ({
    openTime: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]),
    close: Number(k[4]), volume: Number(k[5]),
  }));
}

function studySymbol(symbol: string, bars: Candle[], events: Event[], baselineFwd: number[]): { eruptions: number; moderates: number } {
  let lastErupt = -Infinity;
  let eruptions = 0, moderates = 0;
  for (let i = TRAIL; i < bars.length - FWD12; i++) {
    const win = bars.slice(i - TRAIL, i);
    const rets = win.map((b, j) => (j === 0 ? 0 : Math.abs((b.close - win[j - 1]!.close) / win[j - 1]!.close) * 100)).slice(1);
    const med = median(rets);
    if (!(med > 0)) continue;
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    const ret = ((cur.close - prev.close) / prev.close) * 100;
    const x = Math.abs(ret) / med;
    const close = cur.close;
    const fwd6 = ((bars[i + FWD6]!.close - close) / close) * 100 * (ret >= 0 ? 1 : -1);
    const fwd12 = ((bars[i + FWD12]!.close - close) / close) * 100 * (ret >= 0 ? 1 : -1);
    if (x >= MULT) {
      if (i - lastErupt < COOLDOWN) continue; // collapse clustered bars into one event
      lastErupt = i;
      let adverse = 0;
      for (let j = i + 1; j <= i + FWD6; j++) {
        const against = ret >= 0
          ? ((bars[j]!.low - close) / close) * 100 // down-move vs UP direction
          : ((bars[j]!.high - close) / close) * 100; // up-move vs DOWN direction → positive = adverse
        adverse = Math.max(adverse, ret >= 0 ? -against : against);
      }
      events.push({ symbol, at: cur.openTime, dir: ret >= 0 ? 1 : -1, dispX: x, fwd6, fwd12, adverse });
      eruptions++;
    } else if (x >= 2) {
      baselineFwd.push(fwd6);
      moderates++;
    }
  }
  return { eruptions, moderates };
}

function groupStats(evs: Event[]) {
  const n = evs.length;
  const wins = evs.filter((e) => e.fwd6 > MIN_WIN_PCT).length;
  return {
    n, wins,
    wr: n ? Number(((wins / n) * 100).toFixed(1)) : null,
    wilsonLB: Number(wilsonLB(wins, n).toFixed(1)),
    medFwd6: n ? Number(median(evs.map((e) => e.fwd6)).toFixed(2)) : null,
    meanFwd6: n ? Number(mean(evs.map((e) => e.fwd6)).toFixed(2)) : null,
    medFwd12: n ? Number(median(evs.map((e) => e.fwd12)).toFixed(2)) : null,
    medAdverse: n ? Number(median(evs.map((e) => e.adverse)).toFixed(2)) : null,
  };
}

async function main() {
  const topN = Number(process.argv[2] ?? 24);
  const barsWanted = Number(process.argv[3] ?? 1500);
  console.log(`VOL-ONSET FORWARD STUDY — top ${topN} symbols × ${barsWanted}×15m bars (~${((barsWanted * 15) / 60 / 24).toFixed(1)}d), eruption ≥${MULT}× trailing-${TRAIL} median, cooldown ${COOLDOWN} bars`);

  const symbols = await topSymbols(topN);
  const events: Event[] = [];
  const baselineFwd: number[] = [];
  let symbolsStudied = 0, symbolsSkipped = 0;

  for (const sym of symbols) {
    try {
      const bars = await klines(sym, barsWanted);
      if (bars.length < MIN_BARS) { symbolsSkipped++; continue; }
      const r = studySymbol(sym, bars, events, baselineFwd);
      symbolsStudied++;
      process.stdout.write(`  ${sym}: ${r.eruptions} eruptions, ${r.moderates} moderate bars\n`);
      await new Promise((res) => setTimeout(res, 120)); // gentle on FAPI
    } catch (e) {
      symbolsSkipped++;
      process.stdout.write(`  ${sym}: SKIPPED (${e instanceof Error ? e.message : "err"})\n`);
    }
  }

  events.sort((a, b) => a.at - b.at);
  const all = groupStats(events);
  const up = groupStats(events.filter((e) => e.dir === 1));
  const down = groupStats(events.filter((e) => e.dir === -1));
  const hot = groupStats(events.filter((e) => e.dispX >= MULT * 2)); // violent subset
  const half = Math.floor(events.length / 2);
  const a = groupStats(events.slice(0, half));
  const b = groupStats(events.slice(half));
  const base = { n: baselineFwd.length, medFwd6: Number(median(baselineFwd).toFixed(2)), meanFwd6: Number(mean(baselineFwd).toFixed(2)), wrPos: Number(((baselineFwd.filter((x) => x > MIN_WIN_PCT).length / Math.max(1, baselineFwd.length)) * 100).toFixed(1)) };

  const verdictAdmitted = all.n >= 30 && all.wilsonLB > 40 && all.meanFwd6! > 0.1;
  const verdict = verdictAdmitted
    ? `ADMITTED-CANDIDATE: n=${all.n}, WR ${all.wr}% (Wilson-LB ${all.wilsonLB}%), mean fwd6h ${pct(all.meanFwd6!)} — edge holds at the audit bar; radar stays live, tag-settle loop continues.`
    : all.n >= 30
      ? `NOT ADMITTED: n=${all.n}, WR ${all.wr}% (Wilson-LB ${all.wilsonLB}% ${all.wilsonLB > 40 ? "✓" : "✗ < 40"}), mean fwd6h ${pct(all.meanFwd6!)} — eruption follow-through is NOT yet separable from noise; radar stays TELEMETRY-ONLY (correct per contract).`
      : `LOW SAMPLE: n=${all.n} < 30 events in window — inconclusive; continue accumulating.`;

  const lines = [
    `# VOL-ONSET Forward-Return Study — ${new Date().toISOString().slice(0, 16)}Z`,
    ``,
    `Universe: top ${topN} USDT perps by volume · ${symbolsStudied} studied, ${symbolsSkipped} skipped · ${barsWanted}×15m bars each (~${((barsWanted * 15) / 60 / 24).toFixed(1)}d).`,
    `Eruption = |15m ret| ≥ ${MULT}× trailing-${TRAIL}-bar median |ret|, 4h cooldown. Win = fwd6h > +${MIN_WIN_PCT}% in eruption direction.`,
    ``,
    `## All events`,
    `n=${all.n} · WR ${all.wr}% · Wilson-LB ${all.wilsonLB}% · median fwd6h ${all.medFwd6}% · mean fwd6h ${all.meanFwd6}% · median fwd12h ${all.medFwd12}% · median max-adverse (6h) ${all.medAdverse}%`,
    ``,
    `## Direction split`,
    `UP: n=${up.n} · WR ${up.wr}% · mean fwd6h ${up.meanFwd6}% · med fwd12h ${up.medFwd12}%`,
    `DOWN: n=${down.n} · WR ${down.wr}% · mean fwd6h ${down.meanFwd6}% · med fwd12h ${down.medFwd12}%`,
    ``,
    `## Violent subset (≥ ${MULT * 2}× median displacement)`,
    `n=${hot.n} · WR ${hot.wr}% · mean fwd6h ${hot.meanFwd6}% · med fwd12h ${hot.medFwd12}%`,
    ``,
    `## Split-half stability (chronological)`,
    `Half A: n=${a.n} · WR ${a.wr}% · mean fwd6h ${a.meanFwd6}%  |  Half B: n=${b.n} · WR ${b.wr}% · mean fwd6h ${b.meanFwd6}%`,
    ``,
    `## Baseline — moderate bars (2× ≤ |ret| < ${MULT}× median)`,
    `n=${base.n} · WR ${base.wrPos}% · mean fwd6h ${base.meanFwd6}% · median fwd6h ${base.medFwd6}% → eruption uplift vs moderate: ${all.meanFwd6 !== null ? pct(all.meanFwd6 - base.meanFwd6) : "n/a"} mean fwd6h`,
    ``,
    `## VERDICT`,
    verdict,
  ];
  const doc = lines.join("\n");
  console.log("\n" + doc);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  writeFileSync(`docs/vol-onset-forward-study-${stamp}.md`, doc + "\n");

  await db.engineSetting.upsert({
    where: { key: "vol-onset-study" },
    create: { key: "vol-onset-study", value: JSON.stringify({ at: new Date().toISOString(), all, up, down, hot, a, b, base, verdict }) },
    update: { value: JSON.stringify({ at: new Date().toISOString(), all, up, down, hot, a, b, base, verdict }) },
  });
  console.log(`\nSTUDY OK — persisted to EngineSetting "vol-onset-study" + docs/vol-onset-forward-study-${stamp}.md`);
}

main()
  .catch((e) => { console.error("STUDY FAILED:", e); process.exitCode = 1; })
  .finally(() => db.$disconnect());

export {};
