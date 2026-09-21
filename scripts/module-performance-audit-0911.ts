// ── NEXUS//SIGNALS — MODULE PERFORMANCE AUDIT (read-only, operator round 0911)
// Operator ask: «گزارش و تحقیق از عملکرد ماژول ها، یادگیری، ردیابی سیگنالها»
// Evidence base: live SQLite (Signal/SignalEvent/EngineSetting), gate-journal,
// shadow-veto journal, flow-factor backtest artifact. READ-ONLY — no writes.
// Run: bun scripts/module-performance-audit-0911.ts
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";

const db = new PrismaClient();
const CLOSED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

interface Row {
  symbol: string; strategy: string; direction: string; status: string;
  pnlPercent: number; marginUsd: number; feeUsd: number; swapUsd: number;
  reachedTp: number; confidence: number; createdAt: Date; closedAt: Date | null;
  ttlMinutes: number; ttlExtensions: number; maxPnlPercent: number;
}
const netUsd = (r: Row) => (r.marginUsd * r.pnlPercent) / 100 - r.feeUsd - r.swapUsd;
const r2 = (v: number) => Number(v.toFixed(2));

function agg(rows: Row[]) {
  const n = rows.length;
  const wins = rows.filter((r) => netUsd(r) > 0);
  const losses = rows.filter((r) => netUsd(r) <= 0);
  const net = rows.reduce((a, r) => a + netUsd(r), 0);
  const fees = rows.reduce((a, r) => a + r.feeUsd + r.swapUsd, 0);
  const avgWin = wins.length ? wins.reduce((a, r) => a + netUsd(r), 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, r) => a + netUsd(r), 0) / losses.length : 0;
  return {
    n,
    wins: wins.length,
    winRatePct: n ? r2((wins.length / n) * 100) : 0,
    netUsd: r2(net),
    feesUsd: r2(fees),
    avgWinUsd: r2(avgWin),
    avgLossUsd: r2(avgLoss),
    expectancyUsd: n ? r2(net / n) : 0,
  };
}

function groupBy(rows: Row[], key: (r: Row) => string): Record<string, ReturnType<typeof agg>> {
  const m = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, v]) => [k, agg(v)]));
}

function tehranHour(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", hour: "2-digit", hour12: false }).format(d));
}

