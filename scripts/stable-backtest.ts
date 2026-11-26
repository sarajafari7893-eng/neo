// ── NEXUS//SIGNALS — STABLEFLOW BACKTEST (v11.0, operator mandate 2026-09-30)
// «تمام فازها را کامل و مهندسی اجرا کن» — PHASE 1 evidence step.
//
// QUESTION: does the stablecoin supply regime (7d Δ, DefiLlama ~9y daily)
// separate forward BTC returns enough to justify the STABLE-REGIME filter?
//
// METHOD (honest by construction):
//   • regime per UTC day: 7d total-stable Δ ≥ +0.5% → RISK-ON · ≤ −0.5% →
//     RISK-OFF · else NEUTRAL (same thresholds as src/lib/stableflow.ts)
//   • forward 7d BTC return from Bybit SPOT daily klines (limit=1000 ≈ 2.7y)
//   • TWO samples reported: OVERLAPPING (every day — 7× more points, but
//     autocorrelated) and NON-OVERLAPPING (every 7th day — honest inference)
//   • LEDGER JOIN: our own settled Signal rows bucketed by regime at deploy
//     (small-n — descriptive only, never inferential)
// Output: logs/stable-backtest-report.json + stdout table.
// The gate stays SHADOW regardless of results — enforcement is an operator
// decision after the live shadow arms corroborate (doctrine, not vibes).
import { Database } from "bun:sqlite";
import { writeFileSync, readFileSync } from "node:fs";

const ROOT = "/home/z/my-project";
const REGIME_ON = 0.5;
const REGIME_OFF = -0.5;
const FWD_DAYS = 7;

interface Pt { d: number; u: number } // day-ms, usd

function loadBackfill(key: string): Pt[] {
  const raw = JSON.parse(readFileSync(`${ROOT}/.data/stable-feed/backfill/${key}.json`, "utf8")) as { points: [number, number][] };
  return raw.points.map(([d, u]) => ({ d, u }));
}
function regimeOf(delta7dPct: number | null): "RISK-ON" | "NEUTRAL" | "RISK-OFF" | null {
  if (delta7dPct === null) return null;
  if (delta7dPct >= REGIME_ON) return "RISK-ON";
  if (delta7dPct <= REGIME_OFF) return "RISK-OFF";
  return "NEUTRAL";
}
// Δ7d% at day t = (supply[t] − supply[t−7d]) / supply[t−7d]
function delta7dAt(series: Pt[], tMs: number): number | null {
  // series is daily-sorted; find index nearest tMs
  let lo = 0, hi = series.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid]!.d === tMs) { idx = mid; break; }
    if (series[mid]!.d < tMs) lo = mid + 1; else hi = mid - 1;
  }
  if (idx < 0) idx = hi; // nearest earlier day
  if (idx < 0 || idx >= series.length) return null;
  const now = series[idx]!;
  const pastIdx = idx - 7 >= 0 ? idx - 7 : -1; // daily grid → 7 rows back
  if (pastIdx < 0) return null;
  const past = series[pastIdx]!;
  if (past.u <= 0) return null;
  return ((now.u - past.u) / past.u) * 100;
}

