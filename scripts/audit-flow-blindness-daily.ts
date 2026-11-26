/** TASK 53-c part3 — READ-ONLY: per-day flow blindness + EngineSetting + AdvisorProposal */
import { db } from "../src/lib/db";

const TEH = 210 * 60_000;
const day = (d: Date) => new Date(d.getTime() + TEH).toISOString().slice(5, 10);

async function main() {
  const sigs = await db.signal.findMany({
    where: { createdAt: { gte: new Date("2026-10-14T00:00:00.000Z") } },
    select: { createdAt: true, flowJson: true, tags: true },
  });
  const perDay = new Map<string, { n: number; blind: number; tagged: number }>();
  for (const s of sigs) {
    const k = day(s.createdAt);
    const v = perDay.get(k) ?? { n: 0, blind: 0, tagged: 0 };
    v.n++;
    let isBlind = false;
    if (!s.flowJson) isBlind = true;
    else {
      try {
        const f = JSON.parse(s.flowJson) as { metrics?: Record<string, unknown> };
        const m = f.metrics ?? {};
        const anyData = Object.values(m).some((x) => x !== null && x !== undefined);
        isBlind = !anyData;
      } catch { isBlind = true; }
    }
    if (isBlind) v.blind++;
    if (s.tags.includes("FLOW-NO-DATA")) v.tagged++;
    perDay.set(k, v);
  }
  console.log("day | created | flowBlind | FLOW-NO-DATA-tagged");
  for (const k of [...perDay.keys()].sort()) {
    const v = perDay.get(k)!;
    console.log(`${k} | ${v.n} | ${v.blind} | ${v.tagged}`);
  }

  const es = await (db as any).engineSetting.findMany().catch(() => null);
  if (es) console.log("\nEngineSetting:", JSON.stringify(es).slice(0, 1500));

  const ap = await (db as any).advisorProposal.findMany({
    where: { status: "APPLIED", appliedAt: { gte: new Date("2026-10-15T00:00:00.000Z") } },
    select: { appliedAt: true, knob: true, currentValue: true, proposedValue: true, direction: true },
  }).catch(() => null);
  console.log("\nAdvisor APPLIED since Oct15:", ap ? JSON.stringify(ap) : "none");

  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
