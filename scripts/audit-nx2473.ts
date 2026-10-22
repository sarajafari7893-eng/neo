// Task 39 — NX-2473 full-row + events audit
import { db } from '../src/lib/db';

(async () => {
  const s = await db.signal.findUnique({
    where: { serial: 2473 },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!s) {
    console.log('NX-2473 NOT FOUND');
    const near = await db.signal.findMany({
      where: { serial: { gte: 2460, lte: 2480 } },
      select: { serial: true, symbol: true, status: true, createdAt: true },
      orderBy: { serial: 'asc' },
    });
    console.log('NEARBY SERIALS:', JSON.stringify(near, null, 0));
    process.exit(0);
  }
  const r: any = { ...s };
  delete r.events;
  console.log('=== SIGNAL ROW ===');
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined || v === '' ) continue;
    if (k === 'factorsJson' || k === 'flowJson' || k === 'mtfJson') continue;
    console.log(`${k}: ${v}`);
  }
  console.log('\n=== EVENTS (' + s.events.length + ') ===');
  for (const e of s.events) {
    const d = new Date(e.createdAt).toISOString();
    console.log(`${d} ${e.type.padEnd(14)} ${e.message.slice(0, 160)}`);
  }
  console.log('\n=== FACTORS ===');
  try {
    if (s.factorsJson) console.log(s.factorsJson.slice(0, 1200));
  } catch {}
  console.log('\n=== FLOW ===');
  try {
    if (s.flowJson) console.log(s.flowJson.slice(0, 800));
  } catch {}
  process.exit(0);
})();
