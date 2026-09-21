// READ-ONLY forensics: decision→fill drift for radar cards + informative stats
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

async function main() {
  // 1) radar tracks that spawned signals: anchorPrice (detection) vs entryPrice (fill)
  const tracks = await db.pumpTrack.findMany({
    where: { signalId: { not: null } },
    select: { id: true, symbol: true, kind: true, anchorPrice: true, vel5mPct: true, detectedAt: true, signalId: true },
  });
  const rows = tracks as Array<{ id: string; symbol: string; kind: string; anchorPrice: number; vel5mPct: number | null; detectedAt: Date; signalId: string | null }>;
  const sigs = await db.signal.findMany({
    where: { tags: { contains: "PUMP" } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, serial: true, symbol: true, direction: true, entryPrice: true, createdAt: true, ttlMinutes: true, status: true, pnlPercent: true, strategy: true, tags: true },
  });
  console.log("== radar-tagged signals:", sigs.length);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let n = 0;
  const drifts: number[] = [];
  for (const s of sigs) {
    // find the track by symbol+signalId
    const t = rows.find((r) => r.signalId === s.id);
    if (!t) continue;
    const drift = ((s.entryPrice - t.anchorPrice) / t.anchorPrice) * 100 * (s.direction === "LONG" ? 1 : -1);
    drifts.push(drift);
    n++;
    if (n <= 30) console.log(`NX-${String(s.serial).padStart(4, "0")} ${s.symbol} ${s.direction} anchor ${t.anchorPrice} entry ${s.entryPrice} drift(adverse) ${drift >= 0 ? "+" : ""}${drift.toFixed(2)}% vel5m ${t.vel5mPct?.toFixed(2) ?? "?"}% lagMin ${((s.createdAt.getTime() - t.detectedAt.getTime()) / 60000).toFixed(1)} ttl ${s.ttlMinutes} status ${s.status}`);
  }
  if (drifts.length) {
    const sorted = [...drifts].sort((a, b) => a - b);
    const mean = drifts.reduce((a, b) => a + b, 0) / drifts.length;
    console.log(`== drift n=${drifts.length} mean ${mean.toFixed(2)}% median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)}% min ${sorted[0]!.toFixed(2)}% max ${sorted[sorted.length - 1]!.toFixed(2)}%`);
    const adverse = drifts.filter((d) => d > 0.15).length;
    console.log(`== adverse-drift >0.15%: ${adverse}/${drifts.length}`);
  } else {
    console.log("== no track→signal pairs found (signalId linking)");
  }

  // 2) TTL + status mix of radar cards vs book
  const radar = sigs;
  const ttlHist: Record<number, number> = {};
  for (const s of radar) ttlHist[s.ttlMinutes] = (ttlHist[s.ttlMinutes] ?? 0) + 1;
  console.log("== radar TTL histogram:", JSON.stringify(ttlHist));
  const st: Record<string, number> = {};
  for (const s of radar) st[s.status] = (st[s.status] ?? 0) + 1;
  console.log("== radar status mix:", JSON.stringify(st));

  // 3) EPOCH-2 informative split (whole book)
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED"] }, tags: { contains: "EPOCH-2" } },
    select: { status: true, ttlMinutes: true, tags: true, pnlPercent: true, createdAt: true, strategy: true },
  });
  let info = 0, expNoTouch = 0;
  const expTtl: Record<number, number> = {};
  for (const s of settled) {
    if (s.status === "EXPIRED") { expNoTouch++; expTtl[s.ttlMinutes] = (expTtl[s.ttlMinutes] ?? 0) + 1; } else info++;
  }
  console.log(`== EPOCH-2 settled ${settled.length}: informative ${info} (${((info / settled.length) * 100).toFixed(1)}%) · EXPIRED ${expNoTouch}`);
  console.log("== EXPIRED TTL histogram:", JSON.stringify(expTtl));

  // 4) radar cards' hold time at expiry
  const radarExpired = radar.filter((s) => s.status === "EXPIRED");
  console.log(`== radar expired: ${radarExpired.length}/${radar.length}`);
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
