// ── FlowRadar Neo v6.3 outbound relay (server-only) ───────────────────────
// TELEGRAM mirror for ALERTABLE engine events. v6.3 operator round:
// «اصلاح ساختار پیام‌های تلگرامی — چیدمان مرتب و خط به خط با ایموجی، و
// تصویر برای سیگنالهای win / stop / EXPIRED». Every relay now sends a
// STRUCTURED HTML card (tidy line-by-line, emoji-labelled fields) and the
// three outcome classes get a RENDERED BANNER IMAGE (dependency-free PNG
// from telegram-image.ts): WIN (TP1/TP2/TP3, mint), STOP (SL, danger),
// EXPIRED (TTL_EXPIRED, amber). Card fields come from the REAL signal row —
// nothing is invented; when the row is unavailable the engine message line
// is relayed verbatim as the honest fallback.
//
// Delivery remains fire-and-forget with hard timeouts so Telegram can never
// stall the engine tick; the error ring + counters feed /api/notify health.

import { db } from "@/lib/db";
import { APP_NAME } from "./brand";
import fs from "node:fs/promises";
import path from "node:path";
import { renderStatusBanner, type BannerStatus } from "./telegram-image";
import { renderSignalBannerV2, renderDailyPoster } from "./telegram-art";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ENV_CHAT = process.env.TELEGRAM_CHAT_ID ?? "";

const CHAT_OVERRIDE_KEY = "telegram.chatId";
const ERR_RING_CAP = 8;

export const RELAYABLE_TYPES = new Set(["CREATED", "TP1", "TP2", "TP3", "SL", "TTL_EXPIRED", "TTL_EXTENDED", "AFTERLIFE", "PUMP_RADAR", "EARLY_EXIT"]); // v10.4: + EARLY_EXIT — v8.4 R2/R7 early time-exits are real settle outcomes (7 of the last 8 closes) and were silently dropped from the operator mirror

const errRing: string[] = [];
let sentCount = 0;
let failCount = 0;
let lastSentAt: number | null = null;
let botId: number | null = null; // learned once via getMe
let botUsername: string | null = null;
let chatOverride: string | null = null; // EngineSetting override (wins over env)
let overrideLoaded = false;
let bootLogged = false;
let lastAutoDiscoverSkipLog = 0; // v10.16: dev.log spam throttle (was ~3.5k lines/day)

function pushErr(msg: string): void {
  errRing.unshift(`${new Date().toISOString().slice(11, 19)}Z ${msg}`);
  if (errRing.length > ERR_RING_CAP) errRing.pop();
}

/** Token present — synchronous cheap check used on the engine hot path. */
export function relayArmed(): boolean {
  return TOKEN.length > 0;
}

export function relayHealth(): {
  armed: boolean; tokenValid: boolean | null; botUsername: string | null;
  chatId: string | null; chatResolved: boolean; chatSource: "env" | "discovered" | "none";
  sent: number; failed: number; lastSentAt: number | null; lastErrors: string[];
} {
  const chat = chatOverride ?? ENV_CHAT;
  return {
    armed: relayArmed(),
    tokenValid: botId !== null ? true : null,
    botUsername,
    chatId: chat ? `${chat.slice(0, 3)}***${chat.slice(-2)}` : null,
    chatResolved: chat.length > 0 && botId !== null && chat !== String(botId),
    chatSource: chatOverride ? "discovered" : ENV_CHAT ? "env" : "none",
    sent: sentCount, failed: failCount, lastSentAt, lastErrors: [...errRing],
  };
}

/** Load the persisted chat override (EngineSetting telegram.chatId) once.
 * op-audit-20260908: must run BEFORE the boot log — the first boot log used to
 * print "DORMANT · TELEGRAM_CHAT_ID unset" even when the chat id was already
 * persisted, because ensureAutoDiscover→getMe logged before resolveChat ever
 * loaded the override. One DB read, once per module instance. */
async function loadOverride(): Promise<void> {
  if (overrideLoaded) return;
  overrideLoaded = true;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: CHAT_OVERRIDE_KEY } });
    if (row?.value) chatOverride = row.value;
  } catch { /* fresh db */ }
}

