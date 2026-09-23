// ── FlowRadar Neo v8.3 TELEGRAM COMMUNICATION BRIDGE (server-only) ─────────
// Operator round 2026-09-11: «ساخت یک پل ارتباطی در تلگرام تا بتونم در این
// محیط در ارتباط باشیم + دستور ارسال پیام از طریق پل تلگرام».
//
// WHAT THIS IS
//   A persistent getUpdates long-poll loop (started once per server process
//   from src/instrumentation.ts) that turns the one-way relay into a TWO-WAY
//   bridge:
//     • INBOUND  — every private text message the operator sends to
//       @Neo_agentaibot is appended to db/bridge/inbox.ndjson (the session
//       transcript this assistant reads at every invocation).
//     • OUTBOUND — replies travel through the existing notify relay
//       (sendDirect) and are logged to db/bridge/outbox.ndjson.
//     • AUTO-REPLY — optional (default ON): the live FLOWRADAR-NEO AI analyst
//       (aiChat + fresh telemetry grounding, same stack as /api/ai/chat)
//       answers operator messages immediately so the bridge is alive 24/7
//       even between assistant work sessions. Every auto reply is marked
//       with a 🤖 prefix so the operator can distinguish it from the
//       human-in-the-loop assistant answers.
//
// WHY FILE-BASED STATE (no Prisma schema change)
//   The 2026-09-08 restore post-mortem forbids touching the live SQLite file
//   casually; the bridge stores its offset/transcript in db/bridge/*.ndjson +
//   state.json — zero schema migrations, snapshot-friendly, human-readable.
//
// SAFETY
//   • Only PRIVATE chats are ingested; group noise is ignored.
//   • INGEST ALLOWLIST (task 4-b · audit P0-1 / incident 0912 class): once the
//     operator chat is resolved (EngineSetting telegram.chatId or env), a
//     private message is appended to inbox.ndjson ONLY if its chat id EQUALS
//     the operator chat — the inbox is treated as operator mandates, so any
//     other chat is dropped (impersonation/injection path closed) with a
//     rate-limited (10min) console.warn. While the chat is UNRESOLVED the
//     documented first-contact bootstrap binding stays (the first private
//     chat that messages the bot arms the bridge — mirrors notify.ts discover
//     semantics) with an explicit rate-limited warn so the impersonation
//     window is visible in logs.
//   • ROTATION (task 4-b · audit P2): before an append, if the ndjson is
//     > 4MB it is renamed to <name>.old (replacing any previous .old) —
//     best-effort, never throws into the poll loop.
//   • Once the operator chat is resolved (EngineSetting telegram.chatId or
//     env), auto-replies go ONLY to that chat; if unresolved, the first
//     private chat that messages the bot effectively arms the bridge
//     (mirrors notify.ts discover semantics).
//   • LLM replies are rate-limited (≥12s gap) and truncated (≤3800 chars).
//   • Poll failures back off 5s→30s and never crash the loop; the offset is
//     persisted BEFORE slow auto-reply work so a crash can never double-reply.
//   • Optional shared-secret: if BRIDGE_TOKEN is set, the /api/telegram/
//     bridge route requires header X-Bridge-Token (loop-internal calls are
//     unaffected).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { sendDirect } from "./notify";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ENV_CHAT = process.env.TELEGRAM_CHAT_ID ?? "";
const CHAT_OVERRIDE_KEY = "telegram.chatId";
const BRIDGE_DIR = path.join(process.cwd(), "db", "bridge");
const STATE_FILE = path.join(BRIDGE_DIR, "state.json");
const INBOX_FILE = path.join(BRIDGE_DIR, "inbox.ndjson");
const OUTBOX_FILE = path.join(BRIDGE_DIR, "outbox.ndjson");
const TASK_QUEUE_FILE = path.join(BRIDGE_DIR, "task-queue.ndjson");
const POLL_TIMEOUT_S = 25;
const AUTO_REPLY_MIN_GAP_MS = 12_000;
const MAX_TEXT = 4000;

