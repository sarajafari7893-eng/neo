/**
 * TASK 53-c part2 — READ-ONLY: flow coverage of deploys + hourly cadence + gate settings.
 * bun scripts/audit-flow-coverage.ts
 */
import { db } from "../src/lib/db";

function tehHour(d: Date): string {
  const s = new Date(d.getTime() + 210 * 60_000);
  return `${s.toISOString().slice(5, 10)} ${s.toISOString().slice(11, 13)}h`;
}

async function main() {
  const since = new Date("2026-10-15T00:00:00.000Z");
  const sigs = await db.signal.findMany({
    where: { createdAt: { gte: since } },
    select: { symbol: true, createdAt: true, tags: true, flowJson: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("created since Oct15:", sigs.length);

  // coverage histogram from flowJson
  let blind = 0, partial = 0, full = 0, noFlow = 0;
  const covKeys = ["crowd", "topLongShort", "cvd", "tape", "whales", "oi", "funding"];
  const covCounts: Record<string, number> = {};
  for (const s of sigs) {
    if (!s.flowJson) { noFlow++; continue; }
    try {
      const f = JSON.parse(s.flowJson) as { coverage?: string[]; available?: string[]; blind?: boolean; keys?: string[] };
      const arr = (f as any).coverage ?? (f as any).available ?? (f as any).keys ?? [];
      if ((f as any).blind || arr.length === 0) blind++;
      else if (arr.length >= 5) full++;
      else partial++;
      for (const k of arr) covCounts[k] = (covCounts[k] ?? 0) + 1;
    } catch { blind++; }
  }
  console.log(`flowJson: noFlow=${noFlow} blind=${blind} partial=${partial} full=${full}`);
  console.log("covKeys seen:", Object.entries(covCounts).sort((a, b) => b[1] - a[1]).slice(0, 12));

  // sample one flowJson
  const withFlow = sigs.find((s) => s.flowJson);
  if (withFlow) console.log("SAMPLE flowJson:", withFlow.flowJson!.slice(0, 400));

  // hourly deploy cadence (Tehran) last 3 days
  const hourly = new Map<string, number>();
  for (const s of sigs) {
    const k = tehHour(s.createdAt);
    hourly.set(k, (hourly.get(k) ?? 0) + 1);
  }
  const keys = [...hourly.keys()].sort();
  console.log("\nhourly deploys (Tehran):");
  for (const k of keys) console.log(`${k}  ${"#".repeat(Math.min(hourly.get(k) ?? 0, 40))} ${hourly.get(k)}`);

  // gate settings
  const settings = await (db as any).gateSetting.findMany?.() ?? null;
  if (settings) console.log("\nGateSettings:", JSON.stringify(settings).slice(0, 900));

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