async function ensureBotIdentity(): Promise<void> {
  if (botId !== null || !TOKEN) return;
  await loadOverride(); // truthful boot log — persisted chat counts as resolved
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4500);
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    const json = (await res.json()) as { ok: boolean; result?: { id: number; username?: string } };
    if (json.ok && json.result) {
      botId = json.result.id;
      botUsername = json.result.username ?? null;
      if (!bootLogged) {
        bootLogged = true;
        const chat = chatOverride ?? ENV_CHAT;
        const selfRefused = chat === String(botId);
        console.log(`[NOTIFY] telegram relay ${selfRefused ? "ARMED (chat PENDING)" : chat ? "ARMED" : "DORMANT (no chat)"} — bot @${botUsername} (#${botId})${selfRefused ? ` · TELEGRAM_CHAT_ID equals the bot's own id — Telegram rejects bot→bot sends; waiting for discoverChat()/override` : chat ? ` · chat ${chat.slice(0, 3)}***${chat.slice(-2)}` : " · TELEGRAM_CHAT_ID unset"}`);
      }
    }
  } catch (e: unknown) {
    pushErr(`getMe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function resolveChat(): Promise<string | null> {
  await ensureBotIdentity();
  await loadOverride();
  const chat = chatOverride ?? ENV_CHAT;
  if (!chat || botId === null || chat === String(botId)) return null;
  return chat;
}

async function apiCall<T>(method: string, body: unknown, timeoutMs = 4500): Promise<{ ok: boolean; result?: T; error?: string }> {
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

/** Multipart photo upload (sendPhoto) — FormData/Blob are global in Node 18+. */
async function apiSendPhoto(chat: string, caption: string, photo: Buffer, filename: string): Promise<{ ok: boolean; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const isPng = filename.toLowerCase().endsWith(".png");
    const form = new FormData();
    form.append("chat_id", chat);
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "HTML");
    form.append("photo", new Blob([new Uint8Array(photo)], { type: isPng ? "image/png" : "image/jpeg" }), filename);
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, { method: "POST", body: form, signal: ctrl.signal, cache: "no-store" });
    const json = (await res.json()) as { ok: boolean; description?: string };
    return json.ok ? { ok: true } : { ok: false, error: json.description ?? `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? (e.name === "AbortError" ? "timeout 9000ms" : e.message) : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtPrice(p: number): string {
  return p >= 100 ? p.toFixed(2) : p.toFixed(p >= 1 ? 4 : 6);
}

// ── v6.3.2 OPERATOR ARTWORK — the full uploaded banner set ──
// Operator mandate: «استفاده از تصویر های ضمینه شده برای سیگنالهای win / stop /
// EXPIRED» + the lost-window batch (2026-09-05 21:09) adds NEW / TTL / FULL /
// Short. The PROVIDED artwork ships first; the dependency-free rendered
// banner (telegram-image.ts) is only the fallback when a file is missing.
type ArtKind = BannerStatus;
const ART_FILES: Record<ArtKind, string> = {
  WIN: "WIN.jpg", STOP: "STOP.jpg", EXPIRED: "EXPIRED.jpg",
  NEW: "NEW.jpg", SHORT: "SHORT.jpg", TTL_EXT: "TTL.jpg", FULL: "FULL.jpg",
  AFTERLIFE: "AFTERLIFE.jpg",
};
const artCache = new Map<ArtKind, Buffer | null>();

async function loadOperatorArt(kind: ArtKind): Promise<Buffer | null> {
  if (artCache.has(kind)) return artCache.get(kind) ?? null;
  try {
    const buf = await fs.readFile(path.join(process.cwd(), "assets", "telegram", ART_FILES[kind]));
    artCache.set(kind, buf);
    return buf;
  } catch {
    artCache.set(kind, null);
    return null;
  }
}

// ── v6.3 STRUCTURED CARD COMPOSER ─────────────────────────────────────────
// Event → (emoji headline, HTML body, optional banner image). Every field is
// read from the persisted Signal row; the engine message is appended verbatim.
interface RelayCard {
  text: string;
  photo?: Buffer;
  photoName?: string;
}

const HEADLINE: Record<string, { emoji: string; title: string }> = {
  CREATED: { emoji: "🚀", title: "NEW SIGNAL DEPLOYED" },
  TP1: { emoji: "💰", title: "TP1 HIT — 50% BOOKED" },
  TP2: { emoji: "💰💰", title: "TP2 HIT — 80% BOOKED" },
  TP3: { emoji: "🏆", title: "FULL LADDER — TP3 CAPTURED" },
  SL: { emoji: "🛑", title: "STOPPED OUT" },
  TTL_EXPIRED: { emoji: "⏰", title: "SIGNAL EXPIRED" },
  EARLY_EXIT: { emoji: "🚪", title: "EARLY TIME-EXIT" }, // v10.4: v8.4 R2/R7 adverse/stalled cut — was invisible to the operator
  TTL_EXTENDED: { emoji: "⏳", title: "TTL EXTENDED" },
  AFTERLIFE: { emoji: "🔮", title: "EXPIRED FOLLOW-UP" },
  // v9.0 PUMP/DUMP RADAR — flow tracking declarations + resolutions + unlock
  PUMP_RADAR: { emoji: "📡", title: "PUMP/DUMP RADAR" },
};

const BANNER_STATUS: Partial<Record<string, BannerStatus>> = {
  CREATED: "NEW", TP1: "WIN", TP2: "WIN", TP3: "FULL", SL: "STOP", TTL_EXPIRED: "EXPIRED", TTL_EXTENDED: "TTL_EXT",
  AFTERLIFE: "AFTERLIFE", EARLY_EXIT: "EXPIRED", // v10.4: early cut settles EXPIRED → amber artwork
};

type SignalLike = NonNullable<Awaited<ReturnType<typeof db.signal.findUnique>>>;

/** Tehran wall-clock stamp for artwork corners — presentation only. */
function tehranStamp(): string {
  return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "")} TEHRAN`;
}

/** The tidy line-by-line HTML body shared by live cards and sample proofs. */
function composeSignalText(type: string, sig: SignalLike, engineMessage: string): string {
  const head = HEADLINE[type] ?? { emoji: "📡", title: type };
  const dirEmoji = sig.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const serial = `NX-${String(sig.serial).padStart(4, "0")}`;
  const pnl = sig.pnlPercent ?? 0;
  const pnlLine = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% NET`;
  const reached = sig.reachedTp ?? 0;
  const lines: string[] = [
    `${head.emoji} <b>${esc(head.title)}</b>`,
    `${dirEmoji} · <b>${esc(sig.symbol)}</b> · <i>${esc(sig.strategy)}${sig.timeframe ? ` (${esc(sig.timeframe)})` : ""}</i>`,
    "",
    `🎯 TP1: <code>${fmtPrice(sig.tp1)}</code>   💰 TP2: <code>${fmtPrice(sig.tp2)}</code>   🏆 TP3: <code>${fmtPrice(sig.tp3)}</code>`,
    `🛑 Stop: <code>${fmtPrice(sig.stopLoss)}</code>   📍 Entry: <code>${fmtPrice(sig.entryPrice)}</code>`,
    "",
    `⚡ Leverage: <b>${sig.leverage}x</b>   💵 Margin: <b>$${sig.marginUsd.toFixed(0)}</b>   📐 R:R <b>1:${sig.riskReward.toFixed(1)}</b>`,
    `📊 Conviction: <b>${sig.confidence}%</b>   ⏳ TTL: <b>${sig.ttlMinutes}m</b>${sig.ttlExtensions ? ` (+${sig.ttlExtensions} ext)` : ""}`,
  ];
  if (type !== "CREATED") {
    lines.push(`💵 Result: <b>${pnl >= 0 ? "✅" : "❌"} ${esc(pnlLine)}</b>   🪜 Ladder: <b>${reached}/3</b>`);
  }
  lines.push("", `<blockquote>💬 ${esc(engineMessage)}</blockquote>`);
  lines.push(`<i>🤖 ${esc(serial)} · FLOWRADAR-NEO AI live engine</i>`);
  return lines.join("\n");
}