// ── v8.4 TELEGRAM OPS INTAKE (operator round 2026-09-23) ────────────────────
// «پل تلگرام پیام های ارسالی به محیط سندباکس را نمی خواند» — root cause: the
// Telegram message WAS ingested and even answered by the LLM auto-reply, but
// it never reached the engineering agent — the platform IM gateway (zai-web)
// is a separate channel with no local injection API, so real engineering
// tasks died silently in the transcript. FIX: every ingested operator text is
// durably queued here with a TQ id and ACKed in Telegram immediately
// (independent of the 12s-rate-limited LLM auto-reply). Pickup paths:
//   (a) the agent reads this queue at every session start (worklog protocol),
//   (b) the nightly senior-review TELEGRAM INTAKE section lists open items —
// so nothing stays unread. Append-only: completion = a NEW line, same id,
// status "picked"/"done" (last line per id wins — no in-place rewrites).

export interface BridgeState {
  offset: number;
  autoReply: boolean;
  startedAt: number | null;
  lastPollAt: number | null;
  lastIngestAt: number | null;
  lastReplyAt: number | null;
  polls: number;
  ingested: number;
  replies: number;
  errors: number;
  lastError: string | null;
}

export interface BridgeMessage {
  ts: number;
  chatId: string;
  from: string;
  username: string | null;
  text: string;
  updateId?: number;
  replied?: "auto" | "assistant" | "failed" | "skipped";
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string; first_name?: string; username?: string };
    from?: { id: number; is_bot: boolean; first_name?: string; username?: string };
    text?: string;
  };
}

const DEFAULT_STATE: BridgeState = {
  offset: 0,
  autoReply: true,
  startedAt: null,
  lastPollAt: null,
  lastIngestAt: null,
  lastReplyAt: null,
  polls: 0,
  ingested: 0,
  replies: 0,
  errors: 0,
  lastError: null,
};

function loadState(): BridgeState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<BridgeState>) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(s: BridgeState): void {
  try {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
  } catch (e) {
    console.error("[BRIDGE] state persist failed", e);
  }
}

function appendNdjson(file: string, obj: unknown): void {
  try {
    fs.mkdirSync(BRIDGE_DIR, { recursive: true });
    rotateNdjsonIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(obj) + "\n");
  } catch (e) {
    console.error(`[BRIDGE] append ${path.basename(file)} failed`, e);
  }
}

// ── ROTATION (task 4-b · audit P2: bridge ndjson unbounded) ──────────────────
const ROTATE_BYTES = 4 * 1024 * 1024; // 4MB
function rotateNdjsonIfNeeded(file: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) {
      fs.renameSync(file, `${file}.old`); // POSIX rename replaces any previous .old
      console.log(`[BRIDGE] rotated ${path.basename(file)} → ${path.basename(file)}.old`);
    }
  } catch {
    /* best-effort — never throw into the poll loop */
  }
}

function tailNdjson<T>(file: string, n: number): T[] {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-n).map((l) => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

async function tgCall<T>(method: string, body: unknown, timeoutMs = 4500): Promise<{ ok: boolean; result?: T; error?: string }> {
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — bridge dormant" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      cache: "no-store",
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    return json.ok ? { ok: true, result: json.result } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? (e.name === "AbortError" ? `timeout ${timeoutMs}ms` : e.message) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

let botIdCache: number | null = null;

async function botIdentity(): Promise<number | null> {
  if (botIdCache !== null) return botIdCache;
  const r = await tgCall<{ id: number }>("getMe", {}, 6000);
  if (r.ok && r.result?.id) {
    botIdCache = r.result.id;
    return botIdCache;
  }
  return null;
}

/** The operator chat id (EngineSetting override wins over env). */
async function operatorChatId(): Promise<string | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: CHAT_OVERRIDE_KEY } });
    if (row?.value) return row.value;
  } catch { /* db hiccup — fall through to env */ }
  return ENV_CHAT || null;
}

/** Public API ────────────────────────────────────────────────────────────── */

export function bridgeStatus(): BridgeState & { files: string[] } {
  const s = loadState();
  const files: string[] = [];
  for (const f of [STATE_FILE, INBOX_FILE, OUTBOX_FILE]) {
    try {
      const st = fs.statSync(f);
      files.push(`${path.basename(f)}:${st.size}B`);
    } catch { /* absent */ }
  }
  return { ...s, files };
}

export function bridgeRecent(limit = 80): { inbox: BridgeMessage[]; outbox: BridgeMessage[] } {
  const n = Math.max(1, Math.min(500, limit));
  return {
    inbox: tailNdjson<BridgeMessage>(INBOX_FILE, n),
    outbox: tailNdjson<BridgeMessage>(OUTBOX_FILE, n),
  };
}

