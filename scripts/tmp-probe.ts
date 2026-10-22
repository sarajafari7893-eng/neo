import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const J = (o: any) => JSON.stringify(o, (_k, v) => typeof v === "bigint" ? Number(v) : v);
const s = await db.signal.findFirst({ orderBy: { createdAt: "desc" } });
console.log("SAMPLE:", J({ symbol: s.symbol, strategy: s.strategy, status: s.status, tags: s.tags, reachedTp: s.reachedTp, afterlife: s.afterlife, maxPnl: s.maxPnlPercent, maxPost: s.maxPostPnlPercent, ttl: s.ttlMinutes, ext: s.ttlExtensions, fee: s.feeUsd, pnl: s.pnlPercent, rr: s.riskReward, tf: s.timeframe, flow: (s.flowJson||"").slice(0,200) }));
const m = await db.$queryRawUnsafe<any[]>(`SELECT strategy, status, COUNT(*) c FROM Signal GROUP BY strategy, status ORDER BY strategy, c DESC`);
console.log("MATRIX:", J(m));
// regime hints in tags
const tg = await db.$queryRawUnsafe<any[]>(`SELECT tags, COUNT(*) c FROM Signal GROUP BY tags ORDER BY c DESC LIMIT 15`);
console.log("TAGS:", J(tg));
await db.$disconnect();