async function buildCard(type: string, symbol: string | null, engineMessage: string, signalId: string | null): Promise<RelayCard> {
  const head = HEADLINE[type] ?? { emoji: "📡", title: type };
  const sig = signalId ? await db.signal.findUnique({ where: { id: signalId } }).catch(() => null) : null;

  if (!sig) {
    // honest fallback — engine line only
    return { text: `${head.emoji} <b>${APP_NAME} — ${esc(head.title)}</b>\n${symbol ? `📊 <b>${esc(symbol)}</b>\n` : ""}\n<blockquote>${esc(engineMessage)}</blockquote>` };
  }

  const text = composeSignalText(type, sig, engineMessage);
  const banner = BANNER_STATUS[type];
  if (!banner) return { text };
  // CREATED cards are direction-aware: the red bear artwork ships for SHORT
  // deployments, the rocket/bull for LONG.
  const kind: BannerStatus = type === "CREATED" && sig.direction === "SHORT" ? "SHORT" : banner;

  const serial = `NX-${String(sig.serial).padStart(4, "0")}`;
  const pnl = sig.pnlPercent ?? 0;
  const pnlLine = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% NET`;
  const reached = sig.reachedTp ?? 0;
  const line2 = type === "SL" ? `RISK CONTAINED · LADDER ${reached}/3` : type === "TTL_EXPIRED" ? `TTL ${sig.ttlMinutes}M ELAPSED · LADDER ${reached}/3` : type === "EARLY_EXIT" ? `EARLY CUT (R2/R7) · LADDER ${reached}/3` : type === "TTL_EXTENDED" ? `+${sig.ttlExtensions} EXT · STILL LIVE` : type === "AFTERLIFE" ? `POST-EXPIRY ${((sig.afterlife ?? "TRACKING").replace(/_/g, " "))} · MFE ${((sig.maxPostPnlPercent ?? 0) >= 0 ? "+" : "")}${(sig.maxPostPnlPercent ?? 0).toFixed(1)}%` : type === "CREATED" ? `ENTRY ${fmtPrice(sig.entryPrice)} · RR 1:${sig.riskReward.toFixed(1)}` : `LADDER ${reached}/3 BANKED · RR 1:${sig.riskReward.toFixed(1)}`;
  const spec = {
    status: kind,
    title: `${sig.symbol} ${sig.direction}`,
    line1: `${serial} · ${pnlLine}`,
    line2,
    ts: tehranStamp(),
  };
  // v8.1: professional composite (AI art + coin logo + live data) first; the
  // operator JPG set and the pixel-font banner remain as fallbacks.
  try {
    const photo = await renderSignalBannerV2(spec);
    return { text, photo, photoName: `${kind.toLowerCase()}-${serial}.png` };
  } catch { /* sharp failure → legacy chain below */ }
  const art = await loadOperatorArt(kind);
  if (art) return { text, photo: art, photoName: ART_FILES[kind] };
  return { text, photo: renderStatusBanner(spec), photoName: `${kind.toLowerCase()}-${serial}.png` };
}

/** Fire-and-forget relay — NEVER await this from the engine hot path. */
export function relaySignalEvent(type: string, symbol: string | null, message: string, signalId?: string | null): void {
  if (!relayArmed() || !RELAYABLE_TYPES.has(type)) return;
  void (async () => {
    const chat = await resolveChat();
    if (!chat) return; // honest pending state — not an error, no doomed send
    // v9.1 RAW-CAL SPAM GUARD → v10.4 REBALANCE (operator mandate: «گزارشات
    // کامل و دقیق به تلگرام ارسال نمیشه، مثل کارت های سیگنال جدید، استاپ و
    // دیگر کارتها»): RAW-CAL CREATED cards no longer VANISH — they ship as
    // compact TEXT cards (structured HTML body, photo suppressed) so the
    // capture run stays fully visible without flooding the chat with ~5 heavy
    // photo posters/hour. Outcome cards (SL / EARLY_EXIT / TTL_EXPIRED / TP*)
    // keep their full photo treatment — that is where the detail matters.
    let rawCalTextOnly = false;
    if (type === "CREATED" && signalId) {
      const sig = await db.signal.findUnique({ where: { id: signalId }, select: { tags: true } }).catch(() => null);
      if (sig?.tags?.includes("RAW-CAL")) rawCalTextOnly = true;
    }
    let card: RelayCard;
    try {
      card = await buildCard(type, symbol, message, signalId ?? null);
    } catch {
      card = { text: `📡 ${APP_NAME} ${type}${symbol ? ` · ${esc(symbol)}` : ""}\n${esc(message)}`.slice(0, 3800) };
    }
    if (rawCalTextOnly) card = { text: card.text }; // v10.4: strip photo, keep the full HTML body
    let r: { ok: boolean; error?: string };
    if (card.photo) {
      r = await apiSendPhoto(chat, card.text, card.photo, card.photoName ?? "flowradar-signal.png");
      if (!r.ok) {
        // photo failed (size/network) — retry once as plain HTML text so the
        // alert still lands; banner is presentation, the message is the payload
        r = await apiCall<unknown>("sendMessage", { chat_id: chat, text: card.text.slice(0, 3800), parse_mode: "HTML", disable_web_page_preview: true });
      }
    } else {
      r = await apiCall<unknown>("sendMessage", { chat_id: chat, text: card.text.slice(0, 3800), parse_mode: "HTML", disable_web_page_preview: true });
    }
    if (r.ok) {
      sentCount++;
      lastSentAt = Date.now();
    } else {
      failCount++;
      pushErr(`${type}: ${r.error}`);
      console.error(`[NOTIFY] telegram relay send failed (${type}): ${r.error}`);
    }
  })();
}

/** v6.3: module-state primer — Next dev compiles each route bundle separately,
 * so /api/notify's copy of this module starts with cold state even when the
 * engine's copy already resolved the chat. Call before reading relayHealth(). */
export async function primeRelayState(): Promise<void> {
  await resolveChat();
}

/** Operator-initiated proof: send an arbitrary line to the resolved chat. */
export async function sendDirect(text: string): Promise<{ ok: boolean; error?: string; chatId?: string }> {
  const chat = await resolveChat();
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — relay dormant" };
  if (!chat) {
    if (botId !== null && (chatOverride ?? ENV_CHAT) === String(botId)) {
      return { ok: false, error: `TELEGRAM_CHAT_ID (${ENV_CHAT}) is the bot's own id — Telegram rejects bot→bot sends. Message the bot once from your account, then run discover.` };
    }
    return { ok: false, error: chatOverride || ENV_CHAT ? "chat unresolved (getMe pending or override pending)" : "TELEGRAM_CHAT_ID unset and no discovered chat yet" };
  }
  const r = await apiCall<unknown>("sendMessage", { chat_id: chat, text, disable_web_page_preview: true });
  if (r.ok) { sentCount++; lastSentAt = Date.now(); } else { failCount++; pushErr(`direct: ${r.error}`); }
  return { ok: r.ok, error: r.error, chatId: chat };
}

