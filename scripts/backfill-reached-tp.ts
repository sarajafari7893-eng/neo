// ── one-off backfill: derive reachedTp for historical signals ──
// Sources of truth, in order: final status (TP3→3, TP2→2, TP1→1),
// then SignalEvent TP1/TP2/TP3 rows for signals that leveled but
// resolved as SL/EXPIRED/CLOSED. Run: bun scripts/backfill-reached-tp.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const signals = await db.signal.findMany({
    select: { id: true, serial: true, status: true, reachedTp: true },
  });
  const events = await db.signalEvent.findMany({
    where: { type: { in: ["TP1", "TP2", "TP3"] }, signalId: { not: null } },
    select: { signalId: true, type: true },
  });
  const evMax = new Map<string, number>();
  for (const e of events) {
    if (!e.signalId) continue;
    const lvl = e.type === "TP3" ? 3 : e.type === "TP2" ? 2 : 1;
    evMax.set(e.signalId, Math.max(evMax.get(e.signalId) ?? 0, lvl));
  }
  let updated = 0;
  for (const s of signals) {
    const fromStatus = s.status === "TP3" ? 3 : s.status === "TP2" ? 2 : s.status === "TP1" ? 1 : 0;
    const target = Math.max(s.reachedTp, fromStatus, evMax.get(s.id) ?? 0);
    if (target !== s.reachedTp) {
      await db.signal.update({ where: { id: s.id }, data: { reachedTp: target } });
      updated++;
    }
  }
  console.log(`backfill reachedTp: ${updated}/${signals.length} signals updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