async function bybitDaily(): Promise<Map<string, number>> {
  const r = await fetch("https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=1000", { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const list = j?.result?.list ?? [];
  const map = new Map<string, number>(); // "YYYY-MM-DD" → close
  for (const row of list as string[][]) {
    const close = Number(row[4]);
    if (!Number.isFinite(close)) continue;
    const day = new Date(Number(row[0])).toISOString().slice(0, 10);
    // klines include the current partial candle — fine, it IS today's close-so-far
    if (!map.has(day)) map.set(day, close);
  }
  return map;
}

interface Bucket { n: number; mean: number; median: number; winRate: number | null; meanAbs: number }

function bucketize(samples: Array<{ regime: string; fwd: number }>): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  for (const rg of ["RISK-ON", "NEUTRAL", "RISK-OFF"]) {
    const xs = samples.filter((s) => s.regime === rg).map((s) => s.fwd);
    if (xs.length === 0) continue;
    const sorted = [...xs].sort((a, b) => a - b);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const wins = xs.filter((x) => x > 0).length;
    const meanAbs = xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
    out[rg] = { n: xs.length, mean, median, winRate: (wins / xs.length) * 100, meanAbs };
  }
  return out;
}

const fmt = (b: Bucket | undefined) =>
  !b ? "  —".padEnd(46) : `n=${String(b.n).padStart(4)} · mean ${b.mean >= 0 ? "+" : ""}${b.mean.toFixed(2)}% · med ${b.median >= 0 ? "+" : ""}${b.median.toFixed(2)}% · WR ${b.winRate!.toFixed(0)}%`;

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  STABLEFLOW BACKTEST — stable Δ7d regime vs forward BTC 7d   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  const stables = loadBackfill("TOTAL");
  const btc = await bybitDaily();
  console.log(`stable series: ${stables.length} daily points (${new Date(stables[0]!.d).toISOString().slice(0, 10)} → ${new Date(stables[stables.length - 1]!.d).toISOString().slice(0, 10)})`);
  console.log(`BTC spot klines: ${btc.size} days (Bybit, 1000-bar cap)`);

  // overlapping sample — every day with regime + full forward window
  const overlap: Array<{ regime: string; fwd: number }> = [];
  const nonOverlap: Array<{ regime: string; fwd: number }> = [];
  const dayKeys = [...btc.keys()].sort();
  const dayMs = (k: string) => Date.parse(k + "T00:00:00Z");
  let step = 0;
  for (const k of dayKeys) {
    const t = dayMs(k);
    const rg = regimeOf(delta7dAt(stables, t));
    if (!rg) continue;
    const fwdKey = dayKeys.find((x) => dayMs(x) >= t + FWD_DAYS * 86400_000);
    if (!fwdKey) continue;
    const fwd = ((btc.get(fwdKey)! - btc.get(k)!) / btc.get(k)!) * 100;
    overlap.push({ regime: rg, fwd });
    if (step % FWD_DAYS === 0) nonOverlap.push({ regime: rg, fwd });
    step += 1;
  }

  const repOv = bucketize(overlap);
  const repNo = bucketize(nonOverlap);

  console.log("\n── OVERLAPPING sample (every day; autocorrelated — descriptive) ──");
  for (const rg of ["RISK-ON", "NEUTRAL", "RISK-OFF"]) console.log(`  ${rg.padEnd(10)} ${fmt(repOv[rg])}`);
  console.log(`\n── NON-OVERLAPPING sample (every ${FWD_DAYS}th day; honest inference) ──`);
  for (const rg of ["RISK-ON", "NEUTRAL", "RISK-OFF"]) console.log(`  ${rg.padEnd(10)} ${fmt(repNo[rg])}`);

  // ledger join — our own settled signals by regime at deploy
  let ledgerLine = "ledger join: n/a";
  try {
    const db = new Database(`${ROOT}/db/custom.db`, { readonly: true });
    db.exec("PRAGMA busy_timeout=2500");
    const rows = db
      .query("SELECT createdAt, pnlPercent, direction FROM Signal WHERE qualityFlag IS NULL AND closedAt IS NOT NULL AND pnlPercent IS NOT NULL")
      .all() as Array<{ createdAt: string; pnlPercent: number; direction: string }>;
    db.close();
    const led: Array<{ regime: string; pnl: number; dir: string }> = [];
    for (const r of rows) {
      const t = new Date(r.createdAt).getTime();
      const rg = regimeOf(delta7dAt(stables, t));
      if (rg) led.push({ regime: rg, pnl: r.pnlPercent, dir: r.direction });
    }
    const lines: string[] = [];
    for (const rg of ["RISK-ON", "NEUTRAL", "RISK-OFF"]) {
      const xs = led.filter((l) => l.regime === rg);
      if (xs.length === 0) continue;
      const mean = xs.reduce((a, b) => a + b.pnl, 0) / xs.length;
      const wr = (xs.filter((x) => x.pnl > 0).length / xs.length) * 100;
      lines.push(`${rg}: n=${xs.length} mean ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}% WR ${wr.toFixed(0)}%`);
    }
    ledgerLine = lines.length ? lines.join(" · ") : "ledger join: no settled rows inside regime coverage";
  } catch (e) {
    ledgerLine = `ledger join error: ${String(e).slice(0, 80)}`;
  }
  console.log(`\n── OUR OWN LEDGER (settled signals by regime at deploy; small-n descriptive) ──\n  ${ledgerLine}`);
  console.log("\nDOCTRINE: the STABLE-REGIME gate stays SHADOW — this backtest is evidence for the");
  console.log("operator, enforcement is a separate decision after live shadow-arm corroboration.");

  writeFileSync(
    `${ROOT}/logs/stable-backtest-report.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), method: "stable Δ7d regime vs forward 7d BTC (Bybit spot)", overlapping: repOv, nonOverlapping: repNo, ledger: ledgerLine }, null, 2),
  );
  console.log("\nreport → logs/stable-backtest-report.json");
}
main().catch((e) => { console.error("backtest failed:", e); process.exit(1); });
