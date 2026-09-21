// ── v9.1 RAW-CAL — UNFILTERED CALIBRATION CAPTURE MODE (operator mandate) ──
// Operator order 2026-09-13: «یک دستور اجرای صدور سیگنال بدون فیلتر و فقط
// ثبت داده و پیگیری و جورنال سازی برای ارسال به ENGINE MEMORY تا سریعتر به
// حد 100 سیگنال برای AI CALIBRATION برسد، سپس این دستور لغو و تمام عملکرد
// فیلتر و ردیابی با دستور هوش مرکزی و کالیبراسون جدید انجام بشه»
//
// WHAT IT DOES (exactly the operator's words, engineered honestly):
//  · ARMED → the engine issues RAW-CAL signals with the quality filters
//    bypassed (threshold/memory/strategy/short/learned/flow/shadow-veto —
//    engine.ts deploySignal opts.calCapture). Every record keeps its REAL
//    confluence votes + strategy + flow snapshot so the R6 recalibration at
//    n≥100 attributes outcomes to actual factors, not noise.
//  · ONLY data capture: records enter the normal ledger → tracked → settled
//    → journaled exactly like every other signal (same TTL, TP ladder,
//    trailing, afterlife) — nothing is faked, nothing is skipped.
//  · ENGINE MEMORY: state + issued-cohort stats are injected into
//    buildEngineMemory() (ai-memory.ts) so the central intelligence sees the
//    raw cohort as ground truth, and the governor context carries the mode.
//  · AUTO-CANCEL: when the EPOCH-2 settled book reaches the target (100),
//    the mode disarms ITSELF, fires the audited RAW-CAL LIFT event, forces
//    refreshCalibration() (the R6 freeze lifts at n≥100 — new calibration
//    under central-intelligence command), and announces on Telegram.
//  · The operator can DISARM any time (dashboard button / /api/rawcal POST).
//
// ANTI-FLOOD RAILS (protect the ledger, not the filter):
//  · spacingMin (default 12min) between raw issues
//  · maxOpen (default 8) concurrent open RAW-CAL records
//  · the scan's own honesty rails stay HARD inside deploySignal (feed-fresh
//    guard + sim-price ban) — calibration rows are never born from stale
//    or invented prices.

import { db } from "./db";
import { recordRawcalSnapshot } from "./rawcal-telemetry"; // v9.2 pace monitor (no cycle: telemetry imports raw-cal only dynamically)
import { touchRawcalHeartbeat } from "./rawcal-heartbeat"; // v10.20 engine-native run heartbeat (sentinel-compatible)

export const RAWCAL_KEY = "rawcal.state";
export const RAWCAL_TARGET = 100; // the R6 calibration-lift bar (calibration.ts)
// v10.6.1 spacing 12→10 (operator APPROVE 2026-09-18, proposal #3 of msg 3435):
// tightens the anti-flood floor so evidence windows fill faster without
// loosening honesty rails (open-cap + scan rails unchanged).
const DEFAULT_SPACING_MIN = 10;
const DEFAULT_MAX_OPEN = 8;

export interface RawCalState {
  armed: boolean;
  armedAt: string | null;
  armedBy: string;
  disarmReason: string | null;
  disarmedAt: string | null;
  issued: number; // raw records issued while armed (this arm-run)
  issuedTotal: number; // lifetime raw records (tagged RAW-CAL in the ledger)
  lastIssueAt: string | null;
  lastIssueSerial: number | null;
  target: number;
  spacingMin: number;
  maxOpen: number;
  autoLiftAt: string | null; // set when the mode auto-canceled itself
  retargetNote?: string; // v10.6.1+ — EVID-BUDGET re-arm narrative (E-20260919 pattern); extra JSON field, survives state spread
}