/** Assistant / API send path — logs to outbox, delivers via the relay. */
export async function bridgeSend(text: string, via = "api"): Promise<{ ok: boolean; error?: string }> {
  const t = text.trim().slice(0, 3800);
  if (!t) return { ok: false, error: "empty text" };
  const r = await sendDirect(t);
  appendNdjson(OUTBOX_FILE, { ts: Date.now(), via, text: t, ok: r.ok, error: r.error ?? null } as Record<string, unknown>);
  return { ok: r.ok, error: r.error };
}

export function setAutoReply(on: boolean): BridgeState {
  const s = loadState();
  s.autoReply = on;
  saveState(s);
  return s;
}

/** Send a FILE (document) to the operator chat — used for report delivery. */
export async function sendDocumentDirect(caption: string, doc: Buffer, filename: string): Promise<{ ok: boolean; error?: string }> {
  const chat = await operatorChatId();
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — bridge dormant" };
  if (!chat) return { ok: false, error: "chat unresolved — message the bot once, then retry" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const form = new FormData();
    form.append("chat_id", chat);
    form.append("caption", caption.slice(0, 1024));
    form.append("document", new Blob([new Uint8Array(doc)]), filename);
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, { method: "POST", body: form, signal: ctrl.signal, cache: "no-store" });
    const json = (await res.json()) as { ok: boolean; description?: string };
    if (json.ok) appendNdjson(OUTBOX_FILE, { ts: Date.now(), via: "document", text: caption.slice(0, 200), ok: true, error: null } as Record<string, unknown>);
    return json.ok ? { ok: true } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? (e.name === "AbortError" ? "timeout 20000ms" : e.message) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Ingest one batch of updates. Returns the number of NEW operator texts.
 * Cross-instance mutex: two compiled bundles (instrumentation + route) share
 * the process, and Telegram 409s on concurrent getUpdates — the globalThis
 * in-flight flag serializes them (a skipped poll is harmless). */
const POLL_GUARD = "__nexusBridgePollInFlight";
async function pollOnce(longPoll: boolean): Promise<number> {
  const g = globalThis as unknown as { [POLL_GUARD]?: boolean };
  if (g[POLL_GUARD]) return 0;
  g[POLL_GUARD] = true;
  try {
    return await pollOnceInner(longPoll);
  } finally {
    g[POLL_GUARD] = false;
  }
}

async function pollOnceInner(longPoll: boolean): Promise<number> {
  const s = loadState();
  const r = await tgCall<TgUpdate[]>(
    "getUpdates",
    { offset: s.offset || undefined, timeout: longPoll ? POLL_TIMEOUT_S : 0, allowed_updates: ["message"] },
    longPoll ? (POLL_TIMEOUT_S + 8) * 1000 : 8000
  );
  s.polls++;
  s.lastPollAt = Date.now();
  if (!r.ok || !r.result) {
    s.errors++;
    s.lastError = r.error ?? "getUpdates empty";
    saveState(s);
    throw new Error(r.error ?? "getUpdates failed");
  }
  let ingested = 0;
  let maxId = s.offset;
  const msgs: BridgeMessage[] = [];
  for (const u of r.result) {
    maxId = Math.max(maxId, u.update_id + 1);
    const m = u.message;
    if (!m || m.chat.type !== "private") continue;
    const text = (m.text ?? "").slice(0, MAX_TEXT);
    if (!text) continue; // photos/stickers ignored in v1
    if (m.from?.is_bot) continue;
    msgs.push({
      ts: Date.now(),
      chatId: String(m.chat.id),
      from: m.chat.first_name ?? m.chat.username ?? "operator",
      username: m.chat.username ?? null,
      text,
      updateId: u.update_id,
    });
  }
  // persist offset FIRST — a later crash must never re-process this batch
  s.offset = maxId;
  saveState(s);
  // ── INGEST ALLOWLIST (task 4-b · audit P0-1) ─────────────────────────────
  // inbox.ndjson is read by the agent layer as OPERATOR MANDATES — only the
  // resolved operator chat may land there. Resolve once per batch.
  const opChat = await operatorChatId();
  const accepted: BridgeMessage[] = [];
  for (const msg of msgs) {
    if (opChat && msg.chatId !== opChat) {
      if (Date.now() - lastIngestWarnAt >= INGEST_WARN_GAP_MS) {
        lastIngestWarnAt = Date.now();
        console.warn(`[BRIDGE] ingest rejected: chat mismatch (chat ${msg.chatId.slice(0, 3)}***${msg.chatId.slice(-2)} ≠ operator) — update NOT appended`);
      }
      continue;
    }
    if (!opChat && Date.now() - lastIngestWarnAt >= INGEST_WARN_GAP_MS) {
      lastIngestWarnAt = Date.now();
      console.warn("[BRIDGE] ingest allowed via BOOTSTRAP: operator chat unresolved — first-contact binding is arming the bridge (impersonation window until chatId is pinned)");
    }
    accepted.push(msg);
  }
  for (const msg of accepted) {
    appendNdjson(INBOX_FILE, msg);
    ingested++;
    s.ingested++;
    s.lastIngestAt = msg.ts;
  }
  if (accepted.length > 0) saveState(s);
  // v8.4 OPS INTAKE — durable queue + Telegram ack BEFORE any LLM latency
  await intakeTasks(accepted);
  for (const msg of accepted) await maybeAutoReply(msg, s);
  return ingested;
}

/** v8.4 — queue every accepted operator text as an open task + ack the chat. */
async function intakeTasks(msgs: BridgeMessage[]): Promise<void> {
  if (msgs.length === 0) return;
  const ids: string[] = [];
  for (const msg of msgs) {
    const id = `TQ-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    ids.push(id);
    appendNdjson(TASK_QUEUE_FILE, { id, ts: msg.ts, text: msg.text, status: "open" });
  }
  try {
    const open = countOpenTasks();
    const head = msgs.length === 1 ? "پیام شما" : `${msgs.length} پیام شما`;
    await sendDirect(
      `📥 ${head} در «صف مهندسی سندباکس» ثبت شد (${ids.join(", ")}) — باز: ${open}.\n` +
      "ایجنت در نخستین سشن کاری آن را برمی‌دارد؛ برای پاسخ لحظه‌ای از کانال وب استفاده کنید."
    );
  } catch { /* ack is best-effort — the queue row is the durable record */ }
}

/** v8.4 — open-task count: last line per id wins (append-only queue). */
export function countOpenTasks(): number {
  try {
    const statusById = new Map<string, string>();
    for (const line of fs.readFileSync(TASK_QUEUE_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { id?: string; status?: string };
        if (j.id) statusById.set(j.id, j.status ?? "open");
      } catch { /* torn line → skip */ }
    }
    let n = 0;
    for (const st of statusById.values()) if (st === "open" || st === "picked") n++;
    return n;
  } catch { return 0; /* queue file not created yet */ }
}

/** v8.4 — open tasks for callers that render them (senior-review, dashboard). */
export function readOpenTasks(limit = 10): { id: string; ts: number; text: string; status: string }[] {
  try {
    const lastById = new Map<string, { id: string; ts: number; text: string; status: string }>();
    for (const line of fs.readFileSync(TASK_QUEUE_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { id?: string; ts?: number; text?: string; status?: string };
        if (!j.id) continue;
        const prev = lastById.get(j.id);
        lastById.set(j.id, { id: j.id, ts: j.ts ?? prev?.ts ?? 0, text: j.text ?? prev?.text ?? "", status: j.status ?? "open" });
      } catch { /* torn line → skip */ }
    }
    const open = [...lastById.values()].filter((t) => t.status === "open" || t.status === "picked");
    open.sort((a, b) => a.ts - b.ts); // oldest first — longest-waiting on top
    return open.slice(0, limit);
  } catch { return []; }
}

// rate-limited (10min) warn throttle for ingest allowlist rejections/bootstrap
const INGEST_WARN_GAP_MS = 10 * 60_000;
let lastIngestWarnAt = 0;

let lastAutoReplyAt = 0;

async function maybeAutoReply(msg: BridgeMessage, s: BridgeState): Promise<void> {
  if (!s.autoReply) return;
  // only the resolved operator chat gets LLM replies (unknown chats are just logged)
  const op = await operatorChatId();
  // (4-b) the poll loop already allow-lists ingest by operator chat; this
  // re-check keeps the reply path safe independently of the ingest path.
  if (op && msg.chatId !== op) return;
  if (Date.now() - lastAutoReplyAt < AUTO_REPLY_MIN_GAP_MS) {
    appendNdjson(OUTBOX_FILE, { ts: Date.now(), via: "auto", text: "(skipped — rate limit)", ok: false, error: "rate-limit" } as Record<string, unknown>);
    return;
  }
  lastAutoReplyAt = Date.now();
  const mark = (replied: BridgeMessage["replied"]) => {
    try {
      // stamp the just-appended inbox row by rewriting the tail line (cheap, our own file)
      const raw = fs.readFileSync(INBOX_FILE, "utf8");
      const idx = raw.lastIndexOf(JSON.stringify(msg));
      if (idx >= 0) {
        const end = raw.indexOf("\n", idx);
        const stamped = JSON.stringify({ ...msg, replied });
        fs.writeFileSync(INBOX_FILE, raw.slice(0, idx) + stamped + (end >= 0 ? raw.slice(end) : ""));
      }
    } catch { /* stamping is cosmetic */ }
  };
  try {
    const { aiChat } = await import("./ai");
    const { buildAnalystGrounding } = await import("./analyst-context");
    const grounding = await buildAnalystGrounding();
    const reply = await aiChat([{ role: "user", content: msg.text }], grounding);
    const out = `🤖 FLOWRADAR-NEO:\n${String(reply).slice(0, 3500)}`;
    const r = await sendDirect(out);
    s.replies++;
    s.lastReplyAt = Date.now();
    saveState(s);
    appendNdjson(OUTBOX_FILE, { ts: Date.now(), via: "auto", text: out, ok: r.ok, error: r.error ?? null } as Record<string, unknown>);
    mark(r.ok ? "auto" : "failed");
  } catch (e) {
    s.errors++;
    s.lastError = `auto-reply: ${e instanceof Error ? e.message : String(e)}`;
    saveState(s);
    mark("failed");
  }
}

const BEAT_KEY = "__nexusBridgeBeat";
function beat(now = true): number {
  const g = globalThis as unknown as { [BEAT_KEY]?: number };
  if (now) g[BEAT_KEY] = Date.now();
  return g[BEAT_KEY] ?? 0;
}

/** Self-heal hook — cheap enough for hot routes (/api/pulse): if the long-poll
 * loop has not shown a heartbeat for 90s (or never started), re-arm it.
 * Throttled to one check per 30s via the same global beat read. */
export function ensureBridgeLoopAlive(): void {
  const g = globalThis as unknown as { __nexusBridgeEnsureAt?: number };
  const last = beat(false);
  const now = Date.now();
  if (last && now - last < 90_000) return;
  if (g.__nexusBridgeEnsureAt && now - g.__nexusBridgeEnsureAt < 30_000) return;
  g.__nexusBridgeEnsureAt = now;
  if (!TOKEN) return;
  console.log(`[BRIDGE] ensure-loop ${last ? `stale beat ${Math.round((now - last) / 1000)}s — re-arming` : "first arm"}`);
  const s = loadState();
  s.startedAt = s.startedAt ?? now;
  saveState(s);
  beat();
  setTimeout(() => void bridgeLoop().catch(() => undefined), 500);
}

/** Loop body — never throws. */
async function bridgeLoop(): Promise<void> {
  let backoff = 5000;
  for (;;) {
    try {
      await pollOnce(true);
      beat();
      backoff = 5000;
    } catch (e) {
      beat();
      await new Promise((res) => setTimeout(res, backoff));
      backoff = Math.min(30000, backoff * 1.5);
      console.error(`[BRIDGE] poll error (${e instanceof Error ? e.message : String(e)}) — backing off ${Math.round(backoff / 1000)}s`);
    }
  }
}

const GLOBAL_KEY = "__nexusBridgeStarted";

/** Idempotent bootstrap — called from src/instrumentation.ts at server boot. */
export function startBridgePoller(): void {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: boolean };
  if (g[GLOBAL_KEY]) return;
  g[GLOBAL_KEY] = true;
  if (!TOKEN) {
    console.log("[BRIDGE] TELEGRAM_BOT_TOKEN unset — bridge dormant (will never poll)");
    return;
  }
  const s = loadState();
  s.startedAt = Date.now();
  saveState(s);
  beat();
  console.log(`[BRIDGE] starting — offset ${s.offset}, autoReply ${s.autoReply ? "ON" : "OFF"}`);
  setTimeout(() => void bridgeLoop().catch(() => undefined), 6000);
}

/** One fast non-blocking poll (timeout 0) — used by the route "sync" action. */
export async function bridgePollOnceFast(): Promise<number> {
  return pollOnce(false);
}