async function main() {
  const out: Record<string, unknown> = {};
  const now = new Date();
  const since7d = new Date(now.getTime() - 7 * 86400e3);
  const since14d = new Date(now.getTime() - 14 * 86400e3);

  // ── A. lifecycle funnel ──
  const [totalAll, closedAll, activeAll, created7d, closed7dRows] = await Promise.all([
    db.signal.count(),
    db.signal.count({ where: { status: { in: CLOSED } } }),
    db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } } }),
    db.signal.count({ where: { createdAt: { gte: since7d } } }),
    db.signal.findMany({
      where: { status: { in: CLOSED }, createdAt: { gte: since14d } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  out.funnel = { totalAll, closedAll, activeNow: activeAll, created7d, closed14d: closed7dRows.length };

  const rows = closed7dRows as unknown as Row[];
  out.overall14d = agg(rows);
  out.byStrategy14d = groupBy(rows, (r) => r.strategy);
  out.byDirection14d = groupBy(rows, (r) => r.direction);
  out.bySymbol14d = groupBy(rows, (r) => r.symbol);
  out.byStatus14d = groupBy(rows, (r) => r.status);

  const hourMap: Record<string, number> = {};
  for (const r of rows) {
    const h = String(tehranHour(r.createdAt)).padStart(2, "0");
    hourMap[h] = r2((hourMap[h] ?? 0) + netUsd(r));
  }
  out.netByTehranHour = hourMap;

  const confBuckets: Record<string, Row[]> = { "lt60": [], "60-74": [], "75plus": [] };
  for (const r of rows) (r.confidence < 60 ? confBuckets.lt60 : r.confidence < 75 ? confBuckets["60-74"] : confBuckets["75plus"]).push(r);
  out.byConfidence = Object.fromEntries(Object.entries(confBuckets).map(([k, v]) => [k, agg(v)]));

  // give-back: MFE reached TP1-level profit but final net <= 0
  const gaveBack = rows.filter((r) => r.maxPnlPercent >= 8 && netUsd(r) <= 0);
  out.giveBack = {
    count: gaveBack.length,
    shareOfClosedPct: rows.length ? r2((gaveBack.length / rows.length) * 100) : 0,
    missedNetUsd: r2(gaveBack.reduce((a, r) => a + (r.marginUsd * r.maxPnlPercent) / 100 - r.feeUsd, 0)),
    examples: gaveBack.slice(0, 8).map((r) => ({ symbol: r.symbol, strategy: r.strategy, dir: r.direction, mfePct: r.maxPnlPercent, finalPct: r.pnlPercent, status: r.status })),
  };

  // ── B. gate journal (flow/signal filter) ──
  interface GateLine { t: number; symbol: string | null; layer: string; score: number | null; shortlisted: boolean; vetoed: boolean; deployed: boolean; cause: string | null }
  const gateLines: GateLine[] = fs.readFileSync("db/gate-journal.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const decisions = gateLines.filter((g) => g.symbol);
  const byLayer: Record<string, number> = {};
  for (const g of gateLines) byLayer[g.layer] = (byLayer[g.layer] ?? 0) + 1;
  const vetoed = decisions.filter((g) => g.vetoed);
  const shortlisted = decisions.filter((g) => g.shortlisted);
  const deployedJ = decisions.filter((g) => g.deployed);
  const vetoCauses: Record<string, number> = {};
  for (const g of vetoed) vetoCauses[g.cause ?? "unknown"] = (vetoCauses[g.cause ?? "unknown"] ?? 0) + 1;
  out.gateJournal = {
    lines: gateLines.length,
    symbolDecisions: decisions.length,
    byLayer,
    shortlisted: shortlisted.length,
    vetoed: vetoed.length,
    deployed: deployedJ.length,
    vetoCauses,
    spanDays: gateLines.length > 1 ? r2((gateLines[gateLines.length - 1].t - gateLines[0].t) / 86400e3) : 0,
  };

  // ── C. shadow-veto (double-arm review) ──
  interface VetoLine { t: number; symbol: string; verdict: string; arm: string; label: string; audit: string; confidence: number; reasons: string[] }
  let shadow: Record<string, unknown> = { lines: 0 };
  try {
    const sv: VetoLine[] = fs.readFileSync("db/shadow-veto.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    shadow = {
      lines: sv.length,
      allow: sv.filter((v) => v.verdict === "ALLOW").length,
      veto: sv.filter((v) => v.verdict === "VETO").length,
      audits: sv.reduce<Record<string, number>>((a, v) => ({ ...a, [v.audit]: (a[v.audit] ?? 0) + 1 }), {}),
      byArm: sv.reduce<Record<string, number>>((a, v) => ({ ...a, [`${v.arm}:${v.label}`]: (a[`${v.arm}:${v.label}`] ?? 0) + 1 }), {}),
    };
  } catch { /* file absent */ }
  out.shadowVeto = shadow;

  // ── D. flow backtest artifact ──
  try {
    const fb = JSON.parse(fs.readFileSync("scripts/flow-backtest-result.json", "utf8")) as Record<string, unknown>;
    out.flowBacktest = {
      generatedAt: fb.generatedAt,
      symbolsUsed: fb.symbolsUsed,
      window: fb.window,
      keys: Object.keys(fb),
      // carry the whole summary block if present, else top-level scalar fields
      summary: (fb.summary ?? fb.results ?? fb.metrics ?? null),
      scalarTail: Object.fromEntries(Object.entries(fb).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")),
    };
  } catch { out.flowBacktest = null; }

  // ── E. SignalEvent mix (last 7d) ──
  const ev7d = await db.signalEvent.groupBy({
    by: ["type"],
    where: { createdAt: { gte: since7d } },
    _count: { _all: true },
    orderBy: { _count: { type: "desc" } },
  });
  out.signalEvents7d = ev7d.map((e) => ({ type: e.type, count: e._count._all }));

  // ── F. EngineSetting (learning / calibration / governor state) ──
  const settings = await db.engineSetting.findMany({ orderBy: { key: "asc" } });
  out.engineSettings = settings.map((s) => ({ key: s.key, value: s.value.length > 220 ? s.value.slice(0, 220) + "…" : s.value, updatedAt: s.updatedAt }));

  // ── G. flow capture forward outcome: VOL-CAUSE tagged signals ──
  const flowTagged = rows.filter((r) => /FLOW/i.test(r.confidence.toString())); // noop guard
  void flowTagged;
  const flowRows = await db.signal.findMany({
    where: { OR: [{ tags: { contains: "FLOW" } }, { tags: { contains: "VOL" } }], status: { in: CLOSED }, createdAt: { gte: since14d } },
  });
  out.flowTaggedClosed14d = agg(flowRows as unknown as Row[]);

  fs.writeFileSync("scripts/module-audit-0911.json", JSON.stringify(out, null, 1));
  console.log("=== MODULE AUDIT 0911 — SUMMARY ===");
  console.log("funnel:", JSON.stringify(out.funnel));
  console.log("overall14d:", JSON.stringify(out.overall14d));
  console.log("byStrategy14d:", JSON.stringify(out.byStrategy14d, null, 1));
  console.log("byStatus14d:", JSON.stringify(out.byStatus14d));
  console.log("giveBack:", JSON.stringify(out.giveBack).slice(0, 600));
  console.log("gateJournal:", JSON.stringify(out.gateJournal));
  console.log("shadowVeto:", JSON.stringify(out.shadowVeto));
  console.log("flowTaggedClosed14d:", JSON.stringify(out.flowTaggedClosed14d));
  console.log("signalEvents7d:", JSON.stringify(out.signalEvents7d));
  console.log("saved → scripts/module-audit-0911.json");
}

main().finally(() => db.$disconnect());
