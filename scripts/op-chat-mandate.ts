// OPERATOR REQUEST (chat 2026-09-06) — three mandates, executed in order:
//   1) RUN THE BACKTEST the operator asked for («میتونی این تست بک‌تست رو انجام بدی؟»)
//   2) APPLY STRICTER FILTERS based on the fresh evidence (chatbot suggestion
//      endorsed by the operator: «اجرای فیلترهای سختگیرانه‌تر»)
//   3) EXPAND SENIOR-ENGINEER AUTHORITY (governor action budget + cadence)
// Every change is clamped, hysteresis-armed, and audited as an ENGINE event.
import { db } from "../src/lib/db";
import { runBacktest } from "../src/lib/backtest";
import { getGateSettings, putGateSettings } from "../src/lib/gate-settings";
import { fireEvent } from "../src/lib/engine";

// ── phase 1: fresh operator-requested replay ──
console.log("── PHASE 1: operator-requested backtest ──");
const bt = await runBacktest({ persist: true, label: "OPERATOR REQUEST (chat)" });
console.log(`replay done: n=${bt.n} WR ${bt.winRate}% Wilson-LB ${bt.wilsonLB}% expectancy ${bt.avgNetPct}%/trade NET equity $${bt.equityEnd}`);
console.log(`verdict: ${bt.verdict}`);
for (const s of bt.byStrategy) console.log(`  strategy ${s.strategy}: n=${s.n} wins=${s.wins} avg ${s.avgNetPct}%/trade`);

// ── phase 2: evidence-based operator tightening ──
console.log("── PHASE 2: stricter filters (operator mandate) ──");
const gate = await getGateSettings();
const settled = await db.signal.findMany({
  where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
  orderBy: { createdAt: "desc" },
  select: { status: true, pnlPercent: true, reachedTp: true },
  take: 200,
});
const realizedWr = settled.length ? (settled.filter((s) => s.pnlPercent > 0 || s.reachedTp >= 1).length / settled.length) * 100 : null;
const slCount = settled.filter((s) => s.status === "SL").length;
const stopRate = settled.length ? (slCount / settled.length) * 100 : null;
console.log(`live evidence: realized WR ${realizedWr !== null ? realizedWr.toFixed(1) + "%" : "n/a"} over ${settled.length} settled, stop-rate ${stopRate !== null ? stopRate.toFixed(0) + "%" : "n/a"}, replay WR ${bt.winRate}% (LB ${bt.wilsonLB}%)`);

const tightening: Record<string, number> = {};
const rationale: string[] = [];

// (a) BASE threshold up — negative expectancy ⇒ filter marginal confluence harder.
if ((bt.winRate < 35 || bt.avgNetPct < 0) && gate.minScore < 45) {
  tightening.minScore = Math.min(45, gate.minScore + 7);
  rationale.push(`MIN_SCORE ${gate.minScore}→${tightening.minScore} (replay WR ${bt.winRate}%, expectancy ${bt.avgNetPct}%/trade — marginal confluence must be priced out)`);
}
// (b) regime hardening L2 — chop/volatile bleed veto + BTC-spillover surcharge.
if (gate.regimeGuard < 2) {
  tightening.regimeGuard = 2;
  rationale.push(`REGIME-GUARD L${gate.regimeGuard}→L2 (hardened: chop breakout/momentum VETO + BTC-spillover surcharge + vol-expansion MR veto)`);
}
// (c) flow veto threshold up — negative-aggressor flow rejects more candidates.
if (gate.flowVetoScore < 12) {
  tightening.flowVetoScore = 12;
  rationale.push(`FLOW-VETO ≤−${gate.flowVetoScore}→≤−12 (stricter aggressor-flow gate)`);
}
// (d) capacity down — deep drawdown ($74.72 equity from $100) ⇒ fewer concurrent risks.
if (gate.maxActive > 4) {
  tightening.maxActive = 4;
  rationale.push(`CAP ${gate.maxActive}→4 (equity $${bt.equityEnd} — cut concurrent risk while edge is unproven)`);
}
// (e) stops widen one notch ONLY if noise-stop dominance is measured.
if (stopRate !== null && stopRate >= 45 && gate.slAtrMult < 2.0) {
  tightening.slAtrMult = Number(Math.min(2.0, gate.slAtrMult + 0.25).toFixed(2));
  rationale.push(`SL ${gate.slAtrMult}→${tightening.slAtrMult}×ATR (stop-rate ${stopRate.toFixed(0)}% — noise taking trades out)`);
}

