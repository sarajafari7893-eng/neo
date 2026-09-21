import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const mins = Number(process.argv[2] ?? 5);
const s = await db.signal.findFirst({ where: { status: { in: ["ACTIVE","TP1","TP2"] }, closedAt: null }, orderBy: { createdAt: "desc" } });
if (!s) { console.log("no open signal"); process.exit(1); }
await db.signal.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() + mins*60_000) } });
console.log("updated", s.symbol, s.id.slice(0,10), "→", mins, "min");
await db.$disconnect();
