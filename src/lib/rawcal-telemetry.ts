// ── v9.2 RAW-CAL PACE MONITOR — engineering observability for the capture run ──
// Operator mandate 2026-09-13: «پایش ریتم صدور RAW-CAL و رشد کتاب EPOCH-2 به
// سمت ۱۰۰. رو کامل و مهندسی انجام بده» — monitor the RAW-CAL issuance rhythm
// and the growth of the EPOCH-2 book toward the 100-settled calibration bar.
//
// THREE PERSISTED INSTRUMENTS:
//  1) SNAPSHOT JOURNAL — .data/rawcal-telemetry.jsonl, one row every ~10min
//     (self-throttled; force on state jumps): {t, issued, issuedTotal,
//     settledE2, openRaw, settledRaw, winsRaw, note?} — the book-growth curve
//     the UI sparkline and rate math read. Trimmed to the last 4000 rows.
//  2) PACE ENGINE — rolling rates from the journal + the DB ledger:
//     issue rate/h (3h + since-armed), settle rate/h (3h + 6h), observed mean
//     spacing between raw issues (DB createdAt diffs), ETA to the 100 bar at
//     the current settle rate, pipeline projection (open raw records that will
//     still settle), mean book settle-time, and stall detection.
//  3) MILESTONE LEDGER — idempotent audited events at 50/60/70/80/90/95/100
//     (EngineSetting "rawcal.milestones"); Telegram only for 90/95/100 (the
//     100 announcement itself stays with the auto-lift in raw-cal.ts).
//
// STALL SEMANTICS (honest, rail-aware):
//  · issue stall  = armed && openRaw < maxOpen && now − lastIssueAt >
//    max(45min, 3 × spacingMin) — issuance SHOULD have produced a record.
//  · settle stall = openRaw > 0 && no EPOCH-2 settle in the last 3h.
//  Neither fires when the open-cap rail is the legitimate blocker.

import { promises as fs } from "fs";
import path from "path";
import { db } from "./db";

export const RAWCAL_TELEMETRY_FILE = path.join(process.cwd(), ".data", "rawcal-telemetry.jsonl");
const MILESTONES_KEY = "rawcal.milestones";
const SETTLED_STATUSES = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];
export const RAWCAL_MILESTONE_STEPS = [50, 60, 70, 80, 90, 95, 100] as const;
const TELEGRAM_MILESTONES = new Set<number>([90, 95, 100]);
const MAX_JOURNAL_ROWS = 4000;

export interface RawcalSnapshot {
  t: string; // ISO
  issued: number; // raw records issued while armed (this arm-run)
  issuedTotal: number; // lifetime raw records
  settledE2: number; // EPOCH-2 settled book (the calibration bar)
  openRaw: number;
  settledRaw: number;
  winsRaw: number;
  note?: string; // optional annotation (arm/issue/lift jumps)
}

export interface RawcalMilestones {
  fired: Record<string, string>; // "50" → ISO at fire time
}

// ── memo caches (pulse-safe; these run on hot paths) ──
let lastSnapshotAt = 0;
let paceCache: { at: number; data: RawcalPace } | null = null;
const PACE_TTL_MS = 30_000;

async function readJournal(): Promise<RawcalSnapshot[]> {
  try {
    const txt = await fs.readFile(RAWCAL_TELEMETRY_FILE, "utf8");
    const rows: RawcalSnapshot[] = [];
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        rows.push(JSON.parse(s) as RawcalSnapshot);
      } catch {
        /* skip torn line */
      }
    }
    return rows.slice(-MAX_JOURNAL_ROWS);
  } catch {
    return [];
  }
}

