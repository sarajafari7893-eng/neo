// ── NEXUS//SIGNALS deep performance audit (operator review round) ──
// Dumps measured outcomes: status mix, WR, net PNL, per-strategy/symbol,
// regime tag breakdown, governor log, gate state, calibration, LLM health.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();

const SETTLED_IN = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

async function main() {
  const [byStatus, settled, open, gateRow, govRow, govLogRow, calRow, supRow, ttlRow, hystRow] = await Promise.all([
    db.signal.groupBy({ by: ["status"], _count: true }),
    db.signal.findMany({
      where: { status: { in: SETTLED_IN } },
      select: { symbol: true, direction: true, strategy: true, status: true, pnlPercent: true, marginUsd: true, reachedTp: true, tags: true, confidence: true, riskReward: true, timeframe: true, createdAt: true, closedAt: true, ttlExtensions: true },
      orderBy: { createdAt: "desc" },
      take: 400,
    }),
    db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, direction: true, pnlPercent: true, strategy: true, confidence: true, createdAt: true } }),
    db.engineSetting.findUnique({ where: { key: "gate" } }),
    db.engineSetting.findUnique({ where: { key: "governor" } }),
    db.engineSetting.findUnique({ where: { key: "governor.log" } }),
    db.engineSetting.findUnique({ where: { key: "calibration" } }),
    db.engineSetting.findUnique({ where: { key: "supervisor" } }),
    db.engineSetting.findUnique({ where: { key: "ttl.telemetry" } }),
    db.engineSetting.findUnique({ where: { key: "governor.hysteresis" } }),
  ]);

  const win = (s: { pnlPercent: number; reachedTp: number }) => s.pnlPercent > 0 || s.reachedTp >= 1;
  const n = settled.length;
  const wins = settled.filter(win).length;
  const sumPct = settled.reduce((a, s) => a + s.pnlPercent, 0);
  const netUsd = settled.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);

  console.log("=== SIGNAL OUTCOMES ===");
  console.log(byStatus.map((r) => `${r.status}:${r._count}`).join("  "));
  console.log(`settled=${n} wins(TP-proven)=${wins} WR=${n ? ((wins / n) * 100).toFixed(1) : "0"}%  Σ%=${sumPct.toFixed(1)}  avg=${n ? (sumPct / n).toFixed(2) : "0"}%/trade  net$=${netUsd.toFixed(2)}`);
  console.log(`open=${open.length} — ${open.map((o) => `${o.symbol} ${o.direction} ${o.pnlPercent >= 0 ? "+" : ""}${o.pnlPercent.toFixed(1)}%`).join(" · ")}`);

  const grp = (key: "strategy" | "direction") => {
    const m = new Map<string, { n: number; w: number; pct: number }>();
    for (const s of settled) {
      const k = String((s as unknown as Record<string, unknown>)[key]);
      const c = m.get(k) ?? { n: 0, w: 0, pct: 0 };
      c.n++; c.pct += s.pnlPercent; if (win(s)) c.w++;
      m.set(k, c);
    }
    return [...m.entries()].map(([k, v]) => `${k}: n=${v.n} WR=${((v.w / v.n) * 100).toFixed(0)}% Σ%=${v.pct.toFixed(1)}`).join("\n  ");
  };
  console.log("\n=== BY STRATEGY ===\n  " + grp("strategy"));
  console.log("\n=== BY DIRECTION ===\n  " + grp("direction"));

  const tagCount = new Map<string, { n: number; w: number }>();
  for (const s of settled) {
    for (const t of (s.tags ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      const c = tagCount.get(t) ?? { n: 0, w: 0 };
      c.n++; if (win(s)) c.w++;
      tagCount.set(t, c);
    }
  }
  console.log("\n=== BY TAG (regime/flow) ===\n  " + [...tagCount.entries()].sort((a, b) => b[1].n - a[1].n).map(([t, v]) => `${t}: n=${v.n} WR=${((v.w / v.n) * 100).toFixed(0)}%`).join("\n  "));

  const symAgg = new Map<string, { n: number; w: number; pct: number }>();
  for (const s of settled) {
    const c = symAgg.get(s.symbol) ?? { n: 0, w: 0, pct: 0 };
    c.n++; c.pct += s.pnlPercent; if (win(s)) c.w++;
    symAgg.set(s.symbol, c);
  }
  const top = [...symAgg.entries()].sort((a, b) => b[1].pct - a[1].pct);
  console.log("\n=== TOP/BOTTOM SYMBOLS by Σ% ===");
  console.log("  TOP: " + top.slice(0, 5).map(([s, v]) => `${s} +${v.pct.toFixed(1)}% (n=${v.n})`).join(" · "));
  console.log("  BOTTOM: " + top.slice(-5).map(([s, v]) => `${s} ${v.pct.toFixed(1)}% (n=${v.n})`).join(" · "));

  console.log("\n=== GATE ===\n  " + (gateRow?.value ?? "none"));
  console.log("\n=== GOVERNOR CFG ===\n  " + (govRow?.value ?? "none"));
  console.log("\n=== GOVERNOR LOG (last 5) ===");
  try {
    const log = JSON.parse(govLogRow?.value ?? "[]") as Array<{ at: string; trigger: string; label: string; decisions: Array<{ action: string; value?: number; applied: boolean; rationale: string }> }>;
    for (const row of log.slice(0, 5)) {
      console.log(`  ${row.at.slice(0, 19)}Z ${row.trigger}/${row.label}: ${row.decisions.map((d) => `${d.action}${d.value !== undefined ? `→${d.value}` : ""}${d.applied ? "" : "(rejected)"}`).join(" | ")}`);
    }
  } catch { console.log("  (none)") }
  console.log("\n=== HYSTERESIS ===\n  " + (hystRow?.value ?? "none"));
  console.log("\n=== CALIBRATION ===\n  " + (calRow?.value?.slice(0, 600) ?? "none"));
  console.log("\n=== SUPERVISOR ===\n  " + (supRow?.value?.slice(0, 400) ?? "none"));
  console.log("\n=== TTL TELEMETRY ===\n  " + (ttlRow?.value ?? "none"));
  await db.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
