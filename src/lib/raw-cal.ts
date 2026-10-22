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
// EQ-99 (operator: «ماژول RAW-CAL چرا بطور دستی فعال نمی شود؟» 2026-10-13):
// a POST-graduation manual re-arm used to be AUTO-LIFTED within 10 ticks —
// the tick's graduation tripwire (settledN ≥ target + arms complete) has no
// concept of "the operator deliberately re-armed". Fix: a manual re-arm after
// graduation is a NEW CAPTURE CAMPAIGN — the book target moves ahead of the
// settled count by this batch so the tripwire stays dormant until the fresh
// evidence settles. 300 = the R6 refresh basis (calibration.ts recalibration
// window); operator-overridable via the API (clamped 50..2000).
const MANUAL_CAPTURE_BATCH_DEFAULT = 300;
export function clampManualBatch(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : NaN;
  if (!Number.isFinite(n)) return MANUAL_CAPTURE_BATCH_DEFAULT;
  return Math.min(2000, Math.max(50, n));
}

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
  manualCampaign?: boolean; // EQ-99 — this arm-run is an explicit operator re-campaign after graduation
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
    const raw = { ...DEFAULT_STATE, ...(JSON.parse(row.value) as Partial<RawCalState>) };
    // TASK-49 NAN-PROOF — a historic write escaped `target: settledN + NaN` into
    // JSON (NaN serializes to null), which made `settledN >= null` ALWAYS true
    // and pinned the arms-coupled extension branch on every pass. Sanitize on
    // read: any non-finite spacing/maxOpen/target heals to a sane value here,
    // so the loop can never be wedged by one bad write again.
    const num = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : dflt);
    return {
      ...raw,
      spacingMin: num(raw.spacingMin, DEFAULT_SPACING_MIN),
      maxOpen: num(raw.maxOpen, DEFAULT_MAX_OPEN),
      target: num(raw.target, RAWCAL_TARGET),
    };
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