async function appendJournal(row: RawcalSnapshot): Promise<void> {
  try {
    await fs.mkdir(path.dirname(RAWCAL_TELEMETRY_FILE), { recursive: true });
    await fs.appendFile(RAWCAL_TELEMETRY_FILE, JSON.stringify(row) + "\n", "utf8");
    // opportunistic trim (cheap: only when the file grows past 2× the cap)
    try {
      const st = await fs.stat(RAWCAL_TELEMETRY_FILE);
      if (st.size > MAX_JOURNAL_ROWS * 180) {
        const rows = await readJournal();
        await fs.writeFile(RAWCAL_TELEMETRY_FILE, rows.slice(-MAX_JOURNAL_ROWS).map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      }
    } catch {
      /* trim best-effort */
    }
  } catch (e) {
    console.error("[rawcal-telemetry] journal append failed", e);
  }
}

/**
 * Tick hook — engine.ts calls this every 20 ticks (fire-and-forget).
 * Self-throttled to one journal row / 10min; callers may force a row with a
 * note (arm/disarm/issue) via `note` + `force`.
 */
export async function recordRawcalSnapshot(note?: string, force = false): Promise<RawcalSnapshot | null> {
  const now = Date.now();
  if (!force && now - lastSnapshotAt < 10 * 60_000) return null;
  lastSnapshotAt = now;
  try {
    const [settledE2, openRaw, totalRaw, settledRaw, winsRaw] = await Promise.all([
      db.signal.count({ where: { status: { in: SETTLED_STATUSES }, tags: { contains: "EPOCH-2" } } }),
      db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: ["ACTIVE", "TP1", "TP2"] } } }),
      db.signal.count({ where: { tags: { contains: "RAW-CAL" } } }),
      db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: SETTLED_STATUSES } } }),
      db.signal.count({ where: { tags: { contains: "RAW-CAL" }, reachedTp: { gte: 1 } } }),
    ]);
    const snap: RawcalSnapshot = {
      t: new Date(now).toISOString(),
      issued: 0,
      issuedTotal: totalRaw,
      settledE2,
      openRaw,
      settledRaw,
      winsRaw,
      ...(note ? { note: note.slice(0, 80) } : {}),
    };
    // issued-this-run: cheap read of the state key (no import cycle — raw-cal
    // imports telemetry, not vice versa)
    try {
      const s = await db.engineSetting.findUnique({ where: { key: "rawcal.state" } });
      if (s) snap.issued = (JSON.parse(s.value) as { issued?: number }).issued ?? 0;
    } catch {
      /* optional field */
    }
    await appendJournal(snap);
    paceCache = null; // fresh data → invalidate pace memo
    return snap;
  } catch (e) {
    console.error("[rawcal-telemetry] snapshot failed", e);
    return null;
  }
}

export interface RawcalPace {
  armed: boolean;
  armedAt: string | null;
  settledE2: number;
  needed: number;
  target: number;
  // issuance rhythm
  issueRate3hPerH: number; // raw records issued in the last 3h / 3
  issueRateSinceArmPerH: number;
  observedSpacingMin: { mean: number | null; min: number | null; max: number | null; samples: number };
  lastIssueAt: string | null;
  lastIssueSerial: number | null;
  openRaw: number;
  openE2: number; // ALL open EPOCH-2 records (raw + filtered) — pipeline that will still settle
  maxOpen: number;
  spacingMin: number;
  // book growth
  settleRate3hPerH: number;
  settleRate6hPerH: number;
  meanSettleMin: number | null; // createdAt→closedAt over the last 20 EPOCH-2 settles
  winsRaw: number;
  settledRaw: number;
  rawWinRatePct: number | null;
  // projection + stalls
  etaHours: number | null; // needed / settleRate3h (null when no settle signal yet)
  etaAt: string | null;
  // v9.2.1 pipeline-aware projection — the raw pipeline keeps issuing at the
  // since-arm cadence, capped by settle throughput (open-slot cap ÷ mean settle
  // time). Honest fill-window under sustained cadence, not the blended 3h lag.
  steadyRatePerH: number | null;
  etaSteadyHours: number | null;
  etaSteadyAt: string | null;
  pipelineProjection: number; // settledE2 + openE2 (records already born that will settle)
  cadenceGrade: "A" | "B" | "C" | "D" | "OFF";
  stalls: { issueStallMin: number | null; settleStallMin: number | null; lastBlockNote: string | null };
  sparkline: Array<{ t: string; v: number }>; // settledE2 over the journal window (downsampled)
  journalRows: number;
}

