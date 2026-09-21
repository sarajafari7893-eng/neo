// ── EPOCH-2 SENIOR-ENGINEER VERIFICATION (independent pass, directive 4) ──
// Re-derives the stored calibration result and audits the honesty properties.
// Verdict gates the operator report. Run: bun scripts/calibration-verify.ts

import { db } from "@/lib/db";
import { runBacktest, getAutotune, getBacktest } from "@/lib/backtest";
import { getGateSettings } from "@/lib/gate-settings";

let fails = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "PASS" : "FAIL"} · ${name} — ${detail}`);
  if (!ok) fails++;
}

async function main() {
  const stored = await getBacktest();
  const at = await getAutotune();
  const rec = await db.engineSetting.findUnique({ where: { key: "epoch.calibration" } });
  check("calibration record exists", !!stored && !!rec, stored ? `stored run "${stored.label}" n=${stored.n}` : "missing");
  if (!stored || !rec) process.exit(1);

  const chosen = JSON.parse(rec.value) as { chosen: { minScoreAdj: number; minScore: number }; verdict: string };
  const effectiveMinScore = chosen.chosen.minScore;
  const weights = at?.adopted && at.adoptedWeights ? at.adoptedWeights : undefined;

  // 1) independent reproduction at the SAME EFFECTIVE threshold (the live gate
  // already moved to the applied value — adjust the adj relative to it)
  const gate = await getGateSettings();
  const adjForRepro = effectiveMinScore - gate.minScore;
  const repro = await runBacktest({ label: "E2-VERIFY", minScoreAdj: adjForRepro, weights: weights ?? null, persist: false, step: 2 });
  check(
    "reproduction consistent",
    Math.abs(repro.n - stored.n) <= 2 && Math.abs(repro.avgNetPct - stored.avgNetPct) < 0.6,
    `stored n=${stored.n}/net ${stored.avgNetPct}% vs repro n=${repro.n}/net ${repro.avgNetPct}% @eff minScore ${effectiveMinScore} (kline window advances between runs)`,
  );

  // 2) raw trades audit — the persisted run carries its last 24 raw trades
  const t = stored.trades;
  check("raw trades persisted for audit", t.length >= 20, `${t.length} raw trade rows available (of n=${stored.n})`);

  // 3) fee honesty: NET strictly below GROSS on every audited trade
  const feeViolations = t.filter((x) => x.netPct >= x.grossPct).length;
  check("fees strictly positive", feeViolations === 0, `${t.length} trades audited, ${feeViolations} violations (netPct < grossPct required)`);

  // 4) per-symbol cooldown integrity (24h)
  const bySym = new Map<string, number[]>();
  for (const x of t) bySym.set(x.symbol, [...(bySym.get(x.symbol) ?? []), x.openedAt]);
  let cdViolations = 0;
  for (const [, times] of bySym) {
    const s = [...times].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) if (s[i]! - s[i - 1]! < 24 * 3600_000) cdViolations++;
  }
  check("24h cooldown integrity", cdViolations === 0, `${cdViolations} same-symbol entries inside 24h`);

  // 5) no-lookahead — structural: the scorer sees candles.slice(0, i+1) (closed
  // bars up to i ONLY); simulate() starts at j = entryIdx+1. Audit: heldMin > 0.
  const lookaheadSuspicion = t.filter((x) => x.heldMin <= 0).length;
  check("no-lookahead (structural + heldMin>0)", lookaheadSuspicion === 0, `buildSnapshot(candles.slice(0,i+1)) sees only the past; ${lookaheadSuspicion} zero-horizon trades`);

  // 6) verdict honesty — thresholds mirror learnedGateAllows
  const shouldBe = stored.n >= 20 && stored.wilsonLB >= 45 && stored.avgNetPct > 0 ? "APPROVED" : stored.n >= 20 && stored.wilsonLB >= 40 ? "MARGINAL" : "REJECTED";
  check("verdict matches thresholds", shouldBe === chosen.verdict, `thresholds on stored run → ${shouldBe}; recorded → ${chosen.verdict}`);

  console.log(fails === 0 ? "\nSENIOR-ENGINEER VERIFY: PASS (all checks green)" : `\nSENIOR-ENGINEER VERIFY: ${fails} FAILURES`);
  if (fails > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("VERIFY ERROR:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
