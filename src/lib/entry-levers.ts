// ── v11.3 ENTRY-LEVERS — the late-entry shield (operator mandate 2026-10-07
// «کامل و مهندسی شده اجرا کن» after the EQ-89/EQ-90 forensics) ──
// DIAGNOSIS (14d ledger, n=1183 settled clean rows): the book does not lose to
// noisy/fake flow data — it loses to SYSTEMATIC LATE ENTRIES. Measured layers:
//   · flow confirmation barely separates (CONFIRMS 30.7% WR vs NEUTRAL 31.6%)
//     and STRONG along-direction flow is negative (score ≥+10: avg −1.73, 55%
//     never reached +5%) — visible agreement is already priced in;
//   · entry extension degrades monotonically: |EMA9−EMA21 trend| ≥60×ATR
//     avg −2.57, ≥120×ATR avg −3.55; worst quadrant lev≥15 × ext≥60 avg −4.74;
//   · chase causes die: WHALE-PUSH WR 13% (n=23), VOL-ONSET↑ WR 10% (n=10,
//     avg −9.37), SESSION-THIN WR 15% (n=13); stale radar fills (>8s) WR 15.8%
//     vs ≤2s 44%; AI-SCALP rows never reached +5% in 66..69% of cases;
//   · leverage ≥15 carried net −696 units (risk-shaping lever, not a veto).
// NOTE (direction-relative audit EQ-90): absolute-sign factor buckets were
// confounded by direction mix — EMA/MACD/VOLUME-CONFIRM vote SIGNS do NOT
// separate once measured relative to trade direction. The shield therefore
// uses ONLY sign-agnostic measurements (extension magnitude, cause labels,
// staleness, leverage, strategy) plus the flow score, which is
// direction-aligned by construction (FlowAssessment: −25..+25 along direction).
// ROLLOUT DOCTRINE = shadow first, evidence-gated enforcement — the same
// ladder as volCause LEARN_GATE and shadow-veto: every deploy is evaluated by
// EVERY lever and journaled; a lever may only enforce after its OWN statistical
// gate passes on settled rows (n≥100 · flagged avg ≤ −0.5 · separation ≥0.5 vs
// unflagged) and is auto-demoted when its flagged cohort heals (avg > +0.3).
// Forced / capture-authority deploys are OBSERVE-ONLY — the shield never
// fights the operator. Fail-open everywhere: an evaluator error must never
// stall a deploy.

import { appendFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import type { FactorVote } from "@/lib/indicators";

export type EntryLeverId = "EXT" | "FLOW" | "CAUSE" | "STALE" | "SCALP" | "LEVCAP" | "MOMENTUM";
export type EntryLeverMode = "shadow" | "enforce" | "off";

export const ENTRY_LEVER_IDS: EntryLeverId[] = ["EXT", "FLOW", "CAUSE", "STALE", "SCALP", "LEVCAP", "MOMENTUM"];

export const ENTRY_LEVER_LABELS: Record<EntryLeverId, string> = {
  EXT: "EXTENSION — stretched entry (|EMA trend| ≥ N×ATR at deploy)",
  FLOW: "CROWDED-FLOW — strong along-direction flow at deploy (score ≥ +N)",
  CAUSE: "CHASE-CAUSE — whale-push / vol-onset / session-thin tape",
  STALE: "STALE-DETECTION — radar fill paid >N ms after detection",
  SCALP: "SCALP-VALVE — AI-SCALP needs +N extra effective score",
  LEVCAP: "LEV-CAP — leverage trimmed to ≤N×",
  // v11.4 7th lever — the EQ-93 TIGHTEN alternative: per-strategy valve with an
  // INDEPENDENT statistical gate (the advisor's minScore 12→17 was rejected:
  // fee-aware counterfactual showed ΔΣnet NEGATIVE at every raise post-shield,
  // and MOMENTUM cohort n=3–6 is not decision-grade). Shadow journals the
  // cohort; the ladder enforces only when MOMENTUM's OWN gate passes.
  MOMENTUM: "MOMENTUM-VALVE — MOMENTUM needs +N extra effective score",
};

export interface EntryLeverParams {
  extAtr: number; // EXT veto threshold, ×ATR
  flowScoreMin: number; // FLOW veto threshold (along-direction score)
  badCauses: string[]; // CAUSE blacklist (VOL-CAUSE labels)
  staleMs: number; // STALE threshold (detection age / fill latency)
  scalpBonus: number; // SCALP effective-threshold bonus
  momentumBonus: number; // MOMENTUM effective-threshold bonus (v11.4 7th lever)
  levCap: number; // LEVCAP maximum leverage
  windowDays: number; // stats window (rolling)
  promoteMinN: number; // gate: settled flagged rows before promotion
  promoteMaxFlagAvg: number; // gate: flagged cohort avg must be ≤ this
  promoteMinSep: number; // gate: unflagged − flagged avg separation
  demoteFlagAvg: number; // auto-demote when flagged avg heals above this
}

export const DEFAULT_LEVER_PARAMS: EntryLeverParams = {
  extAtr: 60,
  flowScoreMin: 10,
  badCauses: ["WHALE-PUSH", "VOL-ONSET↑", "SESSION-THIN"],
  staleMs: 8000,
  scalpBonus: 5,
  momentumBonus: 3,
  levCap: 14,
  windowDays: 14,
  promoteMinN: 100,
  promoteMaxFlagAvg: -0.5,
  promoteMinSep: 0.5,
  demoteFlagAvg: 0.3,
};

interface LeverConfig {
  modes: Record<EntryLeverId, EntryLeverMode>;
  params: EntryLeverParams;
  updatedAt: string;
  autoNotes: string[];
  manual: Partial<Record<EntryLeverId, boolean>>; // operator-pinned levers — the auto ladder never touches them
}

const MODES_KEY = "entry-levers";
const CONFIG_CACHE_MS = 60_000;
const STATS_CACHE_MS = 300_000;
const JOURNAL_MAX_BYTES = 5_000_000;
const JOURNAL_FILE = path.join(process.cwd(), ".data", "entry-levers.jsonl");

let configCache: { at: number; cfg: LeverConfig } | null = null;
let statsCache: { at: number; stats: EntryLeverStats } | null = null;

function defaultConfig(): LeverConfig {
  return {
    modes: { EXT: "shadow", FLOW: "shadow", CAUSE: "shadow", STALE: "shadow", SCALP: "shadow", LEVCAP: "shadow", MOMENTUM: "shadow" },
    params: { ...DEFAULT_LEVER_PARAMS, badCauses: [...DEFAULT_LEVER_PARAMS.badCauses] },
    updatedAt: new Date().toISOString(),
    autoNotes: [],
    manual: {},
  };
}

// ─────────────────────────────────────────────────────────────
// Evaluation — pure, shared by the deploy gate AND the ledger stats
// ─────────────────────────────────────────────────────────────

export interface EntryLeverCtx {
  symbol: string;
  direction: "LONG" | "SHORT";
  strategy: string;
  votes: FactorVote[];
  flowScore: number | null; // along-direction flow score at deploy
  volCause: string | null;
  leverage: number;
  detectionAgeMs: number | null; // decision: now−detectedAt · stats: fill latencyMs
  adjScore: number; // decision only — stats side passes 0 (SCALP fires on strategy alone)
  effMin: number; // decision only — stats side passes 0
}

export interface EntryLeverVerdict {
  lever: EntryLeverId;
  fired: boolean;
  measurable: boolean;
  value: number | null; // the measured magnitude that drove the flag
  note: string;
}

/** EMA STACK detail carries `· trend NNN.NN×ATR` — the extension magnitude. */
export function parseEmaTrendAtr(votes: FactorVote[]): number | null {
  const ema = votes.find((v) => /EMA STACK/i.test(v.factor));
  if (!ema) return null;
  const atr = parseFloat((ema.detail.match(/trend ([\d.]+)×ATR/) || [])[1] ?? "nan");
  return Number.isFinite(atr) ? atr : null;
}

function shortVal(v: EntryLeverVerdict, p: EntryLeverParams): string {
  switch (v.lever) {
    case "EXT":
      return `${v.value?.toFixed(0)}×ATR`;
    case "FLOW":
      return `+${v.value}/25`;
    case "CAUSE":
      return String(v.note);
    case "STALE":
      return `${((v.value ?? 0) / 1000).toFixed(1)}s`;
    case "SCALP":
      return `eff +${p.scalpBonus}`;
    case "LEVCAP":
      return `${v.value}×`;
    case "MOMENTUM":
      return `eff +${p.momentumBonus}`;
  }
}

export function evaluateEntryLevers(ctx: EntryLeverCtx, p: EntryLeverParams): EntryLeverVerdict[] {
  const out: EntryLeverVerdict[] = [];
  // EXT — sign-agnostic extension magnitude (direction-relative audit showed
  // vote SIGNS do not separate; the MAGNITUDE does)
  const atr = parseEmaTrendAtr(ctx.votes);
  out.push({
    lever: "EXT",
    measurable: atr != null,
    fired: atr != null && Math.abs(atr) >= p.extAtr,
    value: atr,
    note: atr != null ? `trend ${atr.toFixed(0)}×ATR` : "ema snapshot unavailable",
  });
  // FLOW — flow score is direction-aligned by construction
  out.push({
    lever: "FLOW",
    measurable: ctx.flowScore != null,
    fired: ctx.flowScore != null && ctx.flowScore >= p.flowScoreMin,
    value: ctx.flowScore,
    note: ctx.flowScore != null ? `flow ${ctx.flowScore >= 0 ? "+" : ""}${ctx.flowScore}/25 along direction` : "flow unavailable",
  });
  // CAUSE — chase-tape blacklist
  const bad = ctx.volCause != null && p.badCauses.includes(ctx.volCause);
  out.push({
    lever: "CAUSE",
    measurable: ctx.volCause != null,
    fired: bad,
    value: bad ? 1 : 0,
    note: ctx.volCause ?? "no vol-cause",
  });
  // STALE — late detection → late (worse) price
  out.push({
    lever: "STALE",
    measurable: ctx.detectionAgeMs != null,
    fired: ctx.detectionAgeMs != null && ctx.detectionAgeMs > p.staleMs,
    value: ctx.detectionAgeMs,
    note: ctx.detectionAgeMs != null ? `detection age ${(ctx.detectionAgeMs / 1000).toFixed(1)}s` : "scan path (no radar detection)",
  });
  // SCALP — structural fast-death strategy → threshold valve (not a ban: the
  // scalp book carries real TP3 winners, only the weak entries must pay more)
  out.push({
    lever: "SCALP",
    measurable: true,
    fired: ctx.strategy === "AI-SCALP",
    value: ctx.strategy === "AI-SCALP" ? 1 : 0,
    note: ctx.strategy === "AI-SCALP" ? `AI-SCALP → eff +${p.scalpBonus} when enforced` : ctx.strategy,
  });
  // LEVCAP — high leverage trims to the cap (risk shaping, never a veto)
  out.push({
    lever: "LEVCAP",
    measurable: true,
    fired: ctx.leverage > p.levCap,
    value: ctx.leverage,
    note: ctx.leverage > p.levCap ? `leverage ${ctx.leverage}× > cap ${p.levCap}×` : `leverage ${ctx.leverage}× within cap`,
  });
  // MOMENTUM (v11.4 7th lever) — the TIGHTEN alternative: per-strategy valve.
  // The advisor's global minScore 12→17 was measured (EQ-94 fee-aware
  // counterfactual) to be inert-to-harmful; the honest tool is a per-strategy
  // valve whose OWN cohort must pass the promotion gate before it ever bites.
  out.push({
    lever: "MOMENTUM",
    measurable: true,
    fired: ctx.strategy === "MOMENTUM",
    value: ctx.strategy === "MOMENTUM" ? 1 : 0,
    note: ctx.strategy === "MOMENTUM" ? `MOMENTUM → eff +${p.momentumBonus} when enforced` : ctx.strategy,
  });
  return out;
}

// ─────────────────────────────────────────────────────────────
// Config persistence (EngineSetting) — modes are operator-controllable
// ─────────────────────────────────────────────────────────────

export async function getEntryLeverConfig(force = false): Promise<LeverConfig> {
  if (!force && configCache && Date.now() - configCache.at < CONFIG_CACHE_MS) return configCache.cfg;
  let cfg = defaultConfig();
  try {
    const row = await db.engineSetting.findUnique({ where: { key: MODES_KEY } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<LeverConfig>;
      cfg = {
        modes: { ...cfg.modes, ...(parsed.modes ?? {}) },
        params: { ...cfg.params, ...(parsed.params ?? {}), badCauses: parsed.params?.badCauses ?? cfg.params.badCauses },
        updatedAt: parsed.updatedAt ?? cfg.updatedAt,
        autoNotes: parsed.autoNotes ?? [],
        manual: parsed.manual ?? {},
      };
    }
  } catch {
    /* fail-open: defaults */
  }
  configCache = { at: Date.now(), cfg };
  return cfg;
}

async function saveConfig(cfg: LeverConfig): Promise<void> {
  cfg.updatedAt = new Date().toISOString();
  await db.engineSetting.upsert({ where: { key: MODES_KEY }, create: { key: MODES_KEY, value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
  configCache = { at: Date.now(), cfg };
}

export async function setEntryLeverMode(id: EntryLeverId, mode: EntryLeverMode, by: string, pin = true): Promise<LeverConfig> {
  const cfg = await getEntryLeverConfig(true);
  cfg.modes[id] = mode;
  if (pin) cfg.manual[id] = true;
  await saveConfig(cfg);
  try {
    const { fireEvent } = await import("@/lib/engine");
    await fireEvent(null, null, "ENGINE", "warn", `ENTRY-LEVER mode [${id}] → ${mode.toUpperCase()} (${by}) — late-entry shield v11.3`);
  } catch {
    /* audit event best-effort */
  }
  return cfg;
}

// ─────────────────────────────────────────────────────────────
// Ledger stats — recomputed from stored evidence (immutable factorsJson /
// flowJson / strategy / leverage + FillLedger latency), rolling window.
// This is the SAME measurement the EQ-89 counterfactual used, so the gate
// numbers on the card reconcile with the operator's forensic report.
// ─────────────────────────────────────────────────────────────

export interface EntryLeverStat {
  lever: EntryLeverId;
  flagN: number; // settled flagged rows in window
  flagWr: number; // flagged win rate %
  flagAvg: number; // flagged avg pnlPercent (margin-relative)
  baseN: number; // unflagged settled rows
  baseAvg: number;
  fires7d: number; // fired on rows created in the last 7 days
  gatePass: boolean;
  gateNote: string;
}

export interface EntryLeverStats {
  windowDays: number;
  cohortN: number;
  cohortWr: number;
  cohortAvg: number;
  perLever: EntryLeverStat[];
  computedAt: string;
}

function ctxFromRow(row: { factorsJson: string | null; flowJson: string | null; strategy: string; leverage: number; direction: string; symbol: string }, latencyMs: number | null): EntryLeverCtx {
  let votes: FactorVote[] = [];
  try {
    const parsed = JSON.parse(row.factorsJson ?? "null");
    if (Array.isArray(parsed)) votes = parsed;
  } catch {
    /* immutable evidence missing → levers report unmeasurable */
  }
  let flowScore: number | null = null;
  try {
    const flow = JSON.parse(row.flowJson ?? "null") as { score?: number | null } | null;
    if (flow && typeof flow.score === "number") flowScore = flow.score;
  } catch {
    /* no flow snapshot */
  }
  const causeVote = votes.find((v) => v.factor.startsWith("VOL-CAUSE:"));
  return {
    symbol: row.symbol,
    direction: row.direction === "SHORT" ? "SHORT" : "LONG",
    strategy: row.strategy,
    votes,
    flowScore,
    volCause: causeVote ? causeVote.factor.slice("VOL-CAUSE:".length) : null,
    leverage: row.leverage,
    detectionAgeMs: latencyMs, // stats proxy for decision-time detection age
    adjScore: 0,
    effMin: 0,
  };
}

export async function entryLeverStats(force = false): Promise<EntryLeverStats> {
  if (!force && statsCache && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.stats;
  const cfg = await getEntryLeverConfig();
  const p = cfg.params;
  const since = new Date(Date.now() - p.windowDays * 86_400_000);
  const rows = await db.signal.findMany({
    where: { status: { notIn: ["ACTIVE"] }, qualityFlag: null, createdAt: { gte: since } },
    select: { id: true, createdAt: true, pnlPercent: true, direction: true, strategy: true, leverage: true, symbol: true, factorsJson: true, flowJson: true },
  });
  const fills = new Map((await db.fillLedger.findMany({ select: { signalId: true, latencyMs: true } })).map((f) => [f.signalId, f.latencyMs]));
  const weekAgo = Date.now() - 7 * 86_400_000;

  interface Acc {
    n: number;
    w: number;
    sum: number;
    fires7d: number;
  }
  const flagged = new Map<EntryLeverId, Acc>(ENTRY_LEVER_IDS.map((id) => [id, { n: 0, w: 0, sum: 0, fires7d: 0 }]));
  const unflagged = new Map<EntryLeverId, Acc>(ENTRY_LEVER_IDS.map((id) => [id, { n: 0, w: 0, sum: 0, fires7d: 0 }]));
  let cohortN = 0;
  let cohortW = 0;
  let cohortSum = 0;

  for (const row of rows) {
    cohortN++;
    if (row.pnlPercent > 0) cohortW++;
    cohortSum += row.pnlPercent;
    const ctx = ctxFromRow(row, fills.get(row.id) ?? null);
    const verdicts = evaluateEntryLevers(ctx, p);
    const recent = row.createdAt.getTime() >= weekAgo;
    for (const v of verdicts) {
      const bucket = v.fired ? flagged.get(v.lever)! : unflagged.get(v.lever)!;
      bucket.n++;
      if (row.pnlPercent > 0) bucket.w++;
      bucket.sum += row.pnlPercent;
      if (v.fired && recent) bucket.fires7d++;
    }
  }

  const perLever: EntryLeverStat[] = ENTRY_LEVER_IDS.map((id) => {
    const f = flagged.get(id)!;
    const u = unflagged.get(id)!;
    const flagAvg = f.n ? f.sum / f.n : 0;
    const baseAvg = u.n ? u.sum / u.n : 0;
    const nOk = f.n >= p.promoteMinN;
    const avgOk = flagAvg <= p.promoteMaxFlagAvg;
    const sepOk = baseAvg - flagAvg >= p.promoteMinSep;
    const parts: string[] = [];
    if (!nOk) parts.push(`n ${f.n}/${p.promoteMinN}`);
    if (!avgOk) parts.push(`flagAvg ${flagAvg.toFixed(2)} > ${p.promoteMaxFlagAvg}`);
    if (!sepOk) parts.push(`sep ${(baseAvg - flagAvg).toFixed(2)} < ${p.promoteMinSep}`);
    return {
      lever: id,
      flagN: f.n,
      flagWr: f.n ? (100 * f.w) / f.n : 0,
      flagAvg,
      baseN: u.n,
      baseAvg,
      fires7d: f.fires7d,
      gatePass: nOk && avgOk && sepOk,
      gateNote: nOk && avgOk && sepOk ? "PROMOTION GATE PASSED" : `gate open: ${parts.join(" · ") || "accruing"}`,
    };
  });

  const stats: EntryLeverStats = {
    windowDays: p.windowDays,
    cohortN,
    cohortWr: cohortN ? (100 * cohortW) / cohortN : 0,
    cohortAvg: cohortN ? cohortSum / cohortN : 0,
    perLever,
    computedAt: new Date().toISOString(),
  };
  statsCache = { at: Date.now(), stats };
  return stats;
}

// ─────────────────────────────────────────────────────────────
// Auto promotion / demotion — deterministic, evented, hysteresis-protected.
// Runs on the deploy gate path (throttled by the stats cache) and on GET.
// ─────────────────────────────────────────────────────────────

async function syncLeverModes(): Promise<void> {
  const cfg = await getEntryLeverConfig();
  const stats = await entryLeverStats();
  let changed = false;
  const notes: string[] = [];
  for (const s of stats.perLever) {
    if (cfg.manual[s.lever]) continue; // operator-pinned — manual authority wins
    const mode = cfg.modes[s.lever];
    if (mode === "shadow" && s.gatePass) {
      cfg.modes[s.lever] = "enforce";
      changed = true;
      notes.push(`${s.lever} shadow→enforce (flagAvg ${s.flagAvg.toFixed(2)}, sep ${(s.baseAvg - s.flagAvg).toFixed(2)}, n=${s.flagN})`);
    } else if (mode === "enforce" && s.flagN >= cfg.params.promoteMinN && s.flagAvg > cfg.params.demoteFlagAvg) {
      // honest feedback loop: the enforced lever's own flagged cohort healed —
      // step back to shadow and let the gate re-prove it
      cfg.modes[s.lever] = "shadow";
      changed = true;
      notes.push(`${s.lever} enforce→shadow (flagged cohort healed: avg ${s.flagAvg.toFixed(2)})`);
    } else if (mode === "enforce" && s.flagN < cfg.params.promoteMinN) {
      // evidence drain: an enforcing lever censors its own cohort — blocked
      // deploys never settle, so flagN decays below the gate floor as the
      // window rolls. Step back to shadow to re-accrue fresh, uncensored
      // evidence (drain takes ≥windowDays of enforcement — no flapping).
      cfg.modes[s.lever] = "shadow";
      changed = true;
      notes.push(`${s.lever} enforce→shadow (evidence drain: flagN ${s.flagN} < ${cfg.params.promoteMinN} — re-accrue)`);
    }
  }
  if (changed) {
    cfg.autoNotes = [...notes, ...cfg.autoNotes].slice(0, 12);
    await saveConfig(cfg);
    try {
      const { fireEvent } = await import("@/lib/engine");
      await fireEvent(null, null, "ENGINE", "warn", `ENTRY-LEVER auto-mode: ${notes.join(" | ")} — evidence-gated rollout v11.3`);
    } catch {
      /* audit event best-effort */
    }
  }
}

/** Operator-facing sync — runs the promotion/demotion ladder once (GET path). */
export async function syncEntryLeverModes(): Promise<void> {
  await syncLeverModes();
}

// ─────────────────────────────────────────────────────────────
// Deploy gate — called from engine.deploySignal AFTER the levered-risk cap
// (so leverage is final) and BEFORE sizing/creation. Never throws.
// ─────────────────────────────────────────────────────────────

export interface EntryLeverGateResult {
  block: boolean;
  lever: EntryLeverId | null;
  reason: string | null;
  capTo: number | null; // LEVCAP enforcement (ctx.leverage > cap guaranteed)
  note: string; // one analysis-line summary ("" = nothing to say)
  tags: string[]; // fired-lever audit tags
  observe: boolean;
}

const LEVER_TAG: Record<EntryLeverId, string> = { EXT: "LEV-EXT", FLOW: "LEV-FLOW", CAUSE: "LEV-CAUSE", STALE: "LEV-STALE", SCALP: "LEV-SCALP", LEVCAP: "LEV-CAP", MOMENTUM: "LEV-MOM" };

export async function entryLeversDeployGate(ctx: EntryLeverCtx, opts: { observe: boolean }): Promise<EntryLeverGateResult> {
  const res: EntryLeverGateResult = { block: false, lever: null, reason: null, capTo: null, note: "", tags: [], observe: opts.observe };
  try {
    const cfg = await getEntryLeverConfig();
    const verdicts = evaluateEntryLevers(ctx, cfg.params);
    const fired = verdicts.filter((v) => v.fired);
    res.tags = fired.map((v) => LEVER_TAG[v.lever]);

    if (fired.length) void syncLeverModes().catch(() => undefined); // best-effort, throttled by the stats cache

    if (!opts.observe) {
      for (const v of fired) {
        const mode = cfg.modes[v.lever];
        if (mode !== "enforce") continue; // shadow → journal only · off → silent
        if (v.lever === "SCALP") {
          // valve, not a ban: the scalp candidate must clear effMin + bonus
          const bar = ctx.effMin + cfg.params.scalpBonus;
          if (Math.abs(ctx.adjScore) >= bar) continue;
          res.block = true;
          res.lever = "SCALP";
          res.reason = `AI-SCALP valve: |score| ${Math.abs(ctx.adjScore).toFixed(0)} < eff ${ctx.effMin}+${cfg.params.scalpBonus} scalp bonus`;
          break;
        }
        if (v.lever === "MOMENTUM") {
          // v11.4 valve, not a ban — same semantics as SCALP, own stat gate:
          // the MOMENTUM candidate must clear effMin + momentumBonus
          const bar = ctx.effMin + cfg.params.momentumBonus;
          if (Math.abs(ctx.adjScore) >= bar) continue;
          res.block = true;
          res.lever = "MOMENTUM";
          res.reason = `MOMENTUM valve: |score| ${Math.abs(ctx.adjScore).toFixed(0)} < eff ${ctx.effMin}+${cfg.params.momentumBonus} momentum bonus`;
          break;
        }
        if (v.lever === "LEVCAP") {
          res.capTo = cfg.params.levCap; // fired ⇒ ctx.leverage > cap — engine trims
          continue;
        }
        res.block = true;
        res.lever = v.lever;
        res.reason = `${ENTRY_LEVER_LABELS[v.lever].split(" — ")[0]} fired: ${v.note}`;
        break;
      }
    }

    res.note = fired.length
      ? `${fired.length}/${ENTRY_LEVER_IDS.length} flagged (${fired.map((v) => `${v.lever} ${shortVal(v, cfg.params)}`).join(", ")})${opts.observe ? " · OBSERVE-ONLY" : ""}`
      : "";
    await appendJournal({
      at: new Date().toISOString(),
      symbol: ctx.symbol,
      direction: ctx.direction,
      strategy: ctx.strategy,
      leverage: ctx.leverage,
      observe: opts.observe,
      modes: { ...cfg.modes },
      fired: fired.map((v) => ({ lever: v.lever, value: v.value })),
      block: res.block ? res.lever : null,
      capTo: res.capTo,
    });
  } catch {
    /* fail-open — the shield must never stall a deploy */
  }
  return res;
}

// ── journal (.data/entry-levers.jsonl) — audit trail, size-capped rotate ──

async function appendJournal(line: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(path.dirname(JOURNAL_FILE), { recursive: true });
    try {
      const st = await stat(JOURNAL_FILE);
      if (st.size > JOURNAL_MAX_BYTES) await rename(JOURNAL_FILE, `${JOURNAL_FILE}.1`);
    } catch {
      /* first write */
    }
    await appendFile(JOURNAL_FILE, JSON.stringify(line) + "\n", "utf8");
  } catch {
    /* journal best-effort */
  }
}

export async function readJournalTail(max = 15): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await readFile(JOURNAL_FILE, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    return lines.slice(-max).reverse().map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// API state bundle
// ─────────────────────────────────────────────────────────────

export async function entryLeversState() {
  await syncEntryLeverModes().catch(() => undefined); // ladder runs on read — visible in autoNotes
  const [cfg, stats, journal] = await Promise.all([getEntryLeverConfig(true), entryLeverStats(), readJournalTail()]);
  return { ts: Date.now(), modes: cfg.modes, manual: cfg.manual, params: cfg.params, updatedAt: cfg.updatedAt, autoNotes: cfg.autoNotes, stats, journal, labels: ENTRY_LEVER_LABELS };
}
