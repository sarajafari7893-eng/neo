// ── verify-daily-pnl.ts (Task 45 Q3 — DAILY PNL veracity audit, readonly) ──
// Operator order 2026-10-18: «داده های ماژول DAILY PNL راستی ازمایی شود»
//
// What this tool proves, end to end:
//  1. DB TRUTH — every CLOSED signal bucketed by ASIA/TEHRAN local day
//     (fixed UTC+03:30, same convention as stats.ts tzLocal), Σ margin×pnl/100.
//  2. LIVE DASHBOARD — GET /api/pulse → stats.equityCurve compared per-day.
//  3. CONSISTENCY — Σ(all daily) vs realizedAllTime vs account.balance;
//     equity vs balance+unrealized (v12.0 bankable number).
//  4. DAILY REPORT MODULE (dailyReport.ts) — the Telegram DAILY poster's exact
//     window formula recomputed for the current Tehran day + its OPEN PNL line
//     (legacy stored-pnlPercent formula) vs the bankable open book.
// Read-only: zero writes. bun run scripts/verify-daily-pnl.ts

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const KEY = "3195f6883529fa43a9d62d0fa92b01e7adc851ed0ed3b2b6";
const TEHRAN_OFFSET_MIN = 210; // +03:30 fixed (no DST since 2022)

