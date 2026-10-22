// ── NEXUS-LIVE TELEGRAM BRIDGE RELAY v1.2.1 — operator round 2026-09-11
// v1.2.1 (task 17, 2026-09-22 canary incident): STALE-ENV CLASS FIX. The relay
//   boots ~4s BEFORE env-guard restores an erased/rotated .env, so the
//   boot-once CONTROL_KEY/TOKEN froze pre-restore values → fail-closed 401 on
//   every gated route (UI-CANARY went AMBER "BRIDGE(HTTP 401)"; the watchdog
//   could never see it because /health is open). TOKEN + CONTROL_KEY are now
//   resolved LAZILY per use: process.env first, then .env re-read only when
//   its mtime changed (mtime-cached — zero steady-state cost). After any
//   env-guard restore or key rotation the relay self-heals on the next
//   request, no restart needed. Fail-closed semantics unchanged; key value is
//   never echoed/logged.
// v1.2 (task 4-b · audit P0-1): control gate — `x-nexus-key` header (matching
//   NEXUS_CONTROL_KEY from env/.env) is now REQUIRED on POST /send, POST /read
//   and GET /inbox (privacy-sensitive). GET /health stays open (probes).
//   Fail-closed when the key is unset. Key value is never echoed/logged.
//   (Historical: pre-20260919-restore v1.2 by task 5-d added x-bridge-token;
//   that tree was reverted by the snapshot restore — this v1.2 re-lands the
//   gate under the unified NEXUS_CONTROL_KEY header.)
// Operator: «ساخت یک پل ارتباطی در تلگرام تا بتونم در این محیط در ارتباط باشم
// + دستور ارسال پیام از طریق پل تلگرام»
//
// ARCHITECTURE (v1.1 — after discovering the in-app bridge):
//   · The Next.js app (src/lib/telegram-bridge.ts, booted from
//     instrumentation.ts) is the SOLE getUpdates consumer — it long-polls,
//     persists db/bridge/inbox.ndjson, and runs the LLM autoReply.
//     A second getUpdates consumer here would steal updates from it.
//   · THIS out-of-process service (:3005) is the resilient half:
//       POST /send {text}            → sendMessage straight to the operator
//                                       chat (works even while the Next dev
//                                       server is down / recompiling)
//       GET  /inbox                  → live MIRROR of db/bridge/inbox.ndjson
//                                       (+ unread tracking via lastReadAt)
//       POST /read                   → mark mirror read
//       GET  /health                 → armed / chat / app-bridge heartbeat
//   · Config: TELEGRAM_BOT_TOKEN from env or /home/z/my-project/.env; chatId
//     from main-DB EngineSetting('telegram.chatId') → state/chat.json.

import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

const ROOT = "/home/z/my-project";
const STATE = path.join(import.meta.dir, "state");
const INBOX_NDJSON = path.join(ROOT, "db", "bridge", "inbox.ndjson");
const APP_STATE = path.join(ROOT, "db", "bridge", "state.json");
const PORT = 3005;
fs.mkdirSync(STATE, { recursive: true });

// ── singleton guard (v1.2.2, 2026-09-23) ──
// The platform spawner (.zscripts/dev.sh) double-started every mini-service on
// the morning boot — the relay zombie sat idle (EADDRINUSE), but the same
// class of duplicate on a polling service burns exchange weight and on THIS
// service could double-send. Guard: pid lockfile; a second live instance
// exits before binding. bun --hot re-evals with the SAME pid → keeps the lock.
const RELAY_LOCK = path.join(STATE, "relay.pid");
try {
  const prev = Number(fs.readFileSync(RELAY_LOCK, "utf8").trim());
  if (prev && prev !== process.pid) {
    try {
      process.kill(prev, 0);
      console.error(`[RELAY] another relay instance is alive (pid ${prev}) — exiting`);
      process.exit(0);
    } catch { /* stale lock — take over */ }
  }
} catch { /* first boot */ }
fs.writeFileSync(RELAY_LOCK, String(process.pid));