const DEFAULT_STATE: RawCalState = {
  armed: false,
  armedAt: null,
  armedBy: "",
  disarmReason: null,
  disarmedAt: null,
  issued: 0,
  issuedTotal: 0,
  lastIssueAt: null,
  lastIssueSerial: null,
  target: RAWCAL_TARGET,
  spacingMin: DEFAULT_SPACING_MIN,
  maxOpen: DEFAULT_MAX_OPEN,
  autoLiftAt: null,
};

export async function getRawCalState(): Promise<RawCalState> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: RAWCAL_KEY } });
    if (!row) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...(JSON.parse(row.value) as Partial<RawCalState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// ── v9.2 ISSUANCE-BLOCK RING (observability) — why the issuer last paused ──
// maybeRawCalDeploy returns a note on every non-issue pass; the ring keeps the
// recent ones so the pace monitor can show WHY cadence paused (spacing rail,
// open cap, scan-no-candidate, feed-stale…). Duplicate identical notes inside
// 5min refresh the timestamp instead of stacking.
const blockRing: Array<{ t: number; note: string }> = [];
function noteRawCalBlock(note: string): void {
  const last = blockRing[blockRing.length - 1];
  if (last && last.note === note && Date.now() - last.t < 5 * 60_000) {
    last.t = Date.now();
    return;
  }
  blockRing.push({ t: Date.now(), note: note.slice(0, 90) });
  if (blockRing.length > 40) blockRing.shift();
}
export function getRawCalBlocks(n = 12): Array<{ t: number; note: string }> {
  return blockRing.slice(-n);
}

async function writeState(state: RawCalState): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: RAWCAL_KEY },
    create: { key: RAWCAL_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}

/** EPOCH-2 settled count — the exact number the R6 calibration lift reads. */
export async function epoch2SettledCount(): Promise<number> {
  return db.signal.count({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] }, tags: { contains: "EPOCH-2" } },
  });
}

export async function armRawCal(by = "OPERATOR"): Promise<RawCalState> {
  const cur = await getRawCalState();
  if (cur.armed) return cur;
  const state: RawCalState = {
    ...cur,
    armed: true,
    armedAt: new Date().toISOString(),
    armedBy: by,
    disarmReason: null,
    disarmedAt: null,
    issued: 0,
    autoLiftAt: null,
  };
  await writeState(state);
  touchRawcalHeartbeat(`ARMED by ${by.slice(0, 70)}`); // v10.20 — transition write (throttle bypassed on state change)
  const settledN = await epoch2SettledCount();
  const { fireEvent } = await import("./engine");
  await fireEvent(
    null,
    null,
    "ENGINE",
    "warn",
    `RAW-CAL CAPTURE MODE ARMED (${by}) — signal issuance now runs WITHOUT quality filters: every scan's best candidate is issued as a tagged RAW-CAL record (data capture + tracking + journaling only), feeding the engine-memory book toward the AI CALIBRATION bar (${settledN}/${state.target} EPOCH-2 settled). Anti-flood rails: ≥${state.spacingMin}min spacing, ≤${state.maxOpen} open raw records. The mode AUTO-CANCELS at ${state.target} settled and hands back to central-intelligence command with the new calibration.`,
  );
  const { sendDirect } = await import("./notify");
  void sendDirect(
    `🧪 <b>RAW-CAL CAPTURE MODE ARMED</b>\nUnfiltered signal issuance is now ON — every scan's best flow is recorded as a RAW-CAL signal (tracked + journaled, no quality filters).\n📊 Progress: <b>${settledN}/${state.target}</b> EPOCH-2 settled → AI CALIBRATION lift\n🛡 Rails: ≥${state.spacingMin}min spacing · ≤${state.maxOpen} open · auto-cancel at ${state.target}`,
  ).catch(() => undefined);
  void recordRawcalSnapshot("ARMED", true).catch(() => undefined);
  return state;
}

