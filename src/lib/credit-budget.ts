// ── NEXUS//SIGNALS — CREDIT BUDGET LEDGER (server-only · SKELETON) ───────────
//
// █████ SKELETON — NOT WIRED INTO PRODUCTION █████
// Enforcement wiring into src/lib/ai.ts is PHASE-2 and BLOCKED on the operator
// confirming the actual Z.ai billing rules (rolling-window size, weekly cap,
// off-peak hours). Until then this module is pure accounting: it records and
// reports LLM call consumption but NEVER blocks a call — every function is
// try/catch FAIL-OPEN by doctrine ("budget failures must never block a call").
//
// Design constraints (Week-0 scaffolding, task 10-b):
//   · ZERO imports from engine/ai — importing this module has NO side effects
//     (db access is a lazy `await import("@/lib/db")` inside the async paths,
//     mirroring the EngineSetting upsert pattern of src/lib/gate-settings.ts).
//   · Config lives in src/config/credit-budget.json (resolveJsonModule) —
//     PLACEHOLDER values only; nothing here is enforceable policy yet.
//   · Hot path untouched: nothing in src/lib/engine.ts's synchronous import
//     graph may ever reach this file (see research/README.md doctrine).
//
// Tiers: "hot" = in-tick LLM calls · "background" = deferred/analysis calls ·
// "research" = research-layer agents (Hypothesis Agent, Adversarial Critic,
// Overfit-Auditor — see research/README.md).

import rawBudget from "@/config/credit-budget.json";

export type Tier = "hot" | "background" | "research";

export interface CallRecord {
  at: number; // epoch ms of the call
  tier: Tier;
  units: number; // EFFECTIVE billing units (tier weight × off-peak discount applied)
}

export interface CanCallVerdict {
  ok: boolean;
  reason?: string; // set on denial AND on fail-open (why we could not judge)
}

export interface CreditUsage {
  windowCount: number; // # of calls inside the rolling window
  windowStart: number; // epoch ms — start of the current rolling window
  weekCount: number; // # of calls in the trailing 7×24h
  weekUnits: number; // effective units consumed in the trailing 7×24h
  windowUnits: number; // effective units consumed inside the rolling window
  offPeakNow: boolean; // inside the configured off-peak discount window (Asia/Singapore)
  lastCallAt: number | null; // epoch ms of the most recent recorded call
}

export interface OffPeakConfig {
  timezone: string;
  startHour: number; // inclusive, local hour at `timezone`
  endHour: number; // exclusive
  days: number[]; // ISO weekdays (1=Mon … 7=Sun)
  discountFactor: number; // multiplier applied to units while off-peak
}

export interface CreditBudgetConfig {
  rollingWindowHours: number;
  /** NOT present in the placeholder JSON — operator may add it (or a weekly
   *  cap) once Z.ai billing rules are confirmed. Absent/undefined ⇒ the
   *  rolling-window check passes (fail-open skeleton). */
  rollingWindowMaxCalls?: number | null;
  weeklyCapUsdOrUnits: number | null;
  offPeak: OffPeakConfig;
  tierWeights: Record<Tier, number>;
  _comment: string;
}

export const CREDIT_BUDGET = rawBudget as CreditBudgetConfig;

const RING_CAP = 5000;
const SETTING_KEY = "credit.usage";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_MIN_INTERVAL_MS = 30_000; // coalesced whole-ring upsert (crash loses ≤30s of accounting; fail-open doctrine)

// Intl weekday short-name → ISO weekday number (1=Mon … 7=Sun)
const WEEKDAY_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

interface CreditBudgetState {
  ring: CallRecord[];
  hydrated: boolean;
  hydrating: Promise<void> | null;
  lastPersistAt: number;
}

// globalThis singleton — Next dev spawns per-route module bundles; ONE ledger
// must be shared across all of them (same doctrine as engine.ts's __nexusSerial).
const g = globalThis as unknown as { __nexusCreditBudget?: CreditBudgetState };
const state: CreditBudgetState =
  g.__nexusCreditBudget ?? (g.__nexusCreditBudget = { ring: [], hydrated: false, hydrating: null, lastPersistAt: 0 });

// ── persistence (lazy, fail-open) ────────────────────────────────────────────

async function loadUsage(): Promise<void> {
  if (state.hydrated) return;
  if (state.hydrating) return state.hydrating;
  state.hydrating = (async () => {
    try {
      const { db } = await import("@/lib/db");
      const row = await db.engineSetting.findUnique({ where: { key: SETTING_KEY } });
      if (row && state.ring.length === 0) {
        try {
          const parsed = JSON.parse(row.value) as { ring?: CallRecord[] };
          for (const rec of parsed.ring ?? []) {
            if (rec && typeof rec.at === "number" && typeof rec.units === "number") {
              state.ring.push({ at: rec.at, tier: (rec.tier as Tier) ?? "background", units: rec.units });
            }
          }
          if (state.ring.length > RING_CAP) state.ring.splice(0, state.ring.length - RING_CAP);
          state.ring.sort((a, b) => a.at - b.at);
        } catch {
          /* torn blob — start empty, in-memory only */
        }
      }
    } catch {
      /* db unreachable — stay in-memory, fail-open */
    } finally {
      state.hydrated = true;
      state.hydrating = null;
    }
  })();
  return state.hydrating;
}

async function saveUsage(): Promise<void> {
  const now = Date.now();
  if (now - state.lastPersistAt < PERSIST_MIN_INTERVAL_MS) return; // coalesced — next save carries the ring forward
  state.lastPersistAt = now;
  try {
    const { db } = await import("@/lib/db");
    const blob = JSON.stringify({ v: 1, ring: state.ring, updatedAt: now });
    await db.engineSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: blob },
      update: { value: blob },
    });
  } catch {
    /* persistence is best-effort — accounting continues in-memory */
  }
}