// ── env bootstrap (boot seed; v1.2.1 makes resolution lazy below) ──
if (!process.env.TELEGRAM_BOT_TOKEN) {
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.trim();
    }
  } catch { /* no .env — stay dormant */ }
}

// ── lazy env resolution (v1.2.1 stale-env fix) ──
// process.env wins (env-guard heals the spawner's children when present);
// .env is re-read only when its mtime changed, so a boot that raced an
// env-guard restore picks up the restored file on the very next use.
const ENV_PATH = path.join(ROOT, ".env");
let dotenvCache: { mtimeMs: number; values: Map<string, string> } | null = null;
function dotenvValues(): Map<string, string> {
  try {
    const st = fs.statSync(ENV_PATH);
    if (!dotenvCache || dotenvCache.mtimeMs !== st.mtimeMs) {
      const values = new Map<string, string>();
      for (const line of fs.readFileSync(ENV_PATH, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m && m[1] && m[2]) values.set(m[1], m[2].trim());
      }
      dotenvCache = { mtimeMs: st.mtimeMs, values };
    }
  } catch { dotenvCache = null; /* erased mid-restore → fail-closed */ }
  return dotenvCache ? dotenvCache.values : new Map();
}
function envGet(key: string): string {
  // Task 36: .env FILE first (live source of truth, mtime-cached) — the boot
  // process.env is frozen and inherited stale by heal-spawn chains (proven:
  // old key kept validating after rotation). process.env is fallback only.
  const fromFile = dotenvValues().get(key);
  if (fromFile && fromFile.length > 0) return fromFile;
  const v = process.env[key];
  return v && v.length > 0 ? v : "";
}
const TOKEN = (): string => envGet("TELEGRAM_BOT_TOKEN");
const BOT_ID = (): string => (TOKEN() ? TOKEN().split(":")[0]! : "");

// ── control gate (task 4-b · audit P0-1) ──
// NEXUS_CONTROL_KEY resolved lazily (see above). Fail-closed: if the key
// cannot be resolved, every gated route returns 401.
function controlOk(req: Request): boolean {
  const CONTROL_KEY = envGet("NEXUS_CONTROL_KEY");
  if (!CONTROL_KEY) return false; // fail-closed
  const provided = req.headers.get("x-nexus-key") ?? "";
  if (provided.length !== CONTROL_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ CONTROL_KEY.charCodeAt(i);
  return diff === 0; // constant-time
}

// ── chat resolution (EngineSetting → state/chat.json) ──
interface AppBridgeState { chatId?: string | null; offset?: number; lastIngestAt?: number; startedAt?: number; lastPollAt?: number; autoReply?: boolean; errors?: number; }
const readJson = <T>(p: string, fb: T): T => { try { return JSON.parse(fs.readFileSync(p, "utf8")) as T; } catch { return fb; } };
const chatStatePath = path.join(STATE, "chat.json");
let chatId = "";

function resolveChat(): void {
  let fromDb = "";
  try {
    const db = new Database(path.join(ROOT, "db", "custom.db"), { readonly: true });
    const row = db.query(`SELECT value FROM EngineSetting WHERE key='telegram.chatId'`).get() as { value?: string } | undefined;
    fromDb = row?.value ?? "";
    db.close();
  } catch { /* db busy → skip */ }
  const botId = BOT_ID();
  const saved = readJson<{ chatId: string }>(chatStatePath, { chatId: "" }).chatId;
  chatId = (fromDb && fromDb !== botId ? fromDb : "") || (saved && saved !== botId ? saved : "");
  if (chatId) fs.writeFileSync(chatStatePath, JSON.stringify({ chatId }));
}

resolveChat();

// ── inbox mirror (tail the app bridge's ndjson) ──
interface MirrorMsg { id: string; from: string; username?: string | null; text: string; chatId: string; at: string; read: boolean; ts: number; }
const lastReadPath = path.join(STATE, "lastReadAt.txt");
function lastReadAt(): number { return Number((fs.existsSync(lastReadPath) ? fs.readFileSync(lastReadPath, "utf8") : "").trim()) || 0; }

function mirrorInbox(limit: number, unreadOnly: boolean): { messages: MirrorMsg[]; unread: number; total: number } {
  let rows: MirrorMsg[] = [];
  try {
    const raw = fs.readFileSync(INBOX_NDJSON, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { ts: number; chatId: string; from: string; username?: string | null; text: string; updateId: number; replied?: string };
        rows.push({
          id: String(j.updateId ?? j.ts),
          from: j.from ?? "operator",
          username: j.username ?? null,
          text: j.text ?? "",
          chatId: j.chatId ?? "",
          at: new Date(j.ts).toISOString(),
          ts: j.ts,
          read: j.ts <= lastReadAt(),
        });
      } catch { /* torn line → skip */ }
    }
  } catch { /* app bridge never wrote yet */ }
  const total = rows.length;
  const unread = rows.filter((m) => !m.read).length;
  if (unreadOnly) rows = rows.filter((m) => !m.read);
  return { messages: rows.slice(-limit).reverse(), unread, total };
}

