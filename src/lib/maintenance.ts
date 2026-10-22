// ── v10.17 P1-3 SIGNAL EVENT ARCHIVE — self-driving DB hygiene (server-only) ──
// The SignalEvent table grows ~915 events/hour of ENGINE chatter (signalId:
// null rows) — 89% of the table — inflating the SQLite file (backups 36MB and
// rising) and WAL pressure. Signal-LINKED events are the audit trail and STAY
// in the DB. This module drains ONLY the unlinked ENGINE chatter that is older
// than 14 days into an NDJSON sidecar (.data/archive/signal-events-YYYYMM.ndjson,
// one FULL row per line, createdAt ISO) — outside the DB folder so backups stay
// lean and the sidecar never rides the snapshot loop.
//
// Safety doctrine (all verified per batch, never best-effort silent):
//   · 24h self-throttle via EngineSetting "maintenance.archive" — the engine
//     rail calls this every ~4min; the gate makes it a once-a-day drain.
//   · ≤2000 rows per run (bounded work per tick-adjacent invocation).
//   · WRITE → VERIFY → DELETE per batch: the exact bytes appended are read
//     back from disk and compared to the serialization BEFORE any delete; a
//     mismatch stops the run and never attempts compensation (NDJSON is
//     additive — the next run re-archives the remainder, worst case a
//     duplicated line keyed by the same id, never a lost row).
//   · EngineSetting is updated after EVERY batch, so a crash mid-run resumes
//     from the remainder instead of re-archiving already-deleted rows.
//   · Never throws — a failed archive must never take the tick down.
import { db } from "@/lib/db";
import { appendFile, mkdir, open, stat } from "node:fs/promises";

const KEY = "maintenance.archive";
// Production sink per P1-3 contract; MAINTENANCE_ARCHIVE_DIR exists ONLY as a
// test seam (DB-copy dry-runs must never write synthetic rows into the real
// sidecar). Unset in every real environment → the contract path is used.
const ARCHIVE_DIR = process.env.MAINTENANCE_ARCHIVE_DIR || "/home/z/my-project/.data/archive";
const AGE_DAYS = 14; // archive only chatter older than this — young rows still have forensic value
const DAY_MS = 86_400_000;
const GATE_MS = 24 * 3_600_000; // one self-driven run per day
const DEFAULT_BATCH = 400;
const MAX_PER_RUN = 2000;
const NOTE_COOLDOWN_MS = 6 * 3_600_000; // the SYSTEM feed note is rate-limited separately

export interface ArchiveResult {
  ran: boolean;
  reason?: string;
  archived: number;
  file?: string;
  elapsedMs: number;
  remaining?: number;
}

interface ArchiveState {
  lastRunAt: number;
  totalArchived: number;
  lastFile: string | null;
  lastNoteAt?: number;
}

// Next dev bundles a separate module instance per route — the in-flight lock
// lives on globalThis (same doctrine as the serial mutex in engine.ts) so two
// routes can never double-drain the archive concurrently.
const gMaint = globalThis as { __nexusArchiveInFlight?: Promise<ArchiveResult> };

async function readState(): Promise<ArchiveState | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (!row) return null;
    const v = JSON.parse(row.value) as Partial<ArchiveState>;
    return {
      lastRunAt: Number(v.lastRunAt) || 0,
      totalArchived: Number(v.totalArchived) || 0,
      lastFile: typeof v.lastFile === "string" ? v.lastFile : null,
      lastNoteAt: Number(v.lastNoteAt) || 0,
    };
  } catch {
    return null; // corrupt state = behave like a first run (safe: the age rule is idempotent)
  }
}