// ── off-peak (operator's stated discount window) ─────────────────────────────

/** True when `now` falls inside the configured off-peak window, judged in the
 *  config's own timezone (Asia/Singapore) via Intl. Mon–Fri 14:00–18:00 local.
 *  FAIL-CLOSED-to-full-price on any error (an accounting bug must never hand
 *  out an unearned discount). */
export function isOffPeakAt(now: number = Date.now()): boolean {
  try {
    const cfg = CREDIT_BUDGET.offPeak;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: cfg.timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
    }).formatToParts(new Date(now));
    const wdRaw = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hrRaw = parts.find((p) => p.type === "hour")?.value ?? "";
    const day = WEEKDAY_ISO[wdRaw];
    const hour = parseInt(hrRaw, 10);
    if (!day || Number.isNaN(hour) || hour === 24) return false; // some ICU builds render midnight as 24
    return cfg.days.includes(day) && hour >= cfg.startHour && hour < cfg.endHour;
  } catch {
    return false;
  }
}

// ── accounting ───────────────────────────────────────────────────────────────

function effectiveUnits(tier: Tier, units: number, now: number): number {
  const weight = CREDIT_BUDGET.tierWeights[tier] ?? 1;
  const discount = isOffPeakAt(now) ? CREDIT_BUDGET.offPeak.discountFactor : 1;
  return Math.round(units * weight * discount * 1000) / 1000;
}

function windowStartAt(now: number): number {
  const hours = Math.max(1, CREDIT_BUDGET.rollingWindowHours || 5);
  return now - hours * 60 * 60 * 1000;
}

/**
 * Budget gate — SKELETON (fail-open). Returns ok:false ONLY on a deliberate,
 * config-backed budget denial (weekly cap / rolling-window max once the
 * operator confirms them); any internal failure returns ok:true with a reason
 * so a broken budget ledger can never block a call pre-phase-2.
 */
export async function canCall(tier: Tier, units = 1, now: number = Date.now()): Promise<CanCallVerdict> {
  try {
    await loadUsage();
  } catch {
    return { ok: true, reason: "budget fail-open: ledger hydration failed" };
  }
  try {
    const wStart = windowStartAt(now);
    let weekUnits = 0;
    let windowCount = 0;
    const weekStart = now - WEEK_MS;
    for (const rec of state.ring) {
      if (rec.at >= weekStart) weekUnits += rec.units;
      if (rec.at >= wStart) windowCount++;
    }
    // rolling-window count enforcement — activates only when the operator adds
    // rollingWindowMaxCalls to the config (absent in the placeholder JSON)
    const windowMax = CREDIT_BUDGET.rollingWindowMaxCalls;
    if (typeof windowMax === "number" && windowMax !== null && windowCount + 1 > windowMax) {
      return { ok: false, reason: `rolling-window cap: ${windowCount} calls in last ${CREDIT_BUDGET.rollingWindowHours}h (max ${windowMax})` };
    }
    // weekly cap (USD or unit-denominated — operator to confirm)
    if (typeof CREDIT_BUDGET.weeklyCapUsdOrUnits === "number" && weekUnits + units > CREDIT_BUDGET.weeklyCapUsdOrUnits) {
      return { ok: false, reason: `weekly cap: ${Math.round(weekUnits * 1000) / 1000} units used of ${CREDIT_BUDGET.weeklyCapUsdOrUnits}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: true, reason: `budget fail-open: ${e instanceof Error ? e.message : "unknown"}` };
  }
}

/** Record one LLM call into the ring + coalesced EngineSetting persistence.
 *  Units are stored EFFECTIVE (tier weight × off-peak discount) — raw call
 *  counts stay derivable from record counts. Never throws. */
export async function recordCall(tier: Tier, units = 1, now: number = Date.now()): Promise<void> {
  try {
    await loadUsage();
    state.ring.push({ at: now, tier, units: effectiveUnits(tier, units, now) });
    if (state.ring.length > RING_CAP) state.ring.splice(0, state.ring.length - RING_CAP);
    void saveUsage();
  } catch {
    /* fail-open: a lost accounting record must never surface to callers */
  }
}

/** Snapshot of current consumption. Never throws; every field degrades to a
 *  safe zero/false default if the ledger is unavailable. */
export async function getUsage(now: number = Date.now()): Promise<CreditUsage> {
  try {
    await loadUsage();
  } catch {
    /* fall through with empty-ring numbers */
  }
  try {
    const wStart = windowStartAt(now);
    const weekStart = now - WEEK_MS;
    let windowCount = 0;
    let windowUnits = 0;
    let weekCount = 0;
    let weekUnits = 0;
    let lastCallAt: number | null = null;
    for (const rec of state.ring) {
      if (rec.at >= weekStart) {
        weekCount++;
        weekUnits += rec.units;
      }
      if (rec.at >= wStart) {
        windowCount++;
        windowUnits += rec.units;
      }
      if (lastCallAt === null || rec.at > lastCallAt) lastCallAt = rec.at;
    }
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    return {
      windowCount,
      windowStart: wStart,
      weekCount,
      weekUnits: r3(weekUnits),
      windowUnits: r3(windowUnits),
      offPeakNow: isOffPeakAt(now),
      lastCallAt,
    };
  } catch {
    return {
      windowCount: 0,
      windowStart: windowStartAt(now),
      weekCount: 0,
      weekUnits: 0,
      windowUnits: 0,
      offPeakNow: false,
      lastCallAt: null,
    };
  }
}
