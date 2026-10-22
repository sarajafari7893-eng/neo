// ── DAILY-SCHEDULER v1.0 — self-driving Tehran-day reports, zero platform-cron dependency ──
// Incident evidence (2026-09-19 → 09-21): the daily performance report and the
// SRE engineering daily depended on an EXTERNAL platform cron hitting
// POST /api/report/daily. The 09-20 suspension + two env-erasures meant the
// report silently stopped for 66+ hours. This scheduler removes that external
// dependency: the app itself notices the Tehran-day rollover and fires the
// existing routes (which carry their own once-per-day dedup via
// dailyreport.last / sredaily.last — double-send safe).
//
// Rides the pulse (probe cadence 15s) + instrumentation boot timer. Internal
// throttle 5min. Fail-soft everywhere. Deterministic — no LLM, not hot path.

const SEND_HOUR_TEHRAN = 0; // fire as soon as the Tehran day has rolled (00:00-00:59 window preferred, but catch-up allowed all day)
const THROTTLE_MS = 5 * 60_000;

interface G {
  lastRunAt?: number;
  inflight?: boolean;
  lastStatus?: Record<string, unknown>;
}
const g = globalThis as unknown as G;

// Tehran = UTC+3:30 fixed (no DST) — same convention as dailyReport.ts tehranDayKey
function tehranDayKey(now = Date.now()): string {
  const d = new Date(now + 210 * 60_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// v10.20 Iranian week key (Sat→Fri) — numeric Tehran-day key of the most
// recent Saturday ≤ ts. Mirrors dailyReport.tehranWeekKey (kept local so this
// module stays import-light for the pulse hot path).
function tehranWeekKeyOf(now: number): number {
  const dow = new Date(now + 210 * 60_000).getUTCDay(); // Sun=0 … Sat=6
  const daysSinceSat = (dow + 1) % 7; // Sat→0, Sun→1, … Fri→6
  return Math.floor((now - daysSinceSat * 86_400_000 + 12_600_000) / 86_400_000);
}

async function readLast(key: string): Promise<{ at: number } | null> {
  try {
    const { db } = await import("@/lib/db");
    const row = await db.engineSetting.findUnique({ where: { key } });
    if (!row) return null;
    const v = JSON.parse(row.value) as { at?: number };
    return typeof v?.at === "number" ? { at: v.at } : null;
  } catch {
    return null;
  }
}

async function selfPost(path: string): Promise<{ ok: boolean; status?: number; body?: string }> {
  try {
    const key = process.env.NEXUS_CONTROL_KEY ?? "";
    if (!key) return { ok: false, body: "no control key" };
    const res = await fetch(`http://127.0.0.1:3000${path}`, {
      method: "POST",
      headers: { "x-nexus-key": key },
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.text()).slice(0, 300);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, body: String(e).slice(0, 140) };
  }
}

async function changelog(line: string): Promise<void> {
  try {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(`${process.cwd()}/docs/CHANGELOG-human.md`, `\n- \`${new Date().toISOString()}\` DAILY-SCHEDULER: ${line}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Fires the daily + SRE reports when their Tehran day has not been sent yet.
 * Catch-up semantics: if the app was down at 00:00, the report still goes out
 * on the first scheduler tick of that Tehran day (any hour).
 */
export async function maybeRunScheduledReports(force = false): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (!force) {
    if (g.inflight) return g.lastStatus ?? { ran: false, reason: "inflight" };
    if (g.lastRunAt && now - g.lastRunAt < THROTTLE_MS) return { ran: false, reason: "throttled" };
  }
  g.inflight = true;
  g.lastRunAt = now;
  const out: Record<string, unknown> = { ran: true, tehranDay: tehranDayKey(now), daily: "skip", sre: "skip", weekly: "skip" };
  try {
    const tokenReady = !!process.env.TELEGRAM_BOT_TOKEN;
    const keyReady = !!process.env.NEXUS_CONTROL_KEY;
    if (!tokenReady || !keyReady) {
      out.reason = `not ready (token:${tokenReady} key:${keyReady}) — env-guard will heal, next tick retries`;
      g.lastStatus = out;
      return out;
    }

    const today = tehranDayKey(now);
    const dayKeyOf = (at: number) => tehranDayKey(at);

    // DAILY PERFORMANCE (once per Tehran day)
    try {
      const last = await readLast("dailyreport.last");
      const due = !last || dayKeyOf(last.at) !== today;
      if (due) {
        const hourOk = true; // catch-up all day; dedup lives in the route
        if (hourOk) {
          const r = await selfPost("/api/report/daily");
          out.daily = r.ok ? "sent" : `failed (${r.status ?? r.body})`;
          if (r.ok) await changelog(`daily performance report auto-sent for Tehran day ${today} (self-driving, no platform cron)`);
        }
      } else {
        out.daily = "already-sent";
      }
    } catch (e) {
      out.daily = `error: ${String(e).slice(0, 100)}`;
    }

    // SRE ENGINEERING DAILY (once per Tehran day) — offset +30min so it never
    // races the performance poster at midnight.
    try {
      const last = await readLast("sredaily.last");
      const due = !last || dayKeyOf(last.at) !== today;
      const minutesToday = (now + 210 * 60_000) % 86_400_000 / 60_000;
      if (due && minutesToday >= 30) {
        const r = await selfPost("/api/report/sre");
        out.sre = r.ok ? "sent" : `failed (${r.status ?? r.body})`;
        if (r.ok) await changelog(`SRE engineering daily auto-sent for Tehran day ${today} (self-driving)`);
      } else {
        out.sre = due ? "waiting-30min-offset" : "already-sent";
      }
    } catch (e) {
      out.sre = `error: ${String(e).slice(0, 100)}`;
    }

    // v10.20 WEEKLY PERFORMANCE (once per Iranian week Sat→Fri) — fires on the
    // first scheduler tick of the new Iranian week (normally Saturday, right
    // after the midnight daily). Catch-up all week: if the app was down on
    // Saturday, the report still goes out on the next tick (the route owns the
    // weekKey dedup; failed sends never count, so retries stay possible).
    try {
      const last = await readLast("weeklyreport.last");
      const weekKeyOf = (at: number) => tehranWeekKeyOf(at);
      const due = !last || weekKeyOf(last.at) !== weekKeyOf(now);
      if (due) {
        const r = await selfPost("/api/report/weekly");
        out.weekly = r.ok ? "sent" : `failed (${r.status ?? r.body})`;
        if (r.ok) await changelog(`weekly performance report auto-sent for Iranian week containing ${today} (self-driving)`);
      } else {
        out.weekly = "already-sent";
      }
    } catch (e) {
      out.weekly = `error: ${String(e).slice(0, 100)}`;
    }
  } catch (e) {
    out.error = String(e).slice(0, 140);
  } finally {
    g.inflight = false;
    g.lastStatus = out;
  }
  return out;
}

export function getSchedulerStatus(): Record<string, unknown> {
  return { lastRunAt: g.lastRunAt ?? null, lastStatus: g.lastStatus ?? null };
}