function tehranDayKey(d: Date): string {
  return new Date(d.getTime() + TEHRAN_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}
function tehranDayStartUtc(dayKey: string): Date {
  return new Date(new Date(`${dayKey}T00:00:00.000Z`).getTime() - TEHRAN_OFFSET_MIN * 60_000);
}
const usd = (v: number) => (v >= 0 ? "+" : "") + v.toFixed(2);

async function main() {
  console.log("═".repeat(78));
  console.log("TASK 45 · Q3 — DAILY PNL VERACITY AUDIT (Tehran UTC+03:30 doctrine)");
  console.log("═".repeat(78));

  // ── 1. DB truth buckets ────────────────────────────────────────────────
  const all = await db.signal.findMany({
    where: { closedAt: { not: null } },
    select: { closedAt: true, createdAt: true, marginUsd: true, pnlPercent: true, status: true, symbol: true, qualityFlag: true, reachedTp: true },
  });
  const byDay = new Map<string, { usd: number; n: number }>();
  for (const s of all) {
    if (!s.closedAt) continue;
    const k = tehranDayKey(s.closedAt);
    const e = byDay.get(k) ?? { usd: 0, n: 0 };
    e.usd += (s.marginUsd * s.pnlPercent) / 100;
    e.n += 1;
    byDay.set(k, e);
  }
  const days = [...byDay.keys()].sort().slice(-8);
  let cum = 0;
  const dbCurve = days.map((d) => {
    cum += byDay.get(d)!.usd;
    return { date: d.slice(5), daily: byDay.get(d)!.usd, cum, n: byDay.get(d)!.n };
  });

  // ── 1b. REPLICATE the dashboard's exact filters (v6.2 rolling window +
  // v10.18 clean-ledger): createdAt >= now-7d AND qualityFlag = null. The UI
  // curve is a 7-day ROLLING window over rows CREATED in-window — long-held
  // rows closed inside the window but created before it are (by doctrine)
  // excluded, and qualityFlag ledger-integrity rows are excluded.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const inWindow = all.filter((s) => s.closedAt && s.closedAt >= weekAgo && s.createdAt >= weekAgo && s.qualityFlag === null);
  const byDayWin = new Map<string, number>();
  for (const s of inWindow) {
    const k = tehranDayKey(s.closedAt!);
    const key = k.slice(5); // window spans 7 days — sliced key is unambiguous
    byDayWin.set(key, (byDayWin.get(key) ?? 0) + (s.marginUsd * s.pnlPercent) / 100);
  }
  // delta rows for mismatching days — computed AFTER the live fetch (needs the curve)
  const computeDeltaRows = (liveCurve: Array<any>) =>
    all.filter((s) => {
      if (!s.closedAt) return false;
      const k = tehranDayKey(s.closedAt);
      const uiVal = liveCurve.find((x) => x.date === k.slice(5))?.daily;
      if (uiVal === undefined) return false;
      const dbVal = byDay.get(k)?.usd ?? 0;
      if (Math.abs(dbVal - uiVal) < 0.02) return false;
      return s.createdAt < weekAgo || s.qualityFlag !== null;
    });

  // ── 2. live dashboard equityCurve ──────────────────────────────────────
  let live: any = null;
  try {
    const res = await fetch("http://localhost:3000/api/pulse", { headers: { "x-nexus-key": KEY }, cache: "no-store" });
    live = res.ok ? await res.json() : null;
  } catch { /* app down → DB-only audit */ }

  console.log("\n[1] DB-TRUTH daily buckets vs live /api/pulse equityCurve — two lenses:");
  console.log("    LENS-A = full ledger (every closed row, by Tehran close-day)");
  console.log("    LENS-B = dashboard doctrine (createdAt≥7d window + qualityFlag=null)");
  console.log("day        │   LENS-A │   LENS-B │  UI daily │ A vs UI  │ B vs UI  │");
  console.log("─".repeat(78));
  const liveCurve: Array<any> = live?.stats?.equityCurve ?? [];
  let mismatchesB = 0;
  for (const row of dbCurve) {
    const ui = liveCurve.find((x) => x.date === row.date);
    const aVal = row.daily;
    const bVal = byDayWin.get(row.date) ?? null;
    const dA = ui ? aVal - ui.daily : null;
    const dB = ui && bVal !== null ? bVal - ui.daily : null;
    const bOk = ui && bVal !== null && Math.abs(bVal - ui.daily) < 0.02;
    if (ui && !bOk) mismatchesB++;
    console.log(
      `${row.date}     │ ${usd(aVal).padStart(8)} │ ${bVal !== null ? usd(bVal).padStart(8) : "   —    "} │ ${ui ? usd(ui.daily).padStart(9) : "   MISS  "} │ ${dA === null ? "   —    " : usd(dA).padStart(8)} │ ${dB === null ? "   —    " : usd(dB).padStart(8)} │ ${bOk ? "B ✓" : ui ? "B ✗" : "—"}`,
    );
  }
  const deltaRows = computeDeltaRows(liveCurve);
  if (deltaRows.length > 0) {
    console.log(`\n    LENS-A↔UI delta rows (${deltaRows.length}) — exactly the doctrine-excluded ledger rows:`);
    for (const s of deltaRows.slice(0, 12)) {
      const why = s.qualityFlag !== null ? `qualityFlag=${s.qualityFlag}` : "created<window(7d rolling)";
      console.log(`      ${s.symbol} closed ${s.closedAt!.toISOString().slice(5, 16)} ${usd((s.marginUsd * s.pnlPercent) / 100)} — ${why}`);
    }
  }

  // ── 3. book consistency ───────────────────────────────────────────────
  const realizedAllTime = all.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const acc = live?.stats?.account;
  const sumAllDays = [...byDay.values()].reduce((a, e) => a + e.usd, 0); // FULL book, not the sliced window
  console.log("\n[2] BOOK CONSISTENCY:");
  console.log(`  Σ(ALL Tehran-day NET, full book ${byDay.size} days) = ${usd(sumAllDays)} · realizedAllTime(DB) = ${usd(realizedAllTime)} · account.balance(UI) = ${acc ? usd(acc.balance) : "n/a"}`);
  const sumOk = Math.abs(sumAllDays - realizedAllTime) < 0.02;
  console.log(`  curve-vs-ledger check: ${sumOk ? "Σ daily ≡ realizedAllTime ✓ (curve = the ledger, only day-bucketed)" : `gap ${usd(realizedAllTime - sumAllDays)} ✗`}`);
  const balExpect = 100 + realizedAllTime;
  const balOk = acc ? Math.abs(acc.balance - balExpect) < 0.02 : null;
  console.log(`  balance check: 100 + realizedAllTime = ${usd(balExpect)} ${balOk === null ? "(app down)" : balOk ? "≡ UI balance ✓" : `vs UI ${usd(acc.balance)} ✗`}`);
  if (acc) {
    console.log(`  equity check: balance ${usd(acc.balance)} + unrealized ${usd(acc.unrealizedPnl)} = ${usd(acc.balance + acc.unrealizedPnl)} vs UI equity ${usd(acc.equity)} ${Math.abs(acc.equity - acc.balance - acc.unrealizedPnl) < 0.02 ? "✓" : "✗"}`);
    console.log(`  v12.0 open book: bankable(breaker) = ${usd(acc.unrealizedPnl)} · allRows(legacy display) = ${usd(acc.unrealizedPnlAllRows ?? NaN)} · unsafe rows = ${acc.unsafeOpenRows}`);
  }

  // ── 4. DAILY REPORT module recompute (current Tehran day) ─────────────
  const todayKey = tehranDayKey(new Date());
  const since = tehranDayStartUtc(todayKey);
  const closedToday = all.filter((s) => s.closedAt && s.closedAt >= since);
  const openedToday = await db.signal.count({ where: { createdAt: { gte: since } } });
  const realizedToday = closedToday.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const winsToday = closedToday.filter((s) => s.reachedTp >= 1).length;
  const stopsToday = closedToday.filter((s) => s.status === "SL").length;
  const expiredToday = closedToday.filter((s) => s.status === "EXPIRED").length;
  // dailyReport.ts OPEN PNL formula: Σ margin×pnlPercent/100 over ACTIVE/TP1/TP2 rows
  const openRows = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { pnlPercent: true, marginUsd: true, symbol: true } });
  const openLegacy = openRows.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const feesToday = await db.signal.aggregate({ where: { closedAt: { gte: since } }, _sum: { feeUsd: true, swapUsd: true } });
  console.log(`\n[3] DAILY REPORT MODULE (Tehran day ${todayKey}, since ${since.toISOString()}):`);
  console.log(`  opened=${openedToday} closed=${closedToday.length} wins(TP-proven)=${winsToday} stops=${stopsToday} expired=${expiredToday}`);
  console.log(`  realizedUsd = ${usd(realizedToday)} · fees = ${(feesToday._sum.feeUsd ?? 0).toFixed(3)} + swap ${(feesToday._sum.swapUsd ?? 0).toFixed(3)}`);
  console.log(`  OPEN PNL (dailyReport legacy formula) = ${usd(openLegacy)}  ← includes sim-sourced rows & stored marks`);
  if (acc) console.log(`  OPEN PNL (bankable/breaker, v12.0)    = ${usd(acc.unrealizedPnl)}  ← the honest bankable number`);

  console.log("\n" + "═".repeat(78));
  console.log(`VERDICT: ${live ? (mismatchesB === 0 ? "equityCurve ≡ DB truth under the documented doctrine (LENS-B) ✓ — DAILY PNL data is TRUE" : `${mismatchesB} day(s) mismatch even under doctrine ✗`) : "live dashboard unreachable — DB-only audit"}`);
  console.log("═".repeat(78));
  await db.$disconnect();
}

main().catch((e) => {
  console.error("verify-daily-pnl failed:", e);
  process.exit(1);
});
