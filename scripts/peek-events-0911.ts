import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const evs = await p.signalEvent.findMany({
  where: { OR: [{ message: { contains: "slAtr" } }, { message: { contains: "rrScale" } }, { message: { contains: "knob" } }, { message: { contains: "GATE" } }] },
  orderBy: { createdAt: "desc" }, take: 8, select: { createdAt: true, type: true, message: true },
});
for (const e of evs) console.log(e.createdAt.toISOString(), e.type, "|", e.message.slice(0, 220));
await p.$disconnect();