// ── v6.4 DAILY PERFORMANCE REPORT (operator request 2026-09-07) ──────────
// «هر روز ساعت 00:00 یک گزارش کوتاه و مفید از عملکرد روزانه به تلگرام
//  بفرست با این تصویر» — the DAILY.jpg artwork ships as the photo, the
// compiled 24h performance digest rides as the HTML caption. Numbers come
// from the REAL db rows (lib/dailyReport.ts); DAILY.jpg was uploaded by the
// operator and lives in assets/telegram/.
const DAILY_ART = path.join(process.cwd(), "assets", "telegram", "DAILY.jpg");
let dailyArtCache: Buffer | null | undefined;

export async function loadDailyArt(): Promise<Buffer | null> {
  if (dailyArtCache !== undefined) return dailyArtCache;
  try {
    dailyArtCache = await fs.readFile(DAILY_ART);
  } catch {
    dailyArtCache = null;
  }
  return dailyArtCache;
}

/** Send the daily performance report — photo (v8.1 rendered poster; the
 * operator's DAILY.jpg remains the fallback) + caption. */
export async function sendDailyReport(text: string, poster?: Buffer | null): Promise<{ ok: boolean; error?: string; withPhoto: boolean }> {
  const chat = await resolveChat();
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — relay dormant", withPhoto: false };
  if (!chat) return { ok: false, error: "chat unresolved — message the bot once, then retry", withPhoto: false };
  let art = poster ?? null;
  if (!art) art = await loadDailyArt();
  const r = art
    ? await apiSendPhoto(chat, text, art, "DAILY.jpg")
    : await apiCall<unknown>("sendMessage", { chat_id: chat, text: text.slice(0, 3800), parse_mode: "HTML", disable_web_page_preview: true });
  if (r.ok) { sentCount++; lastSentAt = Date.now(); } else { failCount++; pushErr(`daily: ${r.error}`); }
  return { ok: r.ok, error: r.error, withPhoto: Boolean(art) };
}

