// ── R25 diagnostic: expiry-gate runtime evidence + near-TP expiry quantification ──
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

interface TtlTel { extended: number; tpAfter: number; slAfter: number; reExpired: number; capturedUsd: number; denied: number; deniedNearTp: number; updatedAt: string }

async function main() {
  // 1) gate telemetry + live knobs
  const tel = await db.engineSetting.findUnique({ where: { key: "ttl-gate" } });
  const gs = await db.engineSetting.findUnique({ where: { key: "gate-settings" } });
  console.log("== TTL-GATE TELEMETRY ==");
  console.log(tel?.value ?? "(none)");
  console.log("\n== GATE SETTINGS (live knobs) ==");
  if (gs?.value) {
    const v = JSON.parse(gs.value);
    console.log(JSON.stringify({ ttlExtendMax: v.ttlExtendMax, ttlExtendMinutes: v.ttlExtendMinutes, ttlNearTpPct: v.ttlNearTpPct, minScore: v.minScore }, null, 0));
  } else console.log("(none)");

  // 2) the extended signal(s)
  const ext = await db.signal.findMany({ where: { ttlExtensions: { gt: 0 } } });
  console.log(`\n== EXTENDED SIGNALS (${ext.length}) ==`);
  for (const s of ext) console.log(`${s.symbol} ${s.direction} status=${s.status} ext=${s.ttlExtensions} pnl=${s.pnlPercent}% reachedTp=${s.reachedTp} closedAt=${s.closedAt?.toISOString() ?? "OPEN"}`);

  // 3) recent EXPIRED since gate deploy (08:00 local = 00:00Z) with distance-to-TP at mark
  const since = new Date("2026-09-04T00:00:00Z");
  const rows = await db.signal.findMany({ where: { status: "EXPIRED", closedAt: { gte: since } }, orderBy: { closedAt: "desc" } });
  console.log(`\n== EXPIRED SINCE 2026-09-04T00:00Z (${rows.length}) — distance to next unbanked TP at mark ==`);
  let nearCnt = 0;
  for (const r of rows) {
    const dir = r.direction === "SHORT" ? -1 : 1;
    const lev = r.leverage || 1;
    const moveUnlev = (r.pnlPercent ?? 0) / lev; // net levered % → unlevered (fees ignored, conservative)
    const priceAtMark = r.entryPrice * (1 + (dir * moveUnlev) / 100);
    const nextTp = r.reachedTp >= 1 ? r.tp2 : r.tp1;
    const distTp = (Math.abs(nextTp - priceAtMark) / priceAtMark) * 100;
    const near = distTp <= 3;
    if (near) nearCnt++;
    console.log(`${r.closedAt?.toISOString().slice(11, 16)} ${r.symbol.padEnd(10)} ${r.direction?.padEnd(5)} lev=${String(lev).padStart(2)} markNet=${(r.pnlPercent ?? 0).toFixed(1).padStart(7)}% distTP1≈${distTp.toFixed(2).padStart(6)}%${near ? " ←NEAR" : ""} afterlife=${(r.afterlife ?? "-").padEnd(8)} maxPost=${(r.maxPostPnlPercent ?? 0).toFixed(1)}%`);
  }
  console.log(`→ ${nearCnt}/${rows.length} expired within 3% (unlevered) of next TP`);

  // 4) gate decision events since deploy
  const evs = await db.signalEvent.findMany({
    where: { type: { in: ["TTL_EXPIRED", "ENGINE"] }, createdAt: { gte: since }, OR: [{ message: { contains: "gate" } }, { message: { contains: "GATE" } }] },
    orderBy: { createdAt: "desc" }, take: 40,
  });
  console.log(`\n== GATE-RELATED EVENTS (${evs.length}, newest first) ==`);
  for (const e of evs) console.log(`${e.createdAt.toISOString().slice(11, 19)} [${e.type}] ${e.message.slice(0, 160)}`);

  // 5) currently maturing signals (next to hit TTL)
  const open = await db.signal.findMany({ where: { closedAt: null, status: { in: ["ACTIVE", "TP1", "TP2"] } }, orderBy: { expiresAt: "asc" }, take: 8 });
  console.log(`\n== OPEN SIGNALS by next expiry (${open.length}) ==`);
  for (const s of open) {
    const minLeft = Math.round((s.expiresAt.getTime() - Date.now()) / 60000);
    console.log(`${s.symbol.padEnd(10)} ${s.direction?.padEnd(5)} status=${s.status.padEnd(5)} expires in ${String(minLeft).padStart(5)}m ext=${s.ttlExtensions}/${3} entry=${s.entryPrice} tp1=${s.tp1} sl=${s.stopLoss}`);
  }
}
main().finally(() => db.$disconnect());