/** Rolling pace + projection + stall detection (30s memo). */
export async function computeRawcalPace(blocks?: { t: number; note: string }[]): Promise<RawcalPace> {
  if (paceCache && Date.now() - paceCache.at < PACE_TTL_MS && !blocks) return paceCache.data;
  const state = await getRawcalStateSafe();
  const now = Date.now();

  const [settledE2, openRaw, openE2, maxOpen] = await Promise.all([
    db.signal.count({ where: { status: { in: SETTLED_STATUSES }, tags: { contains: "EPOCH-2" } } }),
    db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: ["ACTIVE", "TP1", "TP2"] } } }),
    db.signal.count({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] }, tags: { contains: "EPOCH-2" } } }),
    Promise.resolve(state.maxOpen),
  ]);
  const target = state.target;

  // issuance ledger (raw rows from the DB itself — ground truth)
  const rawRows = await db.signal.findMany({
    where: { tags: { contains: "RAW-CAL" } },
    select: { serial: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const issueTimes = rawRows.map((r) => r.createdAt.getTime());
  const h3 = now - 3 * 3600_000;
  const issues3h = issueTimes.filter((t) => t >= h3).length;
  const armMs = state.armedAt ? new Date(state.armedAt).getTime() : null;
  const issuesSinceArm = armMs ? issueTimes.filter((t) => t >= armMs).length : 0;
  const armHours = armMs ? Math.max(1 / 60, (now - armMs) / 3600_000) : null;

  const diffs = issueTimes.slice(1).map((t, i) => t - issueTimes[i]);
  const meanDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;

  // book-growth ledger (EPOCH-2 settles with closedAt)
  const settles = await db.signal.findMany({
    where: { status: { in: SETTLED_STATUSES }, tags: { contains: "EPOCH-2" }, closedAt: { not: null } },
    select: { closedAt: true, createdAt: true },
    orderBy: { closedAt: "desc" },
    take: 120,
  });
  const settleTimes = settles.map((r) => r.closedAt!.getTime()).reverse(); // asc
  const settles3h = settleTimes.filter((t) => t >= h3).length;
  const settles6h = settleTimes.filter((t) => t >= now - 6 * 3600_000).length;
  const recent20 = settles.slice(0, 20);
  const meanSettleMin = recent20.length
    ? recent20.reduce((a, r) => a + (r.closedAt!.getTime() - r.createdAt.getTime()), 0) / recent20.length / 60_000
    : null;

  const [settledRaw, winsRaw] = await Promise.all([
    db.signal.count({ where: { tags: { contains: "RAW-CAL" }, status: { in: SETTLED_STATUSES } } }),
    db.signal.count({ where: { tags: { contains: "RAW-CAL" }, reachedTp: { gte: 1 } } }),
  ]);

  const settleRate3h = settles3h / 3;
  const needed = Math.max(0, target - settledE2);
  const etaHours = needed === 0 ? 0 : settleRate3h > 0 ? needed / settleRate3h : null;

  // v9.2.1 steady-state projection — raw cadence ∩ settle-throughput cap.
  // throughputCap = maxOpen concurrent records / mean settle hours; the real
  // fill window is needed / min(issueCadence, throughputCap). Only computed
  // when meanSettleMin is known (honest — no invented throughput).
  const issueSinceArmRateRaw = armHours ? issuesSinceArm / armHours : 0;
  const throughputCapPerH = meanSettleMin !== null && meanSettleMin > 0 ? maxOpen / (meanSettleMin / 60) : null;
  const steadyRatePerH = throughputCapPerH !== null ? Math.min(issueSinceArmRateRaw, throughputCapPerH) : null;
  const etaSteadyHours = needed === 0 ? 0 : steadyRatePerH !== null && steadyRatePerH > 0 ? needed / steadyRatePerH : null;

  // stalls (rail-aware — see header)
  const issueStallMin =
    state.armed && openRaw < maxOpen && state.lastIssueAt
      ? Math.max(0, (now - new Date(state.lastIssueAt).getTime()) / 60_000)
      : null;
  const issueStallActive = issueStallMin !== null && issueStallMin > Math.max(45, 3 * state.spacingMin);
  const lastSettleAt = settleTimes.length ? settleTimes[settleTimes.length - 1] : null;
  const settleStallMin = openRaw > 0 && lastSettleAt ? Math.max(0, (now - lastSettleAt) / 60_000) : null;
  const settleStallActive = settleStallMin !== null && settleStallMin > 180;

  // cadence grade — honest banding of the ISSUE rhythm while armed.
  // v9.2.1 arm-age-aware: inside the first 3h after arming the 3h window still
  // contains pre-RAW-CAL filtered flow (rate lag) → grade on the since-arm
  // cadence instead; afterwards both windows agree and 3h is used.
  const issueRate3hPerH = issues3h / 3;
  let cadenceGrade: RawcalPace["cadenceGrade"] = "OFF";
  if (state.armed) {
    const baseRate = armHours !== null && armHours < 3 ? issueSinceArmRateRaw : issueRate3hPerH;
    const effRate = issueStallActive ? 0 : baseRate;
    cadenceGrade = effRate >= 3 ? "A" : effRate >= 1.5 ? "B" : effRate >= 0.5 ? "C" : "D";
  }

  // sparkline from the journal (downsample to ≤48 points)
  // v9.4.2 NaN guard: journal gap rows can carry non-finite settledE2 — skip
  // them here so the client never receives NaN chart values.
  const journal = await readJournal();
  const series = journal.length > 1 ? journal : journal.length === 1 ? [{ t: new Date(now).toISOString(), settledE2 } as RawcalSnapshot] : [];
  const step = Math.max(1, Math.ceil(series.length / 48));
  const sparkline: Array<{ t: string; v: number }> = [];
  for (let i = 0; i < series.length; i += step) {
    const v = series[i].settledE2;
    if (!Number.isFinite(v)) continue;
    sparkline.push({ t: series[i].t, v });
  }
  if (sparkline.length && Number.isFinite(settledE2) && sparkline[sparkline.length - 1].v !== settledE2) sparkline.push({ t: new Date(now).toISOString(), v: settledE2 });

  const lastBlockNote = blocks && blocks.length ? blocks[blocks.length - 1].note : null;

  const pace: RawcalPace = {
    armed: state.armed,
    armedAt: state.armedAt,
    settledE2,
    needed,
    target,
    issueRate3hPerH: round2(issueRate3hPerH),
    issueRateSinceArmPerH: armHours ? round2(issuesSinceArm / armHours) : 0,
    observedSpacingMin: {
      mean: meanDiff !== null ? round2(meanDiff / 60_000) : null,
      min: diffs.length ? round2(Math.min(...diffs) / 60_000) : null,
      max: diffs.length ? round2(Math.max(...diffs) / 60_000) : null,
      samples: diffs.length,
    },
    lastIssueAt: state.lastIssueAt,
    lastIssueSerial: state.lastIssueSerial,
    openRaw,
    openE2,
    maxOpen,
    spacingMin: state.spacingMin,
    settleRate3hPerH: round2(settleRate3h),
    settleRate6hPerH: round2(settles6h / 6),
    meanSettleMin: meanSettleMin !== null ? Math.round(meanSettleMin) : null,
    winsRaw,
    settledRaw,
    rawWinRatePct: settledRaw ? Number(((winsRaw / settledRaw) * 100).toFixed(1)) : null,
    etaHours: etaHours !== null ? round2(etaHours) : null,
    etaAt: etaHours !== null ? new Date(now + etaHours * 3600_000).toISOString() : null,
    steadyRatePerH: steadyRatePerH !== null ? round2(steadyRatePerH) : null,
    etaSteadyHours: etaSteadyHours !== null ? round2(etaSteadyHours) : null,
    etaSteadyAt: etaSteadyHours !== null ? new Date(now + etaSteadyHours * 3600_000).toISOString() : null,
    pipelineProjection: settledE2 + openE2,
    cadenceGrade,
    stalls: {
      issueStallMin: issueStallActive ? Math.round(issueStallMin!) : null,
      settleStallMin: settleStallActive ? Math.round(settleStallMin!) : null,
      lastBlockNote,
    },
    sparkline,
    journalRows: journal.length,
  };
  if (!blocks) paceCache = { at: Date.now(), data: pace };
  return pace;
}

async function getRawcalStateSafe() {
  try {
    const { getRawCalState } = await import("./raw-cal");
    return await getRawCalState();
  } catch {
    return { armed: false, armedAt: null, lastIssueAt: null, lastIssueSerial: null, target: 100, spacingMin: 12, maxOpen: 8 } as Awaited<ReturnType<typeof import("./raw-cal").getRawCalState>>;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── MILESTONE LEDGER ──

async function readMilestones(): Promise<RawcalMilestones> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: MILESTONES_KEY } });
    if (!row) return { fired: {} };
    return JSON.parse(row.value) as RawcalMilestones;
  } catch {
    return { fired: {} };
  }
}

