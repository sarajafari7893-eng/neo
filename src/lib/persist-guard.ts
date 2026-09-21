// ── v10.6.1 PERSIST GUARD — serialize queue + monotonic watermark ────────────
// Operator APPROVE 2026-09-18 (proposal #4 / supervisor proposal-5a): fix the
// dev split-brain class where a stale module generation (or a second dev
// process) rewrites state files from an in-memory snapshot and clobbers newer
// records written by the live instance — the root cause of the paperSettled
// loss risk, the SV "frozen last-known arms" symptom and the recurring
// write-lock degradation windows (HTTP:000 on SV/advisor/terminal).
//
// TWO PRIMITIVES, both process-local + cross-process aware:
//  · serializePersist(scope, fn) — single-flight queue: writers for one scope
//    chain after each other instead of interleaving rename/rewrite windows.
//  · persistWatermark(scope) / persistGuardOk(scope) — a monotonic watermark
//    {bootId, seq, ts} in a sidecar file. Before a DESTRUCTIVE state rewrite
//    (rotation / compact / rename), the caller checks the sidecar: if another
//    boot rotated more recently than this process's last observed watermark,
//    this process must resync (re-stat) instead of blindly renaming — which is
//    exactly the stale-instance counter-divergence bug.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const BOOT_ID = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

export interface PersistWatermark {
  bootId: string;
  seq: number;
  ts: number;
}

const queues = new Map<string, Promise<unknown>>();
const seqs = new Map<string, number>();
const lastSeen = new Map<string, PersistWatermark>();

/** Single-flight per scope — every queued fn runs strictly after the previous. */
export function serializePersist<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(scope) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run regardless of predecessor outcome
  queues.set(
    scope,
    next.catch(() => undefined),
  );
  return next;
}

function watermarkPath(scope: string): string {
  return path.join(process.cwd(), ".data", `persist-wm-${scope}.json`);
}

function nextSeq(scope: string): number {
  const s = (seqs.get(scope) ?? 0) + 1;
  seqs.set(scope, s);
  return s;
}

/** Stamp + record our own write — callers embed the returned mark beside state. */
export async function persistWatermark(scope: string): Promise<PersistWatermark> {
  const mark: PersistWatermark = { bootId: BOOT_ID, seq: nextSeq(scope), ts: Date.now() };
  lastSeen.set(scope, mark);
  try {
    await writeFile(watermarkPath(scope), JSON.stringify(mark), "utf8");
  } catch {
    /* guard must never break the writer */
  }
  return mark;
}

/**
 * Guard check BEFORE a destructive rewrite (rotation/rename-from-snapshot).
 * Returns false when ANOTHER boot advanced the watermark since we last looked —
 * the caller must re-stat/re-hydrate and retry instead of renaming.
 */
export async function persistGuardOk(scope: string): Promise<boolean> {
  try {
    const raw = await readFile(watermarkPath(scope), "utf8");
    const disk = JSON.parse(raw) as PersistWatermark;
    if (!disk || typeof disk.ts !== "number") return true;
    const seen = lastSeen.get(scope);
    // Foreign boot wrote after our last observed mark → we are stale.
    if (disk.bootId !== BOOT_ID && (!seen || disk.ts > seen.ts)) return false;
    return true;
  } catch {
    return true; // no watermark yet — first writer wins
  }
}
