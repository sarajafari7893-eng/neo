// ── NEXUS//SIGNALS SENIOR-ENGINEER BRIDGE (server-only, v6.4) ──
// Operator question (chat): «میشه به محیط چت تو و سندباکس دسترسی داشته باشه
// تا در صورت نیاز در تغییرات کد از تو درخواست کنه؟»
//
// The AI core (governor / deep-learn / analyst) runs INSIDE the Next.js app;
// the senior engineer (the sandbox coding agent that reviews this project on a
// cron) runs OUTSIDE it — but both share this filesystem. The bridge is a
// pair of JSONL queues in <project>/sandbox-inbox/:
//
//   engineer-requests.jsonl   → the AI core FILES code-change/data requests
//   engineer-responses.jsonl  → the engineer APPENDS outcomes (done/rejected)
//
// The engine tick polls responses and fires audited ENGINE events, so every
// engineering action the AI core requested appears in the operator's event
// feed and Telegram relay. Requests are also visible in /api/ai/agent.
// Nothing here invents data: files are read best-effort, every failure
// degrades to "no requests" and is swallowed by design.

import fs from "node:fs/promises";
import path from "node:path";

const INBOX_DIR = path.join(process.cwd(), "sandbox-inbox");
const REQ_PATH = path.join(INBOX_DIR, "engineer-requests.jsonl");
const RES_PATH = path.join(INBOX_DIR, "engineer-responses.jsonl");
// v6.4.1 OPERATOR→ENGINEER lane — the operator asked «به چه دستوری به پل پیام
// بدم؟». Now there is a real channel: the dashboard's ENGINEER BRIDGE card (or
// POST /api/bridge) lands the message in operator-requests.jsonl; the senior
// engineer reads the inbox every review cycle, implements, and answers via
// engineer-responses.jsonl — which the engine poller surfaces as audited
// ENGINE events (terminal feed + Telegram mirror). Full round trip, no CLI.
const OPR_PATH = path.join(INBOX_DIR, "operator-requests.jsonl");

export interface EngineerRequest {
  id: string;
  at: string;
  source: string; // "governor" | "deep-learn" | "analyst" | "supervisor" | "operator"
  kind: "CODE_CHANGE" | "DATA_NEED" | "SCOPE_LIMIT" | "RESEARCH";
  priority: "low" | "normal" | "high";
  title: string;
  detail: string;
}

export interface EngineerResponse {
  id: string;
  at: string;
  requestId?: string;
  title: string;
  status: "DONE" | "PARTIAL" | "REJECTED" | "NOTED";
  note: string;
}

const REQ_CAP = 80; // lines kept per file (self-pruning)

async function appendLine(file: string, obj: unknown): Promise<void> {
  try {
    await fs.mkdir(INBOX_DIR, { recursive: true });
    let lines: string[] = [];
    try {
      lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    } catch {
      /* fresh file */
    }
    lines.push(JSON.stringify(obj));
    if (lines.length > REQ_CAP) lines = lines.slice(-REQ_CAP);
    await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
  } catch (err) {
    console.error("[engineer-bridge] append failed", err);
  }
}

async function readLines<T>(file: string, take: number): Promise<T[]> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .slice(-take)
      .map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

// ── request filing (AI core side) ────────────────────────────────────────────

let recentTitles: Array<{ title: string; at: number }> = [];
const DEDUPE_MS = 12 * 3600_000; // the same request must not spam the inbox

/** File an engineering request into the sandbox inbox (best-effort, audited). */
export async function fileEngineerRequest(req: Omit<EngineerRequest, "id" | "at">): Promise<boolean> {
  const now = Date.now();
  recentTitles = recentTitles.filter((r) => now - r.at < DEDUPE_MS);
  if (recentTitles.some((r) => r.title === req.title)) return false; // dedupe
  recentTitles.push({ title: req.title, at: now });
  const full: EngineerRequest = { id: `ER-${now.toString(36)}`, at: new Date().toISOString(), ...req };
  await appendLine(REQ_PATH, full);
  console.log(`[engineer-bridge] REQUEST FILED ${full.id} [${req.kind}/${req.priority}] ${req.title}`);
  return true;
}

export function readEngineerRequests(take = 20): Promise<EngineerRequest[]> {
  return readLines<EngineerRequest>(REQ_PATH, take);
}

export function readEngineerResponses(take = 20): Promise<EngineerResponse[]> {
  return readLines<EngineerResponse>(RES_PATH, take);
}

// ── operator lane (v6.4.1) — dashboard ENGINEER BRIDGE card / POST /api/bridge ──

export interface OperatorRequest {
  id: string;
  at: string;
  from: "operator";
  message: string;
  status: "OPEN" | "DONE" | "REJECTED"; // OPEN until the engineer answers it
}

/** File an operator message into the engineer inbox. Returns null when invalid. */
export async function fileOperatorRequest(message: string): Promise<OperatorRequest | null> {
  const msg = message.trim().slice(0, 500);
  if (msg.length < 3) return null;
  const full: OperatorRequest = { id: `OPR-${Date.now().toString(36)}`, at: new Date().toISOString(), from: "operator", message: msg, status: "OPEN" };
  await appendLine(OPR_PATH, full);
  console.log(`[engineer-bridge] OPERATOR REQUEST FILED ${full.id}: "${msg.slice(0, 80)}${msg.length > 80 ? "…" : ""}"`);
  return full;
}

export function readOperatorRequests(take = 20): Promise<OperatorRequest[]> {
  return readLines<OperatorRequest>(OPR_PATH, take);
}

/** Mark every OPEN operator request as picked up (engineer review cycle ran). */
export async function acknowledgeOperatorRequests(): Promise<void> {
  try {
    const lines = await readOperatorRequests(REQ_CAP);
    if (!lines.length || !lines.some((l) => l.status === "OPEN")) return;
    const updated = lines.map((l) => (l.status === "OPEN" ? { ...l, status: "DONE" as const } : l));
    await fs.writeFile(OPR_PATH, updated.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

// ── response polling (engine side) — new responses become ENGINE events ─────

const SEEN_KEY = "engineer.responses.seen";
let seenIds: string[] = [];

/** Called from the engine tick: fire an ENGINE event per unseen response. */
export async function pollEngineerResponses(): Promise<void> {
  try {
    const responses = await readEngineerResponses(30);
    if (!responses.length) return;
    if (!seenIds.length) {
      const { db } = await import("./db");
      const row = await db.engineSetting.findUnique({ where: { key: SEEN_KEY } });
      seenIds = row ? (JSON.parse(row.value) as string[]) : [];
    }
    const fresh = responses.filter((r) => !seenIds.includes(r.id));
    if (!fresh.length) return;
    const { fireEvent } = await import("./engine");
    for (const r of fresh) {
      await fireEvent(null, null, "ENGINE", "ai", `SENIOR ENGINEER (${r.status}): ${r.title}${r.note ? ` — ${r.note}` : ""}`);
    }
    seenIds = [...seenIds, ...fresh.map((r) => r.id)].slice(-60);
    const { db } = await import("./db");
    await db.engineSetting.upsert({ where: { key: SEEN_KEY }, create: { key: SEEN_KEY, value: JSON.stringify(seenIds) }, update: { value: JSON.stringify(seenIds) } });
  } catch (err) {
    console.error("[engineer-bridge] poll failed", err);
  }
}