export async function armRawCal(by = "OPERATOR", batch?: number): Promise<RawCalState> {
  const cur = await getRawCalState();
  if (cur.armed) return cur;
  const settledN = await epoch2SettledCount();
  // EQ-99 POST-GRADUATION RE-ARM CAMPAIGN — if the graduation tripwire condition
  // already holds (settledN ≥ target && arms complete), a plain re-arm would be
  // auto-lifted by the very next tick (line-proven 2026-10-13: settled 2376 ≥
  // target 2348 → tick calls disarmRawCal(auto) unconditionally). An operator
  // re-arm AFTER graduation is therefore a NEW CAPTURE CAMPAIGN: the target
  // moves settledN+batch so the auto-lift fires only when the FRESH batch has
  // settled — the operator's command sticks and the lift still re-runs the
  // R6 calibration over the grown book, unchanged.
  const campaign = settledN >= cur.target;
  const campaignTarget = campaign ? settledN + clampManualBatch(batch) : cur.target;
  const state: RawCalState = {
    ...cur,
    armed: true,
    armedAt: new Date().toISOString(),
    armedBy: by,
    disarmReason: null,
    disarmedAt: null,
    issued: 0,
    autoLiftAt: null,
    ...(campaign
      ? {
          target: campaignTarget,
          manualCampaign: true,
          retargetNote: `EQ-99 OPERATOR RE-ARM CAMPAIGN (${by}): graduation condition already held (${settledN} settled ≥ ${cur.target}) — a plain re-arm would be auto-lifted within 10 ticks. Book target moved +${campaignTarget - settledN} → ${campaignTarget} so this campaign captures FRESH evidence and the organic auto-lift + R6 recalibration fires at the new bar`,
        }
      : { manualCampaign: false }),
  };
  await writeState(state);
  touchRawcalHeartbeat(`ARMED by ${by.slice(0, 70)}${campaign ? ` (re-campaign → target ${campaignTarget})` : ""}`); // v10.20 — transition write (throttle bypassed on state change)
  const { fireEvent } = await import("./engine");
  await fireEvent(
    null,
    null,
    "ENGINE",
    "warn",
    `RAW-CAL CAPTURE MODE ARMED (${by}) — signal issuance now runs WITHOUT quality filters: every scan's best candidate is issued as a tagged RAW-CAL record (data capture + tracking + journaling only), feeding the engine-memory book toward the AI CALIBRATION bar (${settledN}/${state.target} EPOCH-2 settled)${campaign ? ` — EQ-99 RE-CAMPAIGN: graduation bar was already met, so this re-arm opens a FRESH capture batch (+${state.target - settledN}); auto-lift + R6 recalibration fires at the new bar` : ""}. Anti-flood rails: ≥${state.spacingMin}min spacing, ≤${state.maxOpen} open raw records. The mode AUTO-CANCELS at ${state.target} settled and hands back to central-intelligence command with the new calibration.`,
  );
  const { sendDirect } = await import("./notify");
  void sendDirect(
    `🧪 <b>RAW-CAL CAPTURE MODE ARMED</b>${campaign ? " — RE-CAMPAIGN" : ""}\nUnfiltered signal issuance is now ON — every scan's best flow is recorded as a RAW-CAL signal (tracked + journaled, no quality filters).\n📊 Progress: <b>${settledN}/${state.target}</b> EPOCH-2 settled → AI CALIBRATION lift${campaign ? ` (fresh batch +${state.target - settledN})` : ""}\n🛡 Rails: ≥${state.spacingMin}min spacing · ≤${state.maxOpen} open · auto-cancel at ${state.target}`,
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

  // 1) progress check FIRST — Task 34-2 ARMS-COUPLED AUTO-CANCEL (2026-09-26
  //    operator mandate: «RAW-CAL باید AI CALIBRATION BAR را تا زمان کامل شدن
  //    بازوهای Shadow veto فعال باشد و PACE MONITOR بر این اساس تنظیم شود»):
  //    the book target alone no longer lifts the capture. When the target is
  //    reached but the shadow-veto REAL evidence arms are still incomplete,
  //    the mode AUTO-EXTENDS its target by the arm deficit (audited retarget,
  //    EVID-BUDGET pattern) instead of disarming — the calibration book keeps
  //    growing while the veto evidence window stays open. Only when BOTH the
  //    book target is met AND the arms are complete (paper-veto waived in
  //    shadow mode — it structurally cannot fill) does the auto-lift fire.
  const settledN = await epoch2SettledCount();
  if (settledN >= state.target) {
    const sv = await import("./shadow-veto");
    const cfg = await sv.getShadowVetoConfig();
    // v11.5 hotfix (tsc-caught latent bug): shadowArmsCompletion is ASYNC —
    // the missing await made `completion` a Promise whose fields are all
    // undefined, so `!completion.allComplete` was ALWAYS true: the lift path
    // could never fire and the target auto-extended forever. Dormant only
    // because the mode is currently disarmed.
    const completion = await sv.shadowArmsCompletion(cfg.mode);
    if (!completion.allComplete) {
      // TASK-49 — NaN-proof: a stale compiled module (Turbopack chunk from the
      // pre-Task-34-2 snapshot) once returned a completion WITHOUT
      // note/pendingDeficit → Math.max(undefined)=NaN → target NaN → JSON null
      // → this branch pinned forever (repeating "[raw-cal] slice of undefined").
      // Guard every unknown now.
      const deficit = Number.isFinite(completion.pendingDeficit) ? completion.pendingDeficit : 10;
      const extension = Math.max(deficit, 10);
      const note = completion.note ?? "arms probe shape mismatch — treated as incomplete";
      const nextTarget = Number.isFinite(settledN + extension) ? settledN + extension : state.target + extension;
      const next: RawCalState = {
        ...state,
        target: nextTarget,
        retargetNote: `ARMS-COUPLED EXTENSION (operator mandate 2026-09-26 «تا زمان کامل شدن بازوهای Shadow veto فعال باشد»): book target ${state.target} reached but shadow-veto real arms incomplete (${note}) — target auto-extended +${extension} to ${nextTarget} so the capture keeps feeding evidence; PACE MONITOR tracks arm completion`,
      };
      await writeState(next);
      touchRawcalHeartbeat(`ARM-EXTEND target ${state.target}→${next.target} (${note.slice(0, 80)})`);
      const { fireEvent } = await import("./engine");
      await fireEvent(null, null, "ENGINE", "info", `RAW-CAL: book target reached (${settledN}) but shadow-veto arms incomplete — capture AUTO-EXTENDED +${extension} (target → ${next.target}). Arms: ${(completion.arms ?? []).map((a) => `${a.id} ${a.n}/${a.target}${a.waived ? " (waived)" : ""}`).join(" · ")}`);
      return { issued: false, note: `arms-coupled extension → target ${next.target}` };
    }
    await disarmRawCal(`target reached + shadow-veto arms complete — ${settledN} EPOCH-2 settled ≥ ${state.target}`, true);
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
    return { issued: false, note: `auto-lifted at ${settledN} (arms complete)` };
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

// ── v11.5 CAPTURE-BOOK REGIME GAUGE (operator question 2026-10-12: «آیا
// رژیم‌سنجی قبل از اعتماد به کتاب کپچر اضافه شده؟») ──
// Two-part engineering answer, both auditable:
//   1) AT ISSUE TIME — the LAYER-0 regime ruling (regimeRuling, engine.ts
//      evaluate()) is NOT bypassed by calCapture: a candidate standing in a
//      vetoed regime (BREAKOUT/MOMENTUM in chop at guard L1, counter-trend
//      mean-revert in trends) never becomes a capture row. Every issued row
//      then carries its REGIME-* tag for life.
//   2) BEFORE TRUSTING THE BOOK — the settled capture book is split BY REGIME
//      (n / WR / net $) so the operator and the AI core trust capture-derived
//      conclusions per regime, not book-wide (a CHOP-heavy book must never be
//      read as a trend verdict). Surfaced on /api/rawcal + RawCalCard.
const REGIME_LABELS: Record<string, string> = {
  "TREND-UP": "TREND ▲",
  "TREND-DOWN": "TREND ▼",
  CHOP: "CHOP ∿",
  VOLATILE: "VOLATILE ⚡",
  UNKNOWN: "UNKNOWN",
};
export interface RawCalRegimeCell {
  regime: string;
  label: string;
  n: number;
  wins: number;
  winRatePct: number;
  netUsd: number;
}
export async function captureBookRegimeSplit(): Promise<RawCalRegimeCell[]> {
  const rows = await db.signal.findMany({
    where: { tags: { contains: "RAW-CAL" }, status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { tags: true, status: true, reachedTp: true, marginUsd: true, pnlPercent: true },
  });
  const map = new Map<string, { n: number; wins: number; net: number }>();
  for (const r of rows) {
    const tag = r.tags?.split(",").find((t) => t.startsWith("REGIME-"))?.replace("REGIME-", "") ?? "UNKNOWN";
    const cell = map.get(tag) ?? { n: 0, wins: 0, net: 0 };
    cell.n += 1;
    if (r.reachedTp >= 1 || r.status === "TP1" || r.status === "TP2" || r.status === "TP3") cell.wins += 1;
    cell.net += (r.marginUsd * r.pnlPercent) / 100;
    map.set(tag, cell);
  }
  return [...map.entries()]
    .map(([regime, c]) => ({
      regime,
      label: REGIME_LABELS[regime] ?? regime,
      n: c.n,
      wins: c.wins,
      winRatePct: c.n ? Number(((c.wins / c.n) * 100).toFixed(1)) : 0,
      netUsd: Number(c.net.toFixed(2)),
    }))
    .sort((a, b) => b.n - a.n);
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
  // Task 34-2 — ARMS-COUPLED PACE: the AI CALIBRATION bar now reports the
  // shadow-veto arm completion it is geared to (operator mandate 2026-09-26);
  // fail-soft: any probe error keeps the block null instead of breaking status.
  const armsCompletion = await import("./shadow-veto")
    .then(async (m) => m.shadowArmsCompletion((await m.getShadowVetoConfig()).mode))
    .catch(() => null);
  // v11.5 capture-book regime gauge (operator question: رژیم‌سنجی قبل از اعتماد)
  const regimeSplit = await captureBookRegimeSplit().catch(() => []);
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
    armsCompletion,
    regimeSplit,
  };
}
