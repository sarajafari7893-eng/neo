// SENIOR-ENGINEER REPAIR (2026-09-06) — hysteresis key-mismatch remediation.
// Observed: the operator chat-mandate (19:16 UTC) armed governor.hysteresis
// under GATE keys ("regimeGuard", "minScore", …) but the governor's cooldown
// lookup was keyed by ACTION names ("set_regime_guard") → protection was
// inert → cycle #90 flipped REGIME-GUARD L2→L1 sixty seconds after the
// operator mandate. governor.ts knobCooling is now alias-aware (v6.4.1);
// this script repairs the LIVE state:
//   1. restore REGIME-GUARD L2 (operator mandate, backtest evidence)
//   2. re-arm every mandate knob under its canonical ACTION key
//   3. drop the stale gate-key entries
//   4. report via the senior-engineer bridge (responses JSONL → engine event)
import { db } from "../src/lib/db";
import { putGateSettings, getGateSettings } from "../src/lib/gate-settings";
import fs from "node:fs/promises";
import path from "node:path";

const before = await getGateSettings();
console.log("gates BEFORE:", JSON.stringify(before));

// 1) restore the operator-mandate regime hardening
const after = await putGateSettings({ regimeGuard: 2 });
console.log("regimeGuard restored →", after.regimeGuard);

// 2+3) rebuild the hysteresis map under canonical action keys
const KEY_HYST = "governor.hysteresis";
const row = await db.engineSetting.findUnique({ where: { key: KEY_HYST } });
const hyst = (row ? (JSON.parse(row.value) as Record<string, { at: number; from: number | null; to: number }>) : {});
console.log("hysteresis BEFORE:", JSON.stringify(hyst));

const STALE = ["minScore", "regimeGuard", "flowVetoScore", "maxActive", "slAtrMult"];
for (const k of STALE) delete hyst[k];

const now = Date.now();
const ARM: Record<string, { from: number | null; to: number }> = {
  set_min_score: { from: before.minScore, to: after.minScore },
  set_regime_guard: { from: 1, to: 2 },
  set_flow_veto: { from: null, to: after.flowVetoScore },
  set_max_active: { from: null, to: after.maxActive },
  set_sl_atr_mult: { from: null, to: after.slAtrMult },
};
for (const [k, v] of Object.entries(ARM)) hyst[k] = { at: now, from: v.from, to: v.to };
await db.engineSetting.upsert({ where: { key: KEY_HYST }, create: { key: KEY_HYST, value: JSON.stringify(hyst) }, update: { value: JSON.stringify(hyst) } });
console.log("hysteresis AFTER:", JSON.stringify(hyst));

// 4) report through the bridge — the engine tick turns this into an audited event
const RES_PATH = path.join(process.cwd(), "sandbox-inbox", "engineer-responses.jsonl");
const res = {
  id: `RES-${now.toString(36)}`,
  at: new Date().toISOString(),
  title: "Mandate hysteresis repaired + REGIME-GUARD L2 restored",
  status: "DONE",
  note: "mandate cooldowns were armed under gate-keys (inert) so cycle #90 flipped L2→L1; knobCooling is alias-aware now (v6.4.1), guard restored to L2, all mandate knobs re-armed under set_* action keys for the full 90min cooldown",
};
const lines = ((await fs.readFile(RES_PATH, "utf8").catch(() => "")) as string).split("\n").filter(Boolean);
lines.push(JSON.stringify(res));
await fs.writeFile(RES_PATH, lines.slice(-80).join("\n") + "\n", "utf8");
console.log("bridge response appended:", res.id);
process.exit(0);
