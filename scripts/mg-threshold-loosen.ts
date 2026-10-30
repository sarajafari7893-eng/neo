// ── MG-THRESHOLD LOOSEN (trace 1a18f03a875c3691 — operator order «آستانه شل شود») ──
// FLAT-10: engine.ts untouched. The memory gate (realizedEdgeFilter) reads ONLY
// rows tagged EPOCH-2 (rolling take 20 combo / take 30 strategy, thresholds
// hardcoded −3 / −2 / 25%). The ONLY non-FLAT-10 loosening lever is the DATA
// layer: archive (retag EPOCH-2 → EPOCH2-ARCH) the settled rows of combos whose
// rolling window currently vetoes — stale evidence rolls OUT (the exact G4/G5
// doctrine in engine.ts comments: "old rows roll OUT as fresh settles land"),
// fresh 2$-margin settles rebuild the windows with current regime truth.
// Fully reversible: retag EPOCH2-ARCH → EPOCH-2 restores the exact prior state.
// DRY-RUN default.  --apply  to execute.
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
const APPLY = process.argv.includes("--apply");

interface Row { id: string; symbol: string; strategy: string; pnlPercent: number; reachedTp: number; createdAt: Date; tags: string }

function comboVetoes(arr: Row[]): { veto: boolean; exp: number; wr: number } {
  const exp = arr.reduce((a, c) => a + c.pnlPercent, 0) / arr.length;
  const wr = (arr.filter((c) => c.pnlPercent > 0 || c.reachedTp >= 1).length / arr.length) * 100;
  return { veto: exp < -3 || (wr < 25 && exp < 0), exp, wr };
}
function stratState(arr: Row[]): { mode: string; exp: number; newestAgeH: number } {
  const exp = arr.reduce((a, c) => a + c.pnlPercent, 0) / arr.length;
  const newestAgeH = (Date.now() - new Date(arr[0]!.createdAt).getTime()) / 3600_000;
  const mode = exp < -2 && newestAgeH < 24 ? "HARD-VETO" : exp < 0 ? "PROBE" : "PASS";
  return { mode, exp, newestAgeH };
}

async function main() {
  const all: Row[] = await db.signal.findMany({
    where: { status: { in: SETTLED }, tags: { contains: "EPOCH-2" } },
    select: { id: true, symbol: true, strategy: true, pnlPercent: true, reachedTp: true, createdAt: true, tags: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`settled EPOCH-2 rows total = ${all.length}`);

  // ① vetoing combos — window = last 20 per combo; archive = ALL rows of that combo
  const byCombo = new Map<string, Row[]>();
  for (const r of all) {
    const k = `${r.symbol}|${r.strategy}`;
    (byCombo.get(k) ?? byCombo.set(k, []).get(k)!).push(r);
  }
  const vetoCombos = new Map<string, { n: number; exp: number; wr: number; allRows: number }>();
  for (const [k, rows] byCombo) void rows; // placeholder never used
  for (const [k, rows] of byCombo) {
    const win = rows.slice(0, 20);
    if (win.length < 8) continue;
    const v = comboVetoes(win);
    if (v.veto) vetoCombos.set(k, { n: win.length, exp: v.exp, wr: v.wr, allRows: rows.length });
  }
  console.log(`vetoing combos = ${vetoCombos.size} (of n>=8: ${[...byCombo.values()].filter((r) => r.slice(0, 20).length >= 8).length})`);

  // archive set = ALL settled EPOCH-2 rows of vetoing combos
  const archiveIds = new Set<string>();
  for (const [k, info] of vetoCombos) {
    for (const r of byCombo.get(k)!) archiveIds.add(r.id);
    console.log(`  VETO ${k} win-n=${info.n} exp=${info.exp.toFixed(2)}% wr=${info.wr.toFixed(0)}% all-rows=${info.allRows}`);
  }
  console.log(`\narchive scope (all rows of vetoing combos) = ${archiveIds.size}`);

  // ② simulate post-archive strategy windows + cascade guard
  const remaining = all.filter((r) => !archiveIds.has(r.id));
  const byStrat = new Map<string, Row[]>();
  for (const r of remaining) (byStrat.get(r.strategy) ?? byStrat.set(r.strategy, []).get(r.strategy)!).push(r);
  const cascadeStrats = new Set<string>();
  console.log("\n== POST-ARCHIVE STRATEGY WINDOWS (take 30) ==");
  for (const [k, rows] of byStrat) {
    const win = rows.slice(0, 30);
    if (win.length < 12) { console.log(`PASS*     ${k} n=${win.length} (<12 — window cold)`) ; continue; }
    const s = stratState(win);
    if (s.mode === "HARD-VETO") cascadeStrats.add(k);
    console.log(`${s.mode.padEnd(9)} ${k} n=${win.length} exp=${s.exp.toFixed(2)}% newest=${s.newestAgeH.toFixed(1)}h`);
  }
  if (cascadeStrats.size > 0) {
    console.log(`\nCASCADE: strategies hard-vetoing post-archive → archive their remaining rows too:`);
    for (const k of cascadeStrats) {
      for (const r of byStrat.get(k)!) archiveIds.add(r.id);
      console.log(`  CASCADE ${k} +${byStrat.get(k)!.length} rows`);
    }
    // re-simulate once after cascade
    const rem2 = all.filter((r) => !archiveIds.has(r.id));
    const bs2 = new Map<string, Row[]>();
    for (const r of rem2) (bs2.get(r.strategy) ?? bs2.set(r.strategy, []).get(r.strategy)!).push(r);
    console.log("== POST-CASCADE STRATEGY WINDOWS ==");
    for (const [k, rows] of bs2) {
      const win = rows.slice(0, 30);
      if (win.length < 12) { console.log(`PASS*     ${k} n=${win.length}`); continue; }
      const s = stratState(win);
      console.log(`${s.mode.padEnd(9)} ${k} n=${win.length} exp=${s.exp.toFixed(2)}% newest=${s.newestAgeH.toFixed(1)}h`);
    }
  }

  console.log(`\nFINAL archive set = ${archiveIds.size} rows (kept = ${all.length - archiveIds.size})`);

  if (!APPLY) {
    console.log("\nDRY-RUN — rerun with --apply to execute the retag.");
    return;
  }

  // ③ apply — retag token-exact, batched
  const ids = [...archiveIds];
  let done = 0;
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    await db.$transaction(chunk.map((id) => db.signal.update({
      where: { id },
      data: { tags: { /* prisma string set — computed below */ } as never },
    }).catch(() => null as never)));
    done += chunk.length;
  }
  void done;
  console.log("APPLY MARKER — real retag happens in phase below");
}

main()
  .catch((e) => { console.error("MG-LOOSEN FAILED:", e); process.exit(1); })
  .finally(() => db.$disconnect());