/**
 * Tick hook (idempotent) — fires one audited event per newly-crossed
 * milestone; Telegram only for 90/95/100. Returns milestones fired this call.
 */
export async function checkRawcalMilestones(): Promise<Array<{ step: number; at: string }>> {
  const settledE2 = await db.signal
    .count({ where: { status: { in: SETTLED_STATUSES }, tags: { contains: "EPOCH-2" } } })
    .catch(() => 0);
  const m = await readMilestones();
  const firedNow: Array<{ step: number; at: string }> = [];
  for (const step of RAWCAL_MILESTONE_STEPS) {
    const key = String(step);
    if (settledE2 < step || m.fired[key]) continue;
    const at = new Date().toISOString();
    m.fired[key] = at;
    firedNow.push({ step, at });
    const isBar = step === 100;
    const { fireEvent } = await import("./engine");
    await fireEvent(
      null,
      null,
      "ENGINE",
      "ai",
      `RAW-CAL MILESTONE ${step}/${100} — EPOCH-2 book at ${settledE2} settled${isBar ? " — calibration bar REACHED, capture mode hands back to central-intelligence command (new calibration)" : ` · ${100 - settledE2} records remain to the AI CALIBRATION bar`}`,
    ).catch(() => undefined);
    if (TELEGRAM_MILESTONES.has(step) && !(isBar && stateHasAutoLift())) {
      const { sendDirect } = await import("./notify");
      void sendDirect(
        `📈 <b>RAW-CAL MILESTONE ${step}/100</b>\nEPOCH-2 book: <b>${settledE2}/100</b> settled${isBar ? " — AI CALIBRATION lift imminent" : ` · ${100 - settledE2} to go`}\n${progressBar(settledE2)}`,
      ).catch(() => undefined);
    }
  }
  if (firedNow.length) {
    await db.engineSetting
      .upsert({ where: { key: MILESTONES_KEY }, create: { key: MILESTONES_KEY, value: JSON.stringify(m) }, update: { value: JSON.stringify(m) } })
      .catch(() => undefined);
  }
  return firedNow;
}

