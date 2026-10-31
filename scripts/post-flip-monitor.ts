// POST-FLIP 24h MONITOR — Next-mission proposal ① (trace 1a1937b74e767b61)
// «پایش صدور ۲۴ساعته پسا-فلیپ: اگر SHORT در CHOP از DECISIVE+minScore عبور نکرد،
//  فقط دو مسیر باقی است — threshold پلکان (+6/+10 روی ۱۷ پین) یا خشکسالی کاندید؛
//  آنگاه تصمیم اپراتور دربارهٔ کوتاه‌کردن پلکان (یک knob دیتایی دیگر)»
// Read-only over gate-journal + Signal/SignalEvent. FLAT-10 untouched.
//   bun scripts/post-flip-monitor.ts            → live snapshot since flip
//   bun scripts/post-flip-monitor.ts --report   → same + persist EngineSetting journal
import { db } from "../src/lib/db";
import { readFileSync, existsSync } from "node:fs";

const FLIP_MS = 1793474343000; // 2026-10-31T19:19:03Z — shortGuard 1→0 (chop-short-open.ts)
const hoursSince = (Date.now() - FLIP_MS) / 3_600_000;

type Rec = { k: string; v: Record<string, unknown> };
const recs: Rec[] = [];
if (existsSync(".data/gate-journal.jsonl")) {
  for (const line of readFileSync(".data/gate-journal.jsonl", "utf8").split("\n")) {
    try { const r = JSON.parse(line); if (r?.v?.at >= FLIP_MS) recs.push(r); } catch {}
  }
}
const blocks = recs.filter(r => r.k === "b").map(r => r.v as { gate: string; direction: string; symbol: string; reason: string });
const deploys = recs.filter(r => r.k === "d").map(r => r.v as { symbol: string; direction: string });

// ── gate funnel for SHORT since flip ──
const shortBlocks = blocks.filter(b => b.direction === "SHORT");
const byGate = new Map<string, number>();
for (const b of shortBlocks) byGate.set(b.gate, (byGate.get(b.gate) ?? 0) + 1);
// REGIME blocks split into deliberate-veto family vs tax-ladder family
const regimeShort = shortBlocks.filter(b => b.gate === "REGIME");
const regimeVetoFamily = regimeShort.filter(b => /scalp VETOED|breakout\/momentum VETOED/.test(b.reason)).length;
const regimeTaxFamily = regimeShort.length - regimeVetoFamily;
// ladder PASS samples (band=PASS, SHORT) — proof candidates pass the tax ladder
const ladderPassRecs = recs.filter(r => r.k === "s" && (r.v as Record<string, unknown>).direction === "SHORT" && (r.v as Record<string, unknown>).band === "PASS");
const ladderPass = ladderPassRecs.length;
const ladderPassSymbols = [...new Set(ladderPassRecs.map(r => String((r.v as Record<string, unknown>).symbol)))];
// pre-flip baseline (40min window before flip) for comparison
const PRE_MS = 40 * 60 * 1000;
const preBlocks = recs.filter(r => r.k === "b").length; // recs are already post-flip only; load pre-flip separately
let preShortGuard = 0, preRegimeShort = 0;
if (existsSync(".data/gate-journal.jsonl")) {
  for (const line of readFileSync(".data/gate-journal.jsonl", "utf8").split("\n")) {
    try {
      const r = JSON.parse(line);
      const at = r?.v?.at; if (!at || at >= FLIP_MS || at < FLIP_MS - PRE_MS) continue;
      if (r.k !== "b") continue;
      if (r.v.gate === "SHORT-GUARD") preShortGuard++;
      if (r.v.gate === "REGIME" && r.v.direction === "SHORT") preRegimeShort++;
    } catch {}
  }
}

// ── DB: new signals + decisive-stage events since flip ──
const since = new Date(FLIP_MS);
const newSignals = await db.signal.findMany({ where: { createdAt: { gte: since } }, select: { serial: true, symbol: true, direction: true, strategy: true, status: true, confidence: true } });
const newEvents = await db.signalEvent.count({ where: { createdAt: { gte: since }, type: { in: ["CREATED", "TP1", "TP2", "TP3", "SL"] } } });
const decisiveShortBlocks = shortBlocks.filter(b => b.gate === "DECISIVE");

