import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
async function main() {
  const since = new Date("2026-09-04T02:00:00Z");
  const rows = await db.signal.findMany({
    where: { status: "EXPIRED", closedAt: { gte: since } },
    orderBy: { closedAt: "desc" },
  });
  console.log("EXPIRED SINCE DEPLOY — afterlife verdicts:");
  for (const r of rows) console.log(`${r.symbol.padEnd(9)} ${r.direction?.slice(0,4)} mark=${(r.pnlPercent??0).toFixed(1).padStart(6)}% afterlife=${(r.afterlife??"-").padEnd(8)} closedAt=${r.closedAt?.toISOString().slice(11,16)}`);
  const won = rows.filter(r => r.afterlife === "TP1_HIT" || r.afterlife === "TP2_HIT" || r.afterlife === "TP3_HIT").length;
  const tracking = rows.filter(r => r.afterlife === "TRACKING").length;
  console.log(`\nafterlife: ${won}/${rows.length} hit TP after expiry, ${tracking} still tracking`);
  // imminent gate tests: open signals with live price
  const open = await db.signal.findMany({ where: { closedAt: null, status: { in: ["ACTIVE","TP1","TP2"] } }, orderBy: { expiresAt: "asc" } });
  for (const s of open) {
    const pp = await db.pricePoint.findFirst({ where: { symbol: s.symbol }, orderBy: { createdAt: "desc" } });
    if (!pp) continue;
    const isLong = s.direction === "LONG";
    const move = ((pp.price - s.entryPrice)/s.entryPrice)*(isLong?1:-1)*100;
    const nextTp = s.status === "ACTIVE" ? s.tp1 : s.status === "TP1" ? s.tp2 : s.tp3;
    const distTp = (Math.abs(nextTp - pp.price)/pp.price)*100;
    console.log(`${s.symbol.padEnd(9)} ${s.status.padEnd(6)} exp=${s.expiresAt.toISOString().slice(11,16)}Z mark=${move.toFixed(2).padStart(6)}% distTP=${distTp.toFixed(2)}% progress=${distTp>0?(move/distTp*100).toFixed(0):"—"}% lev=${s.leverage}x ext=${s.ttlExtensions}`);
  }
}
main().finally(() => db.$disconnect());