export async function disarmRawCal(reason: string, auto = false): Promise<RawCalState> {
  const cur = await getRawCalState();
  if (!cur.armed && !auto) return cur;
  const settledN = await epoch2SettledCount();
  const state: RawCalState = {
    ...cur,
    armed: false,
    disarmReason: reason,
    disarmedAt: new Date().toISOString(),
    ...(auto ? { autoLiftAt: new Date().toISOString() } : {}),
  };
  await writeState(state);
  touchRawcalHeartbeat(`IDLE ${auto ? "AUTO-LIFT" : "disarmed"} — ${reason.slice(0, 60)}`); // v10.20 — transition write
  const { fireEvent } = await import("./engine");
  await fireEvent(
    null,
    null,
    "ENGINE",
    "ai",
    `${auto ? "RAW-CAL LIFT — CAPTURE MODE AUTO-CANCELED" : "RAW-CAL CAPTURE MODE DISARMED"} (${reason}) — EPOCH-2 book ${settledN}/${cur.target} settled. All filtering, tracking and sizing return to CENTRAL-INTELLIGENCE command (governor + advisor + AI core) under the NEW calibration${
      settledN >= cur.target ? " — R6 freeze lifts at n≥100 and profit-first weights recalibrate over the full book including the RAW-CAL cohort" : ""
    }.`,
  );
  const { sendDirect } = await import("./notify");
  void sendDirect(
    `${auto ? "🎓 <b>RAW-CAL LIFT — CAPTURE COMPLETE</b>" : "⏹ <b>RAW-CAL MODE DISARMED</b>"}\n${reason}\n📊 EPOCH-2 book: <b>${settledN}/${cur.target}</b> settled${settledN >= cur.target ? " — AI CALIBRATION recalibrates over the full book (R6 lift)" : ""}\nFiltered operation returned to central-intelligence command.`,
  ).catch(() => undefined);
  void recordRawcalSnapshot(auto ? "AUTO-LIFT" : "DISARMED", true).catch(() => undefined);
  return state;
}

/**
 * Tick hook — engine.ts calls this every 10 ticks (fire-and-forget).
 * Issues ONE raw capture record when: armed, spacing respected, under the
 * open-record cap, and the target not yet reached.
 */
