// READ-ONLY FORENSICS — operator mandate 2026-10-18 (trace 1a150c7f7dc103c5):
// «APRUSDT, BRUSDT — بررسی ردیابی‌ها و تایید کارت سیگنال امروز؛ دلایل شکست؛
//  تاخیر داده یا تاخیر ورود؟ دیتای اولین نشانه‌های ورود موجود است؟»
//
// LENSES:
//  ① per-signal event timeline (decision→card latency, ladder events, SL fills)
//  ② radar (pumpTrack) layer: today's tracks + radar→signal conversion health
//  ③ tape integrity: PricePoint cadence/gaps 06:30-12:30Z (data-reception check)
//  ④ deploy evidence: factors / flow / mtf at CREATED (was the first-sign data present?)
//  ⑤ flow-blindness census: FLOW-NEUTRAL-with-null-metrics vs real neutral
//  ⑥ verdict matrix: entry-quality vs outcome (BE-saved vs full -1R)
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const syms = ["APRUSDT", "BRUSDT"];
const DAY0 = new Date("2026-10-18T00:00:00Z"); // UTC day covering the Tehran morning session
const TAPE_FROM = new Date("2026-10-18T06:30:00Z");
const TAPE_TO = new Date("2026-10-18T12:30:00Z");

function pct(a: number, b: number): string { return `${(((a - b) / b) * 100).toFixed(2)}%`; }