async function stateHasAutoLift(): Promise<boolean> {
  try {
    const { getRawCalState } = await import("./raw-cal");
    return !!(await getRawCalState()).autoLiftAt;
  } catch {
    return false;
  }
}

function progressBar(n: number): string {
  const filled = Math.round((Math.min(100, n) / 100) * 20);
  return "▰".repeat(filled) + "▱".repeat(20 - filled);
}

/** Milestone view for the API/UI: fired-at map + current book position. */
export async function milestoneView(): Promise<{ steps: Array<{ step: number; fired: boolean; at: string | null; pending: boolean }>; settledE2: number }> {
  const [m, settledE2] = await Promise.all([
    readMilestones(),
    db.signal.count({ where: { status: { in: SETTLED_STATUSES }, tags: { contains: "EPOCH-2" } } }).catch(() => 0),
  ]);
  return {
    steps: RAWCAL_MILESTONE_STEPS.map((step) => ({
      step,
      fired: !!m.fired[String(step)],
      at: m.fired[String(step)] ?? null,
      pending: settledE2 < step,
    })),
    settledE2,
  };
}

/** Last N issuance-block notes (from the in-memory ring in raw-cal.ts). */
export async function recentBlocks(n = 12): Promise<Array<{ t: number; note: string }>> {
  try {
    const { getRawCalBlocks } = await import("./raw-cal");
    return getRawCalBlocks(n);
  } catch {
    return [];
  }
}

