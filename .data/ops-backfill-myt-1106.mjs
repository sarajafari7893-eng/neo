// SENTINEL-20261106-MIRROR-RESTORE — backfill the missed CREATED cards (NX-3268..) → @mytradeneo
// Why: the v12.8 mirror env line was lost in an .env revert (mtime 2026-11-02) — the
// watchdog heal boot at 21:18:36Z came up without TELEGRAM_SIGNAL_CHANNEL, so the
// gate-opening issuance wave (NX-3268..3272) fired while signalChannel.configured=false.
// The line is restored + hot-reloaded (configured=true verified via /api/notify); this
// script backfills the missed timeline. Live cards from the NEXT issue onward ride the
// real relay path again. Text-only cards (no photo) — labeled BACKFILL for audit honesty.
import { Database } from "bun:sqlite";

const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";
const TZ = "Asia/Tehran";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const px = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const rows = db.query("SELECT serial, symbol, direction, strategy, status, entryPrice, stopLoss, tp1, tp2, tp3, leverage, marginUsd, pnlPercent, reachedTp, confidence, createdAt, closedAt, tags FROM Signal WHERE serial >= 3268 ORDER BY serial ASC").all();
db.close();

const STATUS_BADGE = { ACTIVE: "🟡 LIVE", TP1: "🟢 WIN · TP1", TP2: "🟢 WIN · TP2", TP3: "🟢 FULL WIN · TP3", SL: "🔴 STOP", EXPIRED: "⚪ EXPIRED", CLOSED: "🔵 CLOSED", VOID: "⚫ VOID" };

function signalCard(s) {
  const dir = s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const badge = STATUS_BADGE[s.status] ?? s.status;
  const pnl = s.pnlPercent != null ? `${s.pnlPercent >= 0 ? "+" : ""}${s.pnlPercent.toFixed(2)}%` : "—";
  const tags = (s.tags ?? "").split(",").filter((t) => ["RAW-CAL", "EVENT-TRIGGER", "high-conviction", "FAPI-DEG"].includes(t)).join(" · ");
  const touched = s.reachedTp > 0 ? `TP${s.reachedTp}` : "—";
  return [
    `<b>📶 NX-${String(s.serial).padStart(4, "0")} · ${esc(s.symbol)} · ${dir}</b>`,
    `${badge}  |  PnL <b>${esc(pnl)}</b> (margin $${s.marginUsd} × ${s.leverage}x)`,
    ``,
    `🎯 Entry: <code>${px(s.entryPrice)}</code>`,
    `🛑 Stop:  <code>${px(s.stopLoss)}</code>`,
    `🏆 TP1: <code>${px(s.tp1)}</code> · TP2: <code>${px(s.tp2)}</code> · TP3: <code>${px(s.tp3)}</code>`,
    ``,
    `📈 Touch level: <b>${touched}</b> · Confidence: ${s.confidence}% · ${esc(s.strategy)}`,
    `🕐 Opened ${fmtT(s.createdAt)} (Tehran)`,
    tags ? `🏷 ${esc(tags)}` : "",
  ].filter(Boolean).join("\n");
}

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 3800), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  });
  const j = await r.json();
  return j.ok ? "OK" : `FAIL: ${j.description}`;
}

const header = `🔁 <b>NEXUS//SIGNALS — BACKFILL کارت‌های عقب‌افتاده</b>
<i>${fmtT(Date.now())} تهران · مأموریت SENTINEL-20261106-MIRROR-RESTORE</i>

خط <code>TELEGRAM_SIGNAL_CHANNEL</code> در یک بازگردانیِ <code>.env</code> (نسخه‌ی 11-02) پاک شده بود؛ بوت تازه‌ی ساعت ۲۱:۱۸ بدون آینه‌ی کانال بالا آمد و موج صدور جدید (باز شدن گیتها) بدون کارت ماند.
✅ خط برگشت + هات‌ریلود شد (<code>configured=true</code> تایید شد) — از سیگنال بعدی، کارت‌ها خودکار می‌آیند.
📥 ${rows.length} کارت زیر backfill همین لحظه است:`;

console.log("header →", await send(header));
for (const s of rows) {
  await new Promise((r) => setTimeout(r, 1400));
  console.log(`NX-${s.serial} card →`, await send(signalCard(s)));
}
console.log("DONE");
