// NEXUS//SIGNALS — one-off operator-ordered relay: signal cards + book status → @mytradeneo
// Read-only over SQLite (readonly:true). Sends via the project bot token from .env.
import { Database } from "bun:sqlite";

const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";

const TZ = "Asia/Tehran";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const px = (v) => (v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toFixed(6));

const STATUS_BADGE = {
  TP3: "🟢 FULL WIN · TP3",
  TP2: "🟢 WIN · TP2",
  TP1: "🟢 WIN · TP1",
  SL: "🔴 STOP",
  EXPIRED: "⚪ EXPIRED",
  CLOSED: "🔵 CLOSED",
  ACTIVE: "🟡 LIVE",
  VOID: "⚫ VOID",
};

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");

const rows = db.query(`SELECT serial, symbol, direction, strategy, status, entryPrice, stopLoss, tp1, tp2, tp3, leverage, marginUsd, pnlPercent, reachedTp, confidence, createdAt, closedAt, tags FROM Signal WHERE serial >= 3244 ORDER BY serial ASC`).all();

const all = db.query("SELECT status, COUNT(*) n FROM Signal GROUP BY status ORDER BY n DESC").all();
const winsAny = db.query("SELECT COUNT(*) n FROM Signal WHERE reachedTp >= 1").get().n;
const settledN = db.query("SELECT COUNT(*) n FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED')").get().n;
const avgPnl = db.query("SELECT AVG(pnlPercent) p FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED')").get().p;
db.close();

function signalCard(s) {
  const dir = s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const badge = STATUS_BADGE[s.status] ?? s.status;
  const pnl = s.pnlPercent != null ? `${s.pnlPercent >= 0 ? "+" : ""}${s.pnlPercent.toFixed(2)}%` : "—";
  const pnlTag = `<b>${esc(pnl)}</b>`;
  const tags = (s.tags ?? "").split(",").filter((t) => ["RAW-CAL", "EVENT-TRIGGER", "high-conviction"].includes(t)).join(" · ");
  const touched = s.reachedTp > 0 ? `TP${s.reachedTp}` : "—";
  return [
    `<b>📶 NX-${String(s.serial).padStart(4, "0")} · ${esc(s.symbol)} · ${dir}</b>`,
    `${badge}  |  PnL ${pnlTag} (margin $${s.marginUsd} × ${s.leverage}x)`,
    ``,
    `🎯 Entry: <code>${px(s.entryPrice)}</code>`,
    `🛑 Stop:  <code>${px(s.stopLoss)}</code>`,
    `🏆 TP1: <code>${px(s.tp1)}</code> · TP2: <code>${px(s.tp2)}</code> · TP3: <code>${px(s.tp3)}</code>`,
    ``,
    `📈 Touch level: <b>${touched}</b> · Confidence: ${s.confidence}% · ${esc(s.strategy)}`,
    `🕐 Opened ${fmtT(s.createdAt)}${s.closedAt ? ` · Closed ${fmtT(s.closedAt)}` : ""} (Tehran)`,
    tags ? `🏷 ${esc(tags)}` : "",
  ].filter(Boolean).join("\n");
}

const dist = all.map((r) => `${r.status} ${r.n}`).join(" · ");
const statusCard = [
  `<b>🛰 NEXUS//SIGNALS — وضعیت موتور و سیگنال‌ها</b>`,
  `<i>${fmtT(Date.now())} تهران</i>`,
  ``,
  `<b>📊 کتاب سیگنال (${all.reduce((a, r) => a + r.n, 0)} رکورد):</b>`,
  `<code>${esc(dist)}</code>`,
  ``,
  `🎯 نرخ برخورد به سود (TP≥1): <b>${winsAny}/${settledN}</b> (${((winsAny / settledN) * 100).toFixed(1)}%)`,
  `💵 میانگین PnL رکوردهای تسویه‌شده: <b>${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%</b> روی مارجین`,
  `📂 پوزیشن باز: <b>0</b> (FLAT)`,
  ``,
  `<b>⏸ چرا صدور جدید متوقف است؟</b>`,
  `• آخرین صدور: NX-3247 ZECUSDT — 2026/11/03 15:21 تهران`,
  `• موتور زنده است و هر ~۵۰ ثانیه اسکن می‌کند`,
  `• کاندیدها توسط فیلتر <b>DECISIVE</b> رد می‌شوند: بازار در رخوت عمیق — ER 0.04–0.30 (کف 0.12) و سفر پیش‌بینی‌شده ۳ تا ۱۵ برابر کمتر از حداقل لازم (1R)`,
  `• تعلیق دوره‌ای صادرکننده هنگام پنجره‌ی بن fapi (محافظ هوشمند — مأموریت NX-3247)`,
  `• وتوها معتبرند: REGIME + MEMORY + DECISIVE — پیش‌بینی «بدون برخورد» جلوی رکوردهای کوری‌زای EXPIRED را می‌گیرد`,
].join("\n");

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 3800), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
  });
  const j = await r.json();
  return j.ok ? "OK" : `FAIL: ${j.description}`;
}

await new Promise((r) => setTimeout(r, 300));
console.log("status card →", await send(statusCard));
for (const s of rows) {
  await new Promise((r) => setTimeout(r, 1400));
  console.log(`NX-${s.serial} card →`, await send(signalCard(s)));
}
console.log("DONE");