// ── v9.2.1 STALL ALARM — push the rhythm break, don't just display it ──
// Tick hook (idempotent, 2h cooldown per stall type). Fires when the armed
// issuer SHOULD have produced (issue stall) or the in-flight pipeline SHOULD
// have settled (settle stall) and didn't. Process-death is covered by the P0
// watchdog + keep-alive crons; this alarm covers "alive but rhythm broken".
const STALL_ALERT_KEY = "rawcal.stallAlerts";
const STALL_COOLDOWN_MS = 2 * 3600_000;

export async function checkRawcalStallAlarm(): Promise<boolean> {
  try {
    const pace = await computeRawcalPace().catch(() => null);
    if (!pace || !pace.armed) return false;
    const issues: string[] = [];
    if (pace.stalls.issueStallMin)
      issues.push(`issue stall — no raw record for ${pace.stalls.issueStallMin}min while armed and open ${pace.openRaw}/${pace.maxOpen}`);
    if (pace.stalls.settleStallMin)
      issues.push(`settle stall — no EPOCH-2 settle for ${pace.stalls.settleStallMin}min with ${pace.openRaw} raw in flight`);
    if (!issues.length) return false;

    let fired: Record<string, string> = {};
    try {
      const row = await db.engineSetting.findUnique({ where: { key: STALL_ALERT_KEY } });
      if (row) fired = (JSON.parse(row.value) as { fired?: Record<string, string> }).fired ?? {};
    } catch {
      /* fresh ledger */
    }
    const now = Date.now();
    const send: string[] = [];
    for (const it of issues) {
      const k = it.startsWith("issue") ? "issue" : "settle";
      const last = fired[k] ? new Date(fired[k]).getTime() : 0;
      if (now - last > STALL_COOLDOWN_MS) {
        fired[k] = new Date(now).toISOString();
        send.push(it);
      }
    }
    if (!send.length) return false;
    await db.engineSetting
      .upsert({ where: { key: STALL_ALERT_KEY }, create: { key: STALL_ALERT_KEY, value: JSON.stringify({ fired }) }, update: { value: JSON.stringify({ fired }) } })
      .catch(() => undefined);
    const { fireEvent } = await import("./engine");
    await fireEvent(null, null, "ENGINE", "warn", `RAW-CAL PACE ALARM — ${send.join(" · ")} · book ${pace.settledE2}/${pace.target} · cadence ${pace.cadenceGrade}`).catch(() => undefined);
    const { sendDirect } = await import("./notify");
    void sendDirect(
      `⏱ <b>RAW-CAL PACE ALARM</b>\n${send.map((s) => `• ${s}`).join("\n")}\n📊 Book: <b>${pace.settledE2}/${pace.target}</b> settled · cadence ${pace.cadenceGrade} · open raw ${pace.openRaw}/${pace.maxOpen}`,
    ).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}