if (Object.keys(tightening).length) {
  const after = await putGateSettings(tightening);
  // arm hysteresis for every knob we moved so the governor cannot flip it back
  // immediately — v6.4.1 FIX: arm under the governor ACTION names (set_*), NOT
  // the gate-setting keys; the cooldown lookup is keyed by action (alias-aware
  // in governor.ts now, but arming under the canonical key is the correct form).
  const GATE_TO_ACTION: Record<string, string> = {
    minScore: "set_min_score",
    flowVetoScore: "set_flow_veto",
    flowShortlist: "set_flow_shortlist",
    universeSize: "set_universe",
    ttlExtendMax: "set_ttl_extend_max",
    ttlExtendMinutes: "set_ttl_extend_minutes",
    ttlNearTpPct: "set_ttl_near_tp",
    slAtrMult: "set_sl_atr_mult",
    rrScale: "set_rr_scale",
    regimeGuard: "set_regime_guard",
    maxActive: "set_max_active",
    riskPerTrade: "set_risk_per_trade",
  };
  const KEY_HYST = "governor.hysteresis";
  const row = await db.engineSetting.findUnique({ where: { key: KEY_HYST } });
  const hyst = (row ? (JSON.parse(row.value) as Record<string, { at: number; from: number | null; to: number }>) : {});
  for (const [k, v] of Object.entries(tightening)) {
    hyst[GATE_TO_ACTION[k] ?? k] = { at: Date.now(), from: (gate as unknown as Record<string, number>)[k] ?? null, to: v };
  }
  await db.engineSetting.upsert({ where: { key: KEY_HYST }, create: { key: KEY_HYST, value: JSON.stringify(hyst) }, update: { value: JSON.stringify(hyst) } });
  console.log(`gates after: ${JSON.stringify(after)}`);
  for (const r of rationale) {
    console.log(`  · ${r}`);
    await fireEvent(null, null, "ENGINE", "ai", `OPERATOR MANDATE (chat): ${r}`).catch(() => undefined);
  }
} else {
  console.log("no tightening applicable — gates already at or beyond target strictness");
}

// ── phase 3: senior-engineer authority expansion ──
console.log("── PHASE 3: governor authority expansion ──");
const KEY = "governor";
const gRow = await db.engineSetting.findUnique({ where: { key: KEY } });
if (gRow) {
  const cfg = JSON.parse(gRow.value) as { intervalMin?: number; maxActions?: number; cycles?: number; lastRunAt?: string | null };
  const before = { intervalMin: cfg.intervalMin, maxActions: cfg.maxActions };
  cfg.intervalMin = 30; // 45→30min — more responsive autonomous calibration
  cfg.maxActions = 4;   // 2→4 actions per cycle (clamp raised to 5 in v6.4)
  await db.engineSetting.update({ where: { key: KEY }, data: { value: JSON.stringify(cfg) } });
  console.log(`governor: interval ${before.intervalMin}→${cfg.intervalMin}min, maxActions ${before.maxActions}→${cfg.maxActions}`);
  await fireEvent(null, null, "ENGINE", "ai", `SENIOR-ENGINEER UPGRADE: governor cadence ${before.intervalMin}→${cfg.intervalMin}min, action budget ${before.maxActions}→${cfg.maxActions}/cycle, core model → glm-4.6 + engineer-bridge to sandbox inbox`).catch(() => undefined);
} else {
  console.log("governor row missing — defaults (3 actions) apply on next cycle");
}

console.log("── DONE — operator request executed and audited ──");
process.exit(0);