export async function maybeRawCalDeploy(): Promise<{ issued: boolean; serial?: number; note?: string }> {
  const state = await getRawCalState();
  // v10.20 — engine-native run heartbeat: the tick proves the run loop is ALIVE
  // every 10 ticks (idle/armed steady-state throttled to 1 line / 30min inside).
  touchRawcalHeartbeat(
    state.armed
      ? `ARMED issued=${state.issued}/${state.issuedTotal} target=${state.target}`
      : `IDLE disarmed by policy (target ${state.target})`,
  );
  if (!state.armed) {
    noteRawCalBlock("not armed");
    return { issued: false, note: "not armed" };
  }

  // 1) progress check FIRST — auto-cancel at the target
  const settledN = await epoch2SettledCount();
  if (settledN >= state.target) {
    await disarmRawCal(`target reached — ${settledN} EPOCH-2 settled ≥ ${state.target}`, true);
    const { refreshCalibration } = await import("./calibration");
    const { state: cal, auditLine } = await refreshCalibration();
    const { fireEvent } = await import("./engine");
    await fireEvent(
      null,
      null,
      "ENGINE",
      "ai",
      auditLine ?? `AI CALIBRATION post-RAW-CAL: status ${cal.status} over ${cal.settled} settled — ${cal.rows.length} moving factors ${cal.rows.map((r) => `${r.factor} ×${r.weight.toFixed(2)}`).join(" · ")}`,
    );
    return { issued: false, note: `auto-lifted at ${settledN}` };
  }

  // 2) spacing rail
  if (state.lastIssueAt && Date.now() - new Date(state.lastIssueAt).getTime() < state.spacingMin * 60_000) {
    noteRawCalBlock(`spacing rail — next window ≥ ${state.spacingMin}min`);
    return { issued: false, note: "spacing" };
  }

  // 3) open-records rail (RAW-CAL cohort only)
  const openRaw = await db.signal.count({
    where: { tags: { contains: "RAW-CAL" }, status: { in: ["ACTIVE", "TP1", "TP2"] } },
  });
  if (openRaw >= state.maxOpen) {
    noteRawCalBlock(`open-cap rail — ${openRaw}/${state.maxOpen} raw records in flight`);
    return { issued: false, note: `open cap ${openRaw}/${state.maxOpen}` };
  }

  // 4) issue the capture record through the engine scan (honesty rails stay
  //    hard inside deploySignal: feed-fresh guard + sim-price ban)
  const { deploySignal } = await import("./engine");
  const res = await deploySignal(undefined, undefined, { calCapture: true, triggerTag: "RAW-CAL" });
  if (!res.signal) {
    // rate-limit the "scan found nothing" chatter — one event / 30min
    noteRawCalBlock(`scan-no-candidate — ${res.error?.slice(0, 60) ?? "no setup"}`);
    const { fireEvent } = await import("./engine");
    const recent = await db.signalEvent.count({
      where: { type: "ENGINE", level: "info", message: { contains: "RAW-CAL: scan found no live candidate" }, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
    }).catch(() => 1);
    if (!recent) await fireEvent(null, null, "ENGINE", "info", `RAW-CAL: scan found no live candidate this window — ${res.error?.slice(0, 120) ?? "no setup"}`);
    return { issued: false, note: res.error?.slice(0, 80) };
  }

  // 5) journal the issue + update state
  const next: RawCalState = {
    ...state,
    issued: state.issued + 1,
    issuedTotal: state.issuedTotal + 1,
    lastIssueAt: new Date().toISOString(),
    lastIssueSerial: res.signal.serial,
  };
  await writeState(next);
  touchRawcalHeartbeat(`ISSUE NX-${String(res.signal.serial).padStart(4, "0")} raw open ${openRaw + 1}/${state.maxOpen}`); // v10.20 — always written (state change)
  void recordRawcalSnapshot(`ISSUE NX-${String(res.signal.serial).padStart(4, "0")}`, true).catch(() => undefined); // v9.2 — instant book-curve reaction
  const { fireEvent } = await import("./engine");
  const milestone = next.issued % 5 === 0 || settledN + 1 >= state.target;
  await fireEvent(
    null,
    res.signal.symbol,
    "ENGINE",
    milestone ? "ai" : "info",
    `RAW-CAL ISSUE #${next.issued} → NX-${String(res.signal.serial).padStart(4, "0")} ${res.signal.direction} ${res.signal.symbol} @ ${res.signal.entryPrice} (${res.signal.strategy}, score ${res.signal.confidence}%) — unfiltered capture record, tracked + journaled to ENGINE MEMORY · EPOCH-2 book ${settledN + 1}/${state.target} settled · open raw ${openRaw + 1}/${state.maxOpen}${settledN + 1 >= state.target ? " — TARGET REACHED, mode auto-cancels next tick" : ""}`,
  );
  return { issued: true, serial: res.signal.serial };
}

/** Compact status for pulse / API / engine-memory injection. */
export async function rawCalStatus() {
  const state = await getRawCalState();
  const [settledN, openRaw, totalRaw] = await Promise.all([
    epoch2SettledCount(),
    db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: ["ACTIVE", "TP1", "TP2"] } } }).catch(() => 0),
    db.signal.count({ where: { tags: { contains: "RAW-CAL" } } }).catch(() => 0),
  ]);
  const settledRaw = await db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } } }).catch(() => 0);
  const winsRaw = await db.signal.count({ where: { tags: { contains: "RAW-CAL" }, reachedTp: { gte: 1 } } }).catch(() => 0);
  return {
    ...state,
    settledN,
    needed: Math.max(0, state.target - settledN),
    openRaw,
    issuedTotal: totalRaw,
    settledRaw,
    winsRaw,
    rawWinRatePct: settledRaw ? Number((((winsRaw / settledRaw) * 100)).toFixed(1)) : null,
    spacingMin: state.spacingMin,
    maxOpen: state.maxOpen,
  };
}