async function main() {
  console.log("═══ ① SIGNAL TIMELINES (decision→card latency + ladder) ═══");
  const sigs = await db.signal.findMany({
    where: { symbol: { in: syms }, createdAt: { gte: DAY0 } },
    orderBy: { createdAt: "asc" },
  });
  for (const s of sigs) {
    const evs = await db.signalEvent.findMany({ where: { signalId: s.id }, orderBy: { createdAt: "asc" } });
    const created = evs.find((e) => e.type === "CREATED");
    const cardLagS = created ? (created.createdAt.getTime() - s.createdAt.getTime()) / 1000 : -1;
    const lifeMin = s.closedAt ? (s.closedAt.getTime() - s.createdAt.getTime()) / 60000 : -1;
    const be = evs.find((e) => e.type === "BE_TRAIL");
    console.log(`\nNX-${s.serial} ${s.symbol} SHORT ${s.strategy}/${s.timeframe} · created=${s.createdAt.toISOString()} · conf=${s.confidence}`);
    console.log(`  card-lag(createdAt→CREATED event): ${cardLagS.toFixed(1)}s · life=${lifeMin.toFixed(1)}min · outcome=${s.status} net=${s.pnlPercent}% max=${s.maxPnlPercent}%`);
    console.log(`  BE-armed: ${be ? `+${Math.round((be.createdAt.getTime() - s.createdAt.getTime()) / 1000)}s` : "never (full −1R exposed)"}`);
    for (const e of evs) {
      if (e.type === "CREATED") continue;
      console.log(`    +${Math.round((e.createdAt.getTime() - s.createdAt.getTime()) / 1000)}s [${e.type}] ${e.message.slice(0, 110)}`);
    }
  }

  console.log("\n═══ ② RADAR LAYER — first-sign capture + conversion health ═══");
  const tracks = await db.pumpTrack.findMany({
    where: { symbol: { in: syms }, detectedAt: { gte: new Date("2026-10-17T21:30:00Z") } },
    orderBy: { detectedAt: "asc" },
  });
  for (const t of tracks) {
    console.log(`${t.symbol} ${t.kind} detected=${t.detectedAt.toISOString()} anchor=${t.anchorPrice} vel5m=${t.vel5mPct?.toFixed(2)}% phase=${t.phase}/${t.outcome} →signal=${t.signalId ? "LINKED" : "telemetry-only"}`);
  }
  const t48 = await db.pumpTrack.count({ where: { detectedAt: { gte: new Date(Date.now() - 48 * 3600e3) } } });
  const t48l = await db.pumpTrack.count({ where: { detectedAt: { gte: new Date(Date.now() - 48 * 3600e3) }, signalId: { not: null } } });
  const allT = await db.pumpTrack.count();
  const allL = await db.pumpTrack.count({ where: { signalId: { not: null } } });
  const lastLink = await db.pumpTrack.findFirst({ where: { signalId: { not: null } }, orderBy: { detectedAt: "desc" }, select: { symbol: true, detectedAt: true } });
  console.log(`conversion: 48h ${t48l}/${t48} · all-time ${allL}/${allT} (${((allL / Math.max(1, allT)) * 100).toFixed(1)}%) · LAST LINK: ${lastLink ? `${lastLink.symbol} ${lastLink.detectedAt.toISOString()}` : "never"}`);

  console.log("\n═══ ③ TAPE INTEGRITY (data-reception latency check) ═══");
  for (const sym of syms) {
    const pts = await db.pricePoint.findMany({
      where: { symbol: sym, createdAt: { gte: TAPE_FROM, lte: TAPE_TO } },
      orderBy: { createdAt: "asc" },
    });
    let maxGap = 0, maxGapAt = "";
    for (let i = 1; i < pts.length; i++) {
      const g = pts[i]!.createdAt.getTime() - pts[i - 1]!.createdAt.getTime();
      if (g > maxGap) { maxGap = g; maxGapAt = pts[i - 1]!.createdAt.toISOString(); }
    }
    const cadS = pts.length > 1 ? (TAPE_TO.getTime() - TAPE_FROM.getTime()) / (pts.length - 1) / 1000 : 0;
    console.log(`${sym}: ${pts.length} pts / 6h (~${cadS.toFixed(0)}s cadence) · max gap ${(maxGap / 1000).toFixed(0)}s @ ${maxGapAt}`);
  }

  console.log("\n═══ ④ DEPLOY EVIDENCE — was the first-sign data present? ═══");
  for (const s of sigs) {
    let flowNulls = 0, flowKeys = 0, flowVerdict = "?";
    try {
      const f = JSON.parse(s.flowJson ?? "{}");
      flowVerdict = f.verdict ?? "?";
      const m = f.metrics ?? {};
      const keys = ["oiDelta10m", "oiDelta1h", "oiValueUsd", "cvdNetBase", "cvdNetPctOfVol", "takerRatio", "crowdLongShort", "funding8h"];
      flowKeys = keys.length;
      flowNulls = keys.filter((k) => m[k] == null).length;
    } catch { /* keep defaults */ }
    let mtf = "";
    try { const m = JSON.parse(s.mtfJson ?? "{}"); mtf = `net=${m.netScore} bias=${m.netBias} align=${m.alignment}`; } catch { /* noop */ }
    const rsi = (() => { try { const f = JSON.parse(s.factorsJson ?? "[]") as Array<{ factor: string; detail: string }>; return f.find((x) => x.factor === "RSI POSITION")?.detail ?? "?"; } catch { return "?"; } })();
    console.log(`NX-${s.serial} ${s.symbol}: flow=${flowVerdict} null-metrics=${flowNulls}/${flowKeys} · MTF ${mtf} · ${rsi}`);
  }

  console.log("\n═══ ⑤ FLOW-BLINDNESS CENSUS (48h) — NEUTRAL-vs-NO-DATA honesty ═══");
  const recent = await db.signal.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 48 * 3600e3) } },
    select: { serial: true, flowJson: true }, orderBy: { createdAt: "desc" },
  });
  let blind = 0, sighted = 0;
  for (const s of recent) {
    try {
      const f = JSON.parse(s.flowJson ?? "{}");
      const m = f.metrics ?? {};
      const anyData = m.oiValueUsd != null || m.cvdNetBase != null || m.takerRatio != null;
      if (anyData) sighted++; else blind++;
    } catch { blind++; }
  }
  console.log(`last-48h deploys: flow-SIGHTED ${sighted} · flow-BLIND ${blind} (${((blind / Math.max(1, blind + sighted)) * 100).toFixed(0)}% blind) — blind deploys are tagged FLOW-NEUTRAL as if the book said "neutral"`);

  console.log("\n═══ ⑥ ENTRY QUALITY vs TAPE (the 2 full stops) ═══");
  for (const serial of [2770, 2779]) {
    const s = sigs.find((x) => x.serial === serial);
    if (!s) continue;
    const near = await db.pricePoint.findMany({
      where: { symbol: s.symbol, createdAt: { gte: new Date(s.createdAt.getTime() - 30 * 60000), lte: new Date(s.createdAt.getTime() + 5 * 60000) } },
      orderBy: { createdAt: "asc" },
    });
    if (near.length < 2) continue;
    const lo = Math.min(...near.map((p) => p.price));
    const hi = Math.max(...near.map((p) => p.price));
    console.log(`NX-${serial} ${s.symbol}: entry ${s.entryPrice} vs ±30min tape [lo ${lo} / hi ${hi}] — entry sits ${(100 * (s.entryPrice - lo) / Math.max(1e-12, hi - lo)).toFixed(0)}% of the local range`);
  }
  console.log("\n(readonly — no data mutated)");
}

main().finally(() => db.$disconnect());
