// ── MG-THRESHOLD AUDIT (trace 1a18f03a875c3691 — «آستانه شل شود») ──
// READ-ONLY audit of the memory-gate windows exactly as engine.ts
// realizedEdgeFilter reads them (EPOCH-2 tagged, settled, rolling take 20/30).
// Output: vetoing combos + vetoing strategies + knobs state.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

async function main() {
  const settledE2 = await db.signal.count({ where: { status: { in: SETTLED }, tags: { contains: "EPOCH-2" } } });
  const openE2 = await db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] }, tags: { contains: "EPOCH-2" } } });
  console.log(`== BOOK == settled-EPOCH2=${settledE2} open-EPOCH2=${openE2}`);

  // distinct settled combos
  const rows = await db.signal.findMany({
    where: { status: { in: SETTLED }, tags: { contains: "EPOCH-2" } },
    select: { symbol: true, strategy: true, pnlPercent: true, reachedTp: true, createdAt: true, tags: true },
    orderBy: { createdAt: "desc" },
  });
  const combos = new Map<string, typeof rows>();
  const strats = new Map<string, typeof rows>();
  for (const r of rows) {
    const ck = `${r.symbol}|${r.strategy}`;
    if (!combos.has(ck)) combos.set(ck, []);
    const carr = combos.get(ck)!;
    if (carr.length < 20) carr.push(r);
    const sarr = strats.get(r.strategy) ?? [];
    if (sarr.length < 30) sarr.push(r);
    strats.set(r.strategy, sarr);
  }

  console.log("\n== COMBO WINDOWS (take 20) — VETOING only ==");
  let vetoCombos = 0;
  const vetoSet: string[] = [];
  for (const [k, arr] of [...combos.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (arr.length < 8) continue;
    const exp = arr.reduce((a, c) => a + c.pnlPercent, 0) / arr.length;
    const wr = (arr.filter((c) => c.pnlPercent > 0 || c.reachedTp >= 1).length / arr.length) * 100;
    const veto = exp < -3 || (wr < 25 && exp < 0);
    if (veto) {
      vetoCombos++;
      vetoSet.push(k);
      console.log(`VETO ${k} n=${arr.length} exp=${exp.toFixed(2)}% wr=${wr.toFixed(0)}%`);
    }
  }
  console.log(`vetoing-combos=${vetoCombos} / total-n>=8=${[...combos.values()].filter((a) => a.length >= 8).length}`);

  console.log("\n== STRATEGY WINDOWS (take 30) — all with n>=12 ==");
  const affectedStrats = new Set<string>();
  for (const [k, arr] of [...strats.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (arr.length < 12) continue;
    const exp = arr.reduce((a, c) => a + c.pnlPercent, 0) / arr.length;
    const newestAgeH = (Date.now() - new Date(arr[0]!.createdAt).getTime()) / 3600_000;
    // strategy veto: exp < -2 AND newest settle fresh <24h; else probe path (ok, probe)
    const hardVeto = exp < -2 && newestAgeH < 24;
    const mode = hardVeto ? "HARD-VETO" : exp < 0 ? "PROBE" : "PASS";
    if (hardVeto) affectedStrats.add(k);
    console.log(`${mode.padEnd(9)} ${k} n=${arr.length} exp=${exp.toFixed(2)}% newest=${newestAgeH.toFixed(1)}h ago`);
  }

  // rows that would be archived if we archive the vetoing combo windows
  const archiveRows = rows.filter((r) => vetoSet.includes(`${r.symbol}|${r.strategy}`));
  console.log(`\n== ARCHIVE SCOPE == rows in vetoing combo windows: ${archiveRows.length}`);

  // knobs state
  const keys = ["epoch", "core-revert", "gate", "raw-cal", "flow-gate", "symbol-cap", "strat-pause.state"];
  for (const k of keys) {
    const row = await db.engineSetting.findUnique({ where: { key: k } });
    console.log(`KNOB ${k} = ${row ? row.value.slice(0, 220) : "<absent>"}`);
  }

  // recent MG-PROBE rows
  const probes = await db.signal.count({ where: { tags: { contains: "MG-PROBE" }, createdAt: { gt: new Date(Date.now() - 7 * 864e5) } } });
  console.log(`\nMG-PROBE rows (7d) = ${probes}`);

  // recent signals
  const recent = await db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 5, select: { serial: true, symbol: true, strategy: true, direction: true, createdAt: true, tags: true } });
  console.log("\n== LAST 5 SIGNALS ==");
  for (const s of recent) console.log(`NX-${String(s.serial).padStart(4, "0")} ${s.symbol} ${s.direction} ${s.strategy} @ ${s.createdAt.toISOString()} [${s.tags.slice(0, 80)}]`);
}

main()
  .catch((e) => { console.error("AUDIT FAILED:", e); process.exit(1); })
  .finally(() => db.$disconnect());
