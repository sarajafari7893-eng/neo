// PERF FORENSICS 2026-09-07 — operator: «چرا بازدهی منفی زیادی از ردیابی سیگنال‌ها دارد؟»
// Read-only forensics over settled Signal rows. Real data only — no simulation.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const usd = (s: { marginUsd: number; pnlPercent: number }) =>
  (s.marginUsd * s.pnlPercent) / 100;
const r2 = (x: number) => Math.round(x * 100) / 100;
const pct = (a: number, b: number) => (b ? r2((a / b) * 100) : 0);

async function main() {
  const all = await db.signal.findMany({
    where: { status: { notIn: ["ACTIVE", "TP1", "TP2"] } }, // settled-ish (closed/expired/sl/tp3)
  });
  const active = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } });

  const realized = all.reduce((a, s) => a + usd(s), 0);
  const fees = all.reduce((a, s) => a + s.feeUsd + s.swapUsd, 0);
  const wins = all.filter((s) => usd(s) > 0);
  const losses = all.filter((s) => usd(s) < 0);
  const grossWin = wins.reduce((a, s) => a + usd(s), 0);
  const grossLoss = Math.abs(losses.reduce((a, s) => a + usd(s), 0));

  console.log("═══ ALL-TIME SETTLED ═══");
  console.log(`settled=${all.length} (wins=${wins.length} losses=${losses.length} flat=${all.length - wins.length - losses.length}) winRate=${pct(wins.length, all.length)}%`);
  console.log(`realized=$${r2(realized)}  fees+swap=$${r2(fees)}  grossWin=$${r2(grossWin)}  grossLoss=$${r2(grossLoss)}  PF=${r2(grossWin / (grossLoss || 1))}`);
  console.log(`avgWin=$${r2(grossWin / (wins.length || 1))}  avgLoss=$${r2(grossLoss / (losses.length || 1))}  expectancy=$${r2(realized / (all.length || 1))}/trade`);
  const unrl = active.reduce((a, s) => a + usd(s), 0);
  console.log(`active=${active.length} unrealized=$${r2(unrl)}  EQUITY≈$${r2(100 + realized + unrl)}`);

  const statusAgg = (rows: typeof all) => {
    const m = new Map<string, { n: number; usd: number; mfe: number }>();
    for (const s of rows) {
      const k = s.status + (s.afterlife && s.afterlife !== "TRACKING" ? `/${s.afterlife}` : "");
      const v = m.get(k) ?? { n: 0, usd: 0, mfe: 0 };
      v.n++; v.usd += usd(s); v.mfe += s.maxPnlPercent;
      m.set(k, v);
    }
    for (const [k, v] of [...m.entries()].sort((a, b) => a[1].usd - b[1].usd))
      console.log(`  ${k.padEnd(22)} n=${String(v.n).padStart(3)}  usd=$${r2(v.usd).toString().padStart(9)}  avgMFE%=${r2(v.mfe / v.n)}`);
  };
  console.log("\n═══ BY EXIT STATUS (sorted by damage) ═══");
  statusAgg(all);

  console.log("\n═══ BY STRATEGY ═══");
  const byStrat = new Map<string, typeof all>();
  for (const s of all) byStrat.set(s.strategy, [...(byStrat.get(s.strategy) ?? []), s]);
  for (const [k, rows] of [...byStrat.entries()].sort((a, b) => a[1].reduce((x, s) => x + usd(s), 0) - b[1].reduce((x, s) => x + usd(s), 0))) {
    const w = rows.filter((s) => usd(s) > 0).length;
    console.log(`  ${k.padEnd(14)} n=${String(rows.length).padStart(3)} win=${pct(w, rows.length)}%  usd=$${r2(rows.reduce((a, s) => a + usd(s), 0)).toString().padStart(9)}  avg=$${r2(rows.reduce((a, s) => a + usd(s), 0) / rows.length)}`);
  }

  console.log("\n═══ BY DIRECTION ═══");
  for (const dir of ["LONG", "SHORT"]) {
    const rows = all.filter((s) => s.direction === dir);
    const w = rows.filter((s) => usd(s) > 0).length;
    console.log(`  ${dir.padEnd(6)} n=${String(rows.length).padStart(3)} win=${pct(w, rows.length)}%  usd=$${r2(rows.reduce((a, s) => a + usd(s), 0))}`);
  }

  console.log("\n═══ WORST SYMBOLS (sum usd, n≥3) ═══");
  const bySym = new Map<string, typeof all>();
  for (const s of all) bySym.set(s.symbol, [...(bySym.get(s.symbol) ?? []), s]);
  const symRows = [...bySym.entries()].filter(([, r]) => r.length >= 3).map(([k, rows]) => ({ k, n: rows.length, usd: rows.reduce((a, s) => a + usd(s), 0), w: rows.filter((s) => usd(s) > 0).length }));
  for (const { k, n, usd: u, w } of symRows.sort((a, b) => a.usd - b.usd).slice(0, 8))
    console.log(`  ${k.padEnd(14)} n=${String(n).padStart(3)} win=${pct(w, n)}%  usd=$${r2(u)}`);
  console.log("  ...best:");
  for (const { k, n, usd: u, w } of symRows.sort((a, b) => b.usd - a.usd).slice(0, 5))
    console.log(`  ${k.padEnd(14)} n=${String(n).padStart(3)} win=${pct(w, n)}%  usd=$${r2(u)}`);

  console.log("\n═══ SL FORENSICS — stop quality ═══");
  const sl = all.filter((s) => s.status === "SL");
  const mfePos = sl.filter((s) => s.maxPnlPercent > 5); // was ever >+5% levered before dying
  console.log(`SL n=${sl.length} usd=$${r2(sl.reduce((a, s) => a + usd(s), 0))}  ever-in-profit(>+5% lev) n=${mfePos.length} (${pct(mfePos.length, sl.length)}%)  their given-back MFE sum=${r2(mfePos.reduce((a, s) => a + s.maxPnlPercent, 0))}% lev`);
  const stopDist = sl.map((s) => (Math.abs(s.entryPrice - s.stopLoss) / s.entryPrice) * 100 * s.leverage);
  console.log(`levered stop distance %: avg=${r2(stopDist.reduce((a, b) => a + b, 0) / (stopDist.length || 1))} min=${r2(Math.min(...stopDist))} max=${r2(Math.max(...stopDist))}`);
  const tight = stopDist.filter((d) => d < 3).length;
  console.log(`stops tighter than 3% levered: ${tight}/${stopDist.length}`);

  console.log("\n═══ CONFIDENCE CALIBRATION ═══");
  for (const lo of [50, 60, 70, 80, 90]) {
    const rows = all.filter((s) => s.confidence >= lo && s.confidence < lo + 10);
    if (!rows.length) continue;
    const w = rows.filter((s) => usd(s) > 0).length;
    console.log(`  conf ${lo}-${lo + 9}: n=${String(rows.length).padStart(3)} win=${pct(w, rows.length)}%  usd=$${r2(rows.reduce((a, s) => a + usd(s), 0)).toString().padStart(9)}  avg=$${r2(rows.reduce((a, s) => a + usd(s), 0) / rows.length)}`);
  }

  console.log("\n═══ EXPIRED AFTERLIFE (missed wins?) ═══");
  const exp = all.filter((s) => s.status === "EXPIRED");
  const al = new Map<string, { n: number; post: number }>();
  for (const s of exp) {
    const k = s.afterlife ?? "TRACKING";
    const v = al.get(k) ?? { n: 0, post: 0 };
    v.n++; v.post += s.maxPostPnlPercent;
    al.set(k, v);
  }
  for (const [k, v] of [...al.entries()].sort((a, b) => b[1].n - a[1].n))
    console.log(`  ${k.padEnd(10)} n=${String(v.n).padStart(3)}  avgPostExpiryMFE%lev=${r2(v.post / v.n)}`);

  console.log("\n═══ TTL EXTENSIONS ═══");
  for (const e of [0, 1, 2, 3]) {
    const rows = all.filter((s) => s.ttlExtensions === e);
    if (!rows.length) continue;
    const w = rows.filter((s) => usd(s) > 0).length;
    console.log(`  ext=${e}: n=${String(rows.length).padStart(3)} win=${pct(w, rows.length)}%  usd=$${r2(rows.reduce((a, s) => a + usd(s), 0))}`);
  }

  console.log("\n═══ FEE DRAG ═══");
  console.log(`fees+swap=$${r2(fees)} vs realized=$${r2(realized)} → fees are ${r2((fees / (grossLoss || 1)) * 100)}% of gross loss; per-trade avg=$${r2(fees / (all.length || 1))}`);
  const vol = all.reduce((a, s) => a + s.marginUsd * s.leverage, 0);
  console.log(`notional turnover=$${r2(vol)} → fee rate=${r2((fees / (vol || 1)) * 10000)} bps of notional`);

  console.log("\n═══ DAILY REALIZED (last 8 Tehran days) ═══");
  const byDay = new Map<string, number>();
  for (const s of all) {
    const k = new Date(s.closedAt ?? s.createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Tehran" });
    byDay.set(k, (byDay.get(k) ?? 0) + usd(s));
  }
  for (const [k, v] of [...byDay.entries()].sort().slice(-8))
    console.log(`  ${k}  $${r2(v).toString().padStart(9)}  ${"█".repeat(Math.min(40, Math.abs(Math.round(v))))}`);

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
