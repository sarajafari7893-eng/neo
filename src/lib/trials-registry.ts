// ── NEXUS//SIGNALS — TRIALS REGISTRY (server-only, append-only) ──────────────
// Week-0 research-infrastructure scaffold (task 10-b). One JSONL line per
// knob/gate/config/hypothesis TRIAL so the future Phase-1 Overfit-Auditor
// (research/README.md §3.3) can compute its DSR trials-count input honestly —
// the number of attempts is the deflator, and hidden attempts are how
// backtest overfitting happens. Every trial gets logged, including failures.
//
// Doctrine:
//   · append-only JSONL at .data/trials-registry.jsonl (newline-terminated)
//   · recordTrial() FAILS SOFT (returns false, never throws) — an accounting
//     failure must never break the caller
//   · no hot-path coupling: nothing here is imported by engine.ts or ai.ts
//   · humans and agents append via recordTrial() only; the file is never
//     rewritten in place (reversibility + audit trail)

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type TrialKind = "knob" | "gate" | "config" | "hypothesis";

/** Stored shape — field name `params` matches the seeded lineage line
 *  (ttlExtendMax 1->2, audited 2026-09-21). */
export interface TrialRecord {
  at: number; // epoch ms
  kind: TrialKind;
  name: string;
  params: string; // compact string form, e.g. "1->2"
  rationale: string;
}

export interface TrialInput {
  kind: TrialKind;
  name: string;
  /** Compact JSON-stringified params (stringify BEFORE calling so the stored
   *  line stays one-line-stable regardless of caller-side object quirks). */
  paramsJson: string;
  rationale: string;
  at?: number; // defaults to Date.now()
}

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE = path.join(DATA_DIR, "trials-registry.jsonl");

/** Ensure the registry file exists (empty). Best-effort, never throws. */
export async function ensureTrialsFile(): Promise<boolean> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(FILE, "", "utf8"); // append to an existing file is a no-op; creates it when missing
    return true;
  } catch {
    return false;
  }
}

/** Append one trial as a single newline-terminated JSON line. Fails soft. */
export async function recordTrial(input: TrialInput): Promise<boolean> {
  try {
    if (!input || typeof input.name !== "string" || !input.name.trim()) return false;
    const rec: TrialRecord = {
      at: typeof input.at === "number" ? input.at : Date.now(),
      kind: input.kind,
      name: input.name,
      params: String(input.paramsJson ?? ""),
      rationale: String(input.rationale ?? ""),
    };
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(FILE, JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Tail read — returns the last `limit` trials in chronological order. */
export async function listTrials(limit = 50): Promise<TrialRecord[]> {
  try {
    const buf = await readFile(FILE, "utf8").catch(() => "");
    const lines = buf.split("\n").filter((l) => l.trim().length > 0);
    const out: TrialRecord[] = [];
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        const rec = JSON.parse(line) as TrialRecord;
        if (rec && typeof rec.at === "number" && rec.name) out.push(rec);
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Total number of recorded trials (torn lines excluded). */
export async function countAll(): Promise<number> {
  try {
    const st = await stat(FILE).catch(() => null);
    if (!st) return 0;
    const buf = await readFile(FILE, "utf8").catch(() => "");
    return buf.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