/** Design-preview channel — pushes any photo to the operator chat OUTSIDE the
 * daily-report dedup guard. Used by /api/report/daily/poster?send=1 so artwork
 * iterations can be reviewed live without consuming the once-per-day report. */
export async function sendPhotoDirect(caption: string, photo: Buffer, filename = "preview.jpg"): Promise<{ ok: boolean; error?: string }> {
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — relay dormant" };
  const chat = await resolveChat();
  if (!chat) return { ok: false, error: "chat unresolved — message the bot once, then retry" };
  const r = await apiSendPhoto(chat, caption, photo, filename);
  if (r.ok) { sentCount++; lastSentAt = Date.now(); } else { failCount++; pushErr(`photo-direct: ${r.error}`); }
  return r;
}

/** v6.3.2 operator proof: ALL SEVEN photo outcome cards with clearly-labelled
 * SAMPLE rows — never engine data, format verification only. */
export async function sendSampleCards(): Promise<{ ok: boolean; error?: string; detail?: string }> {
  const chat = await resolveChat();
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — relay dormant" };
  if (!chat) return { ok: false, error: "chat unresolved — message the bot once, then retry" };
  const mk = (over: Record<string, unknown>): SignalLike =>
    ({
      id: "sample", createdAt: new Date(), updatedAt: new Date(), closedAt: new Date(),
      symbol: "BTCUSDT", direction: "LONG", entryPrice: 65000, entryZoneLow: 64948, entryZoneHigh: 65052,
      tp1: 66000, tp2: 67500, tp3: 69000, stopLoss: 64000, leverage: 10, marginUsd: 12, confidence: 78, riskReward: 2.8,
      timeframe: "1h", strategy: "AI-SWING", status: "TP2", analysis: "", tags: "high-conviction,FLOW-CONFIRM,REGIME-TREND-UP",
      engine: "SAMPLE", serial: 0, factorsJson: null, flowJson: null, ttlMinutes: 120, expiresAt: new Date(Date.now() + 3600_000),
      pnlPercent: 27.3, maxPnlPercent: 31.4, feeUsd: 0.11, swapUsd: 0.01, reachedTp: 2, ttlExtensions: 0,
      afterlife: null, afterlifeAt: null, maxPostPnlPercent: 0, operatorNotes: "", notesUpdatedAt: null,
      ...over,
    } as unknown as SignalLike);
  const samples: Array<[string, SignalLike, string]> = [
    ["CREATED", mk({ serial: 1 }), "SAMPLE — new LONG deployment detected by the live engine (card-format proof, not a live signal)"],
    ["CREATED", mk({ serial: 2, direction: "SHORT", symbol: "ETHUSDT", strategy: "BREAKOUT", timeframe: "15m", entryPrice: 3120, entryZoneLow: 3118, entryZoneHigh: 3122, tp1: 3060, tp2: 2990, tp3: 2900, stopLoss: 3180, leverage: 8, marginUsd: 9.5, confidence: 71, riskReward: 2.6, tags: "confluence,FLOW-NEUTRAL,REGIME-CHOP" }), "SAMPLE — new SHORT deployment detected by the live engine (card-format proof, not a live signal)"],
    ["TP2", mk({ serial: 3, pnlPercent: 27.3, maxPnlPercent: 31.4, feeUsd: 0.11, swapUsd: 0.01, reachedTp: 2 }), "SAMPLE — TP2 reached — 80% booked, stop trailed to TP1 (card-format proof, not a live signal)"],
    ["TP3", mk({ serial: 4, symbol: "SOLUSDT", strategy: "AI-SWING", entryPrice: 184.2, entryZoneLow: 183.9, entryZoneHigh: 184.5, tp1: 191.2, tp2: 201.0, tp3: 214.0, stopLoss: 177.2, leverage: 6, marginUsd: 8.25, confidence: 68, riskReward: 3.1, pnlPercent: 48.9, maxPnlPercent: 52.1, reachedTp: 3, status: "TP3", closedAt: new Date() }), "SAMPLE — FULL TARGET achieved — ladder 3/3 banked (card-format proof, not a live signal)"],
    ["SL", mk({ serial: 5, direction: "SHORT", symbol: "ETHUSDT", strategy: "BREAKOUT", timeframe: "15m", entryPrice: 3120, entryZoneLow: 3118, entryZoneHigh: 3122, tp1: 3060, tp2: 2990, tp3: 2900, stopLoss: 3180, leverage: 8, marginUsd: 9.5, confidence: 71, riskReward: 2.6, pnlPercent: -29.8, reachedTp: 0, status: "SL", closedAt: new Date(), tags: "confluence,FLOW-NEUTRAL,REGIME-CHOP" }), "SAMPLE — stopped @ 3180 — risk contained (card-format proof, not a live signal)"],
    ["TTL_EXTENDED", mk({ serial: 6, symbol: "SOLUSDT", strategy: "AI-SWING", entryPrice: 184.2, entryZoneLow: 183.9, entryZoneHigh: 184.5, tp1: 191.2, tp2: 201.0, tp3: 214.0, stopLoss: 177.2, leverage: 6, marginUsd: 8.25, confidence: 68, riskReward: 3.1, ttlMinutes: 90, ttlExtensions: 1, tags: "confluence,FLOW-CONFIRM,REGIME-TREND-UP" }), "SAMPLE — TTL 90m extended +1 — expiry gate bought more room (card-format proof, not a live signal)"],
    ["TTL_EXPIRED", mk({ serial: 7, symbol: "SOLUSDT", strategy: "AI-SWING", entryPrice: 184.2, entryZoneLow: 183.9, entryZoneHigh: 184.5, tp1: 191.2, tp2: 201.0, tp3: 214.0, stopLoss: 177.2, leverage: 6, marginUsd: 8.25, confidence: 68, riskReward: 3.1, pnlPercent: 11.2, reachedTp: 1, ttlMinutes: 90, ttlExtensions: 1, status: "EXPIRED", closedAt: new Date(), tags: "confluence,FLOW-CONFIRM,REGIME-TREND-UP" }), "SAMPLE — TTL 90m +1 ext elapsed — auto-closed at mark (card-format proof, not a live signal)"],
  ];
  const results: string[] = [];
  for (const [type, sig, msg] of samples) {
    try {
      const text = `🧪 <b>SAMPLE — CARD FORMAT PROOF</b>\n\n${composeSignalText(type, sig, msg)}`;
      const banner = BANNER_STATUS[type];
      let r: { ok: boolean; error?: string };
      const serial = `NX-${String(sig.serial).padStart(4, "0")}`;
      const pnl = sig.pnlPercent ?? 0;
      const photo = banner
        ? await renderSignalBannerV2({
            status: banner,
            title: `${sig.symbol} ${sig.direction}`,
            line1: `${serial} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% NET`,
            line2: banner === "NEW" || banner === "SHORT" ? `ENTRY ${fmtPrice(sig.entryPrice)} · RR 1:${sig.riskReward.toFixed(1)}` : `LADDER ${sig.reachedTp}/3 · RR 1:${sig.riskReward.toFixed(1)}`,
            ts: tehranStamp(),
          }).catch(() => null)
        : null;
      if (photo) r = await apiSendPhoto(chat, text, photo, `sample-${type.toLowerCase()}.png`);
      else {
        const art = banner ? await loadOperatorArt(banner) : null;
        if (art) r = await apiSendPhoto(chat, text, art, ART_FILES[banner!]);
        else r = await apiCall<unknown>("sendMessage", { chat_id: chat, text: text.slice(0, 3800), parse_mode: "HTML", disable_web_page_preview: true });
      }
      if (!r.ok) r = await apiCall<unknown>("sendMessage", { chat_id: chat, text: text.slice(0, 3800), parse_mode: "HTML", disable_web_page_preview: true });
      results.push(`${type}: ${r.ok ? "OK" : r.error}`);
    } catch (e) {
      results.push(`${type}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const okAll = results.every((r) => r.endsWith("OK"));
  if (okAll) { sentCount += samples.length; lastSentAt = Date.now(); } else failCount += results.filter((r) => !r.endsWith("OK")).length;
  return { ok: okAll, detail: results.join(" · ") };
}

// ── v6.2.2 AUTO-DISCOVER (operator round) ─────────────────────────────────
// The operator's credential set shipped TELEGRAM_CHAT_ID === the bot's own id
// (Telegram hard-rejects bot→bot sends), leaving the relay stuck in ARMED
// (chat PENDING) until someone runs discoverChat() at exactly the right
// moment. Instead of babysitting, this loop polls getUpdates every 30s WHILE
// the chat is unresolved; the instant the operator messages the bot once,
// the chat id is learned, persisted, confirmed back, and the loop retires.
let autoDiscoverTimer: ReturnType<typeof setInterval> | null = null;

function chatResolvedNow(): boolean {
  const chat = chatOverride ?? ENV_CHAT;
  return chat.length > 0 && botId !== null && chat !== String(botId);
}

export function ensureAutoDiscover(): void {
  if (autoDiscoverTimer || !relayArmed()) return;
  // v8.3 BRIDGE COEXISTENCE: the chat id is already persisted (EngineSetting
  // telegram.chatId) since v6.2.2 — discovery is DONE. The legacy 30s
  // getUpdates probe now 409-terminates the v8.3 bridge long-poller, so the
  // loop may only start after a DB-backed override check FAILS, and each
  // tick re-checks the override BEFORE touching getUpdates.
  void (async () => {
    try {
      await ensureBotIdentity();
      await loadOverride();
    } catch {
      /* identity check is best-effort */
    }
    if (chatResolvedNow()) {
      // v10.16: rate-limit this line to once per 10min — it fired on every call
      // and produced ~3.5k dev.log lines/day (audit: unbounded log growth).
      const now = Date.now();
      if (now - lastAutoDiscoverSkipLog > 600_000) {
        lastAutoDiscoverSkipLog = now;
        console.log("[NOTIFY] auto-discover SKIPPED — chat already resolved (v8.3 bridge owns getUpdates)");
      }
      return;
    }
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (chatResolvedNow()) {
        clearInterval(timer);
        autoDiscoverTimer = null;
        return;
      }
      void (async () => {
        try {
          await ensureBotIdentity();
          await loadOverride();
        } catch {
          /* best-effort */
        }
        if (chatResolvedNow()) {
          clearInterval(timer);
          autoDiscoverTimer = null;
          return;
        }
        const r = await discoverChat();
        if (r.ok) {
          clearInterval(timer);
          autoDiscoverTimer = null;
          const proof = await sendDirect(
            `🟢 ${APP_NAME} relay ARMED — operator chat discovered and persisted.\nFrom now on CREATED / TP1-3 / SL / TTL_EXPIRED / TTL_EXTENDED / AFTERLIFE events mirror here as structured cards (WIN / STOP / EXPIRED outcomes also arrive as rendered banner images).`
          );
          console.log(`[NOTIFY] auto-discover complete — confirmation ${proof.ok ? "delivered" : `NOT delivered (${proof.error ?? "unknown"})`}`);
        }
        // ok:false → "no messages waiting" (benign, keep polling) or a
        // transient network error (silent retry on the next 30s pass).
      })();
    }, 30_000);
    autoDiscoverTimer = timer;
    console.log("[NOTIFY] auto-discover loop started — polling getUpdates every 30s until the operator messages the bot");
  })();
}

/** Learn the operator chat from the bot's update stream — the operator sends
 * ANY message to the bot in Telegram, we read getUpdates and persist the chat. */
export async function discoverChat(): Promise<{ ok: boolean; error?: string; chatId?: string; from?: string; text?: string }> {
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN unset — relay dormant" };
  await ensureBotIdentity();
  const r = await apiCall<Array<{ message?: { chat: { id: number; first_name?: string; username?: string }; text?: string } }>>("getUpdates", { limit: 10, timeout: 0 }, 8000);
  if (!r.ok || !r.result) return { ok: false, error: r.error ?? "getUpdates returned no payload" };
  const withMsg = r.result.filter((u) => u.message?.chat?.id !== undefined);
  if (withMsg.length === 0) return { ok: false, error: "no messages waiting — open the bot in Telegram, press START and send any message (e.g. «سلام»), then retry discover" };
  const last = withMsg[withMsg.length - 1].message!;
  const chatId = String(last.chat.id);
  chatOverride = chatId;
  overrideLoaded = true;
  await db.engineSetting.upsert({ where: { key: CHAT_OVERRIDE_KEY }, create: { key: CHAT_OVERRIDE_KEY, value: chatId }, update: { value: chatId } });
  console.log(`[NOTIFY] telegram chat DISCOVERED — id ${chatId} (${last.chat.first_name ?? last.chat.username ?? "unknown"}), persisted to ${CHAT_OVERRIDE_KEY}; relay fully ARMED`);
  return { ok: true, chatId, from: last.chat.first_name ?? last.chat.username, text: last.text };
}