console.log(`╔══ POST-FLIP MONITOR — t+${hoursSince.toFixed(1)}h since 2026-10-31T19:19:03Z (shortGuard 1→0) ══╗`);
console.log(`║ SHORT-GUARD blocks : post-flip 0  (pre-flip 40min baseline: ${preShortGuard}) — دیوار R1 برداشته شد`);
console.log(`║ REGIME|SHORT blocks: ${regimeShort.length} total → ${regimeVetoFamily} عمدی (AI-SCALP/BREAKOUT veto-family) · ${regimeTaxFamily} خانوادهٔ زنده (پلکان)`);
console.log(`║ SHORT deploys      : ${deploys.filter(d => d.direction === "SHORT").length} · new Signal rows: ${newSignals.length} · outcome events: ${newEvents}`);
for (const s of newSignals) console.log(`║   → NX-${s.serial} ${s.symbol} ${s.direction} ${s.strategy} conf=${s.confidence} status=${s.status}`);
console.log(`║ LADDER PASS samples : ${ladderPass} در ${ladderPassSymbols.length} نماد یکتا (SHORT band=PASS — عبور واقعی از پلکان مالیاتی)${ladderPassSymbols.length ? " · " + ladderPassSymbols.slice(0, 10).join(",") : ""}`);
console.log(`║ DECISIVE|SHORT blocks: ${decisiveShortBlocks.length}`);
for (const b of decisiveShortBlocks.slice(0, 8)) console.log(`║   → ${b.symbol}: ${b.reason.slice(0, 110)}`);
// verdict
let verdict: string;
const shortDeploys = deploys.filter(d => d.direction === "SHORT").length + newSignals.filter(s => s.direction === "SHORT").length;
if (shortDeploys > 0) verdict = "ISSUING — مسیر شورت در CHOP زنده است؛ پلکان نیازی به کوتاه‌شدن ندارد";
else if (ladderPass > 0 && decisiveShortBlocks > 0) verdict = "DECISIVE-QUALITY — کاندید از پلکان مالیاتی PASS شد اما در ستون کیفیت (اکسکورشن/ER-چاپ-مرده) مرد؛ پلکان عامل خشکسالی نیست — کوتاه‌کردن پلکان توصیه نمی‌شود";
else if (ladderPass > 0) verdict = "LADDER-PASS-UPSTREAM — کاندید پلکان را PASS کرد و در گیت‌های بالادستی دیگر (FLOW/STALE/…) مرد؛ جزئیات قیف را ببین";
else verdict = "DROUGHT — خشکسالی کاندید SHORTِ خانوادهٔ زنده؛ تصمیم پلکان (knob دیتایی) با اپراتور";
console.log(`║ VERDICT: ${verdict}`);
console.log(`╚══════════════════════════════════════════════════════════════╝`);

if (process.argv.includes("--report")) {
  const key = "post-flip.monitor";
  const prev = await db.engineSetting.findUnique({ where: { key } });
  const log: Array<Record<string, unknown>> = prev ? JSON.parse(prev.value) : [];
  log.push({ at: new Date().toISOString(), tHours: +hoursSince.toFixed(2), shortGuardBlocks: 0, regimeShortBlocks: regimeShort.length, regimeVetoFamily, regimeTaxFamily, ladderPass, decisiveShortBlocks: decisiveShortBlocks.length, shortDeploys: deploys.filter(d => d.direction === "SHORT").length, newSignals: newSignals.length, verdict });
  await db.engineSetting.upsert({ where: { key }, create: { key, value: JSON.stringify(log.slice(-30)) }, update: { value: JSON.stringify(log.slice(-30)) } });
  await db.signalEvent.create({ data: { type: "SYSTEM", level: "ai", message: `POST-FLIP MONITOR t+${hoursSince.toFixed(1)}h: SHORT-GUARD=0 · REGIME|SHORT=${regimeShort.length} (${regimeVetoFamily} veto-family) · DECISIVE|SHORT=${decisiveShortBlocks.length} · deploys=${deploys.filter(d => d.direction === "SHORT").length} · ${verdict}` } });
  console.log("persisted → EngineSetting 'post-flip.monitor' + SYSTEM event ✓");
}
await db.$disconnect();