async function writeState(s: ArchiveState): Promise<void> {
  const value = JSON.stringify(s);
  await db.engineSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

function archiveFileFor(now = new Date()): string {
  // UTC calendar month in the filename (unambiguous, no DST/Tehran-offset questions)
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${ARCHIVE_DIR}/signal-events-${y}${m}.ndjson`;
}

function fileSize(file: string): Promise<number> {
  return stat(file).then((s) => s.size).catch(() => 0);
}

// Exact byte-range read-back — the verification primitive (bytes on disk must
// equal the serialization, which implies one "\n" per row).
async function readRange(file: string, start: number, end: number): Promise<string> {
  const len = end - start;
  if (len <= 0) return "";
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.toString("utf8", 0, read);
  } finally {
    await fh.close();
  }
}

export async function maybeArchiveEvents(opts?: { force?: boolean; batch?: number }): Promise<ArchiveResult> {
  const t0 = Date.now();
  if (gMaint.__nexusArchiveInFlight) {
    return { ran: false, reason: "already-running", archived: 0, elapsedMs: 0 };
  }
  const run = runArchive(t0, opts).finally(() => {
    gMaint.__nexusArchiveInFlight = undefined;
  });
  gMaint.__nexusArchiveInFlight = run;
  return run;
}

async function runArchive(t0: number, opts?: { force?: boolean; batch?: number }): Promise<ArchiveResult> {
  try {
    const prior = (await readState()) ?? { lastRunAt: 0, totalArchived: 0, lastFile: null };
    const agoH = ((Date.now() - prior.lastRunAt) / 3_600_000).toFixed(1);
    if (!opts?.force && prior.lastRunAt > 0 && Date.now() - prior.lastRunAt < GATE_MS) {
      return { ran: false, reason: `gate: last run ${agoH}h ago (<24h) — pass force to override`, archived: 0, elapsedMs: Date.now() - t0 };
    }

    // The archive rule: ENGINE chatter WITHOUT a signal link, older than 14d.
    // Anything signal-linked (CREATED/TP*/SL/… audit trail) is never touched.
    const cutoff = new Date(Date.now() - AGE_DAYS * DAY_MS);
    const where = { signalId: null, type: "ENGINE", createdAt: { lt: cutoff } };
    const SEL = { id: true, signalId: true, type: true, symbol: true, message: true, level: true, createdAt: true } as const;
    const batch = Math.max(1, Math.min(Math.floor(opts?.batch ?? DEFAULT_BATCH), MAX_PER_RUN));

    await mkdir(ARCHIVE_DIR, { recursive: true });
    const file = archiveFileFor();
    let archived = 0;
    let stopReason: string | undefined;

    while (archived < MAX_PER_RUN) {
      const rows = await db.signalEvent.findMany({ where, select: SEL, orderBy: { createdAt: "asc" }, take: Math.min(batch, MAX_PER_RUN - archived) });
      if (rows.length === 0) break;

      const payload = rows
        .map((r) => JSON.stringify({ id: r.id, signalId: r.signalId, type: r.type, symbol: r.symbol, message: r.message, level: r.level, createdAt: r.createdAt.toISOString() }))
        .join("\n") + "\n";

      // WRITE → VERIFY → DELETE: verify the exact bytes landed before any delete.
      const before = await fileSize(file);
      await appendFile(file, payload, "utf8");
      const after = await fileSize(file);
      const written = await readRange(file, before, after);
      if (written !== payload) {
        stopReason = `verify-failed: on-disk tail ${after - before}B != serialized batch ${payload.length}B — delete SKIPPED, remainder re-archives next run`;
        console.error(`[maintenance] ${stopReason}`);
        break; // no delete, no compensation — the NDJSON write is additive
      }

      const del = await db.signalEvent.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
      if (del.count !== rows.length) {
        archived += del.count; // rows whose delete failed stay in the DB and re-archive later
        stopReason = `delete-mismatch: fetched ${rows.length}, deleted ${del.count} — appended lines are additive, remainder re-archives next run`;
        console.error(`[maintenance] ${stopReason}`);
        break;
      }

      archived += del.count;
      // Crash-safety: persist progress after EVERY batch — a mid-run crash
      // resumes from the remainder (rows are already gone from the DB).
      await writeState({ ...prior, lastRunAt: Date.now(), totalArchived: prior.totalArchived + archived, lastFile: file });
    }

    if (stopReason) {
      // Failed mid-run: per-batch writes (if any) already persisted progress.
      // If nothing was archived, do NOT advance the 24h gate — the next tick
      // retries cheaply instead of stalling the drain for a full day.
      const remaining = await db.signalEvent.count({ where });
      return { ran: true, reason: stopReason, archived, file, elapsedMs: Date.now() - t0, remaining };
    }

    if (archived > 0) {
      const state: ArchiveState = { ...prior, lastRunAt: Date.now(), totalArchived: prior.totalArchived + archived, lastFile: file };
      if (Date.now() - (prior.lastNoteAt ?? 0) >= NOTE_COOLDOWN_MS) {
        state.lastNoteAt = Date.now();
        const msg = `MAINTENANCE — archived ${archived} ENGINE events (>14d, no signal link) → ${file.replace("/home/z/my-project/", "")} (DB kept lean for backup/WAL health)`;
        // Dynamic import (no static engine↔maintenance cycle), fire-and-forget;
        // SYSTEM is not a RELAYABLE type so this never pages the operator.
        void import("@/lib/engine")
          .then((m) => m.fireEvent(null, null, "SYSTEM", "info", msg))
          .catch(() => undefined);
      }
      await writeState(state);
    } else {
      // Nothing eligible — still advance the gate so the rail stops re-scanning hourly.
      await writeState({ ...prior, lastRunAt: Date.now() });
    }

    const remaining = await db.signalEvent.count({ where });
    let reason: string | undefined;
    if (archived === 0) reason = "nothing eligible (>14d unlinked ENGINE chatter) — DB already lean";
    else if (remaining > 0) reason = `cap: ${MAX_PER_RUN}/run reached — remainder continues on the next run`;
    return { ran: true, reason, archived, file, elapsedMs: Date.now() - t0, remaining };
  } catch (e) {
    console.error("[maintenance] archive run failed (tick unaffected):", e);
    return { ran: false, reason: `error: ${e instanceof Error ? e.message : String(e)}`, archived: 0, elapsedMs: Date.now() - t0 };
  }
}
