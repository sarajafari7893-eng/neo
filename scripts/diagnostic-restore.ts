// ── DIAGNOSTIC RESTORE (trace 1a18f46475319a8d — operator order
// «حالا که مشخص شد گیت‌ها چه چیزی جلوی صدور را گرفته بوده لایهٔ REGIME ،
// CHOP-LONG و دیگر وتوها سیستم را برگردان. سپس راستی ازمایی کن.») ──
// The diagnostic loosening (gate.diagnostic-loosen, trace 1a18f1e500a55ab5)
// proved issuance end-to-end (NX-3215..3220 issued; NX-3216/3217 executed LIVE
// on Toobit at fixed 2$ margin). Its own record pre-committed the revert plan:
//   revert: { regimeGuard: 1, shortGuard: 1, decisiveFilter: 1 }
// This script applies exactly that — values read from the loosen record, not
// hardcoded — so the protective walls (REGIME-CHOP / CHOP-LONG hard-veto,
// SHORT-GUARD HTF-align, DECISIVE-EXCURSION deploy filter) stand again.
// NOT touched (out of scope, each with its own standing mandate):
//   · minScore=17 (operator-pinned)          · AI-SCALP strat-pause (approved)
//   · memory-gate archive «آستانه شل شود» (separate direct order — windows
//     re-harden automatically from fresh settles; reverse retag stays ready)
//   · physical/data-integrity gates · breakoutGuard/volBarrier (pre-arc state)
// Governor note: governor.ts HYST_ACTIONS owns set_regime_guard and its own
// doctrine (line ~208) demands L1+ — it already restored regimeGuard→1 at
// 23:45:36Z (hysteresis set_regime_guard to:1). shortGuard/decisiveFilter are
// NOT governor-owned → this restore is stable.
// FLAT-10: src/lib/engine.ts untouched — DB knob layer only (15s engine cache).
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const TRACE = "1a18f46475319a8d";

async function main() {
  const row = await db.engineSetting.findUnique({ where: { key: "gate" } });
  if (!row) throw new Error("gate knob missing");
  const cur = JSON.parse(row.value) as Record<string, number>;

  const loosenRow = await db.engineSetting.findUnique({ where: { key: "gate.diagnostic-loosen" } });
  const loosen = loosenRow ? (JSON.parse(loosenRow.value) as { revert?: Record<string, number>; reverted?: boolean }) : null;
  // target = the loosen record's own pre-committed revert values (fallback 1/1/1 = designed defaults)
  const target = {
    regimeGuard: loosen?.revert?.regimeGuard ?? 1,
    shortGuard: loosen?.revert?.shortGuard ?? 1,
    decisiveFilter: loosen?.revert?.decisiveFilter ?? 1,
  };

  const before = { regimeGuard: cur.regimeGuard, shortGuard: cur.shortGuard, decisiveFilter: cur.decisiveFilter };
  console.log("current :", JSON.stringify(before));
  console.log("target  :", JSON.stringify(target), "(source: gate.diagnostic-loosen.revert)");
  console.log("loosen record reverted:", loosen?.reverted ?? "no-record");

  const changes = (Object.keys(target) as Array<keyof typeof target>)
    .filter((k) => before[k] !== target[k])
    .map((k) => ({ knob: k, from: before[k], to: target[k] }));
  console.log("changes :", changes.length ? JSON.stringify(changes) : "none (already restored)");

  if (!APPLY) { console.log("DRY-RUN — rerun with --apply"); return; }

  const next = { ...cur, ...target };
  await db.engineSetting.update({ where: { key: "gate" }, data: { value: JSON.stringify(next) } });

  // mark the loosen record reverted
  if (loosenRow && loosen) {
    const marked = { ...loosen, reverted: true, revertedAt: new Date().toISOString(), revertedByTrace: TRACE };
    await db.engineSetting.update({ where: { key: "gate.diagnostic-loosen" }, data: { value: JSON.stringify(marked) } });
  }

  const record = {
    action: "DIAGNOSTIC-RESTORE",
    trace: TRACE,
    operatorOrder: "حالا که مشخص شد گیت‌ها چه چیزی جلوی صدور را گرفته بوده لایهٔ REGIME ، CHOP-LONG و دیگر وتوها سیستم را برگردان. سپس راستی ازمایی کن.",
    evidence: "issuance verified end-to-end (NX-3215 BTC + NX-3216 INJ + NX-3217 LSK issued; NX-3216/3217 executed LIVE on Toobit fixed-2$ margin, detect→exec ≤2.7s) — verification purpose fulfilled; protective walls return per governor doctrine (CHOP-LONG = worst losing cohort) and operator order",
    changed: Object.fromEntries(
      (Object.keys(target) as Array<keyof typeof target>).map((k) => [k, { from: before[k], to: target[k] }]),
    ),
    kept: {
      minScore: cur.minScore,
      minScorePinned: cur.minScorePinned,
      memoryGateArchive: "kept open — separate operator mandate «آستانه شل شود» (trace 1a18f03a875c3691); windows re-harden from fresh settles; reverse retag ready",
      stratPauseAISCALP: "kept (operator-approved)",
      physicalGates: "kept",
    },
    at: new Date().toISOString(),
  };
  await db.engineSetting.upsert({
    where: { key: "gate.diagnostic-restore" },
    create: { key: "gate.diagnostic-restore", value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  });
  await db.signalEvent.create({
    data: {
      type: "SYSTEM",
      level: "ai",
      message: `DIAGNOSTIC-RESTORE (operator order, trace ${TRACE}): verification fulfilled (NX-3215..3220 issued, NX-3216/3217 executed LIVE fixed-2$) — regimeGuard/shortGuard/decisiveFilter restored to ${target.regimeGuard}/${target.shortGuard}/${target.decisiveFilter} from ${before.regimeGuard}/${before.shortGuard}/${before.decisiveFilter}; REGIME-CHOP + CHOP-LONG hard-veto + SHORT-GUARD HTF-align + DECISIVE-EXCURSION walls stand again. minScore=17 pinned; memory-gate archive (separate mandate) open with self-rehardening; AI-SCALP pause kept.`,
    },
  });
  console.log(`APPLIED: regimeGuard=${target.regimeGuard} shortGuard=${target.shortGuard} decisiveFilter=${target.decisiveFilter} · loosen record marked reverted · journal written (engine cache ≤15s)`);
}

main()
  .catch((e) => { console.error("RESTORE FAILED:", e); process.exit(1); })
  .finally(() => db.$disconnect());