// ── telegram send ──
async function sendToChat(text: string): Promise<{ ok: boolean; error?: string; message_id?: number }> {
  const token = TOKEN();
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — bridge dormant" };
  if (!chatId) return { ok: false, error: "chat unresolved — operator must message the bot once" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
    if (!j.ok) return { ok: false, error: j.description ?? "telegram rejected" };
    return { ok: true, message_id: j.result?.message_id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "telegram unreachable" };
  }
}

// ── HTTP API ──
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type, x-nexus-key",
};
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS } });

Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (p === "/health") {
      const app = readJson<AppBridgeState>(APP_STATE, {});
      const { unread, total } = mirrorInbox(1, false);
      return json({
        ok: true, service: "telegram-bridge-relay", armed: Boolean(TOKEN()),
        chatId: chatId ? `${chatId.slice(0, 3)}***${chatId.slice(-2)}` : null,
        chatResolved: Boolean(chatId),
        appBridge: { lastPollAt: app.lastPollAt ?? null, lastIngestAt: app.lastIngestAt ?? null, autoReply: app.autoReply ?? null, errors: app.errors ?? 0 },
        unread, total,
      });
    }

    if (p === "/inbox") {
      if (!controlOk(req)) return json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, 401); // privacy-sensitive mirror (4-b)
      const unreadOnly = url.searchParams.get("unread") === "1";
      const n = Math.min(Number(url.searchParams.get("n") ?? 50) || 50, 200);
      const { messages, unread, total } = mirrorInbox(n, unreadOnly);
      return json({ ok: true, unread, total, messages });
    }

    if (p === "/read" && req.method === "POST") {
      if (!controlOk(req)) return json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, 401); // mutating (4-b)
      const { total } = mirrorInbox(1, false);
      const newestTs = (() => {
        const { messages } = mirrorInbox(1, false);
        return messages[0]?.ts ?? Date.now();
      })();
      fs.writeFileSync(lastReadPath, String(newestTs));
      return json({ ok: true, marked: total });
    }

    if (p === "/send" && req.method === "POST") {
      if (!controlOk(req)) return json({ ok: false, error: "unauthorized: mutating API requires x-nexus-key header" }, 401); // mutating (4-b)
      const body = (await req.json().catch(() => ({}))) as { text?: string };
      const text = (body.text ?? "").trim();
      if (!text) return json({ ok: false, error: "text required" }, 400);
      const r = await sendToChat(text);
      if (r.ok) console.log(`[RELAY] → sent (message_id ${r.message_id}): ${text.slice(0, 60)}`);
      return json(r.ok ? { ok: true, message_id: r.message_id, chatId } : { ok: false, error: r.error }, r.ok ? 200 : (r.error?.includes("unresolved") ? 409 : 502));
    }

    return json({ ok: false, error: "unknown route" }, 404);
  },
});

console.log(`[RELAY] telegram-bridge-relay v1.2.1 on :${PORT} — armed=${Boolean(TOKEN())} chat=${chatId ? "resolved" : "pending"} control-gate=${envGet("NEXUS_CONTROL_KEY") ? "on (lazy-self-heal)" : "FAIL-CLOSED"} (polling delegated to app bridge)`);
