// SENTINEL-20261108-MIRROR-RESTORE (trace 1a1ba7c90514af9d) — consolidated timeline backfill → @mytradeneo
// 36h of gate-open issuance (NX-3268..3386) fired while signalChannel.configured=false
// (.env reverted to its 11-02 version → mirror env line lost at the 11-06 21:18Z heal boot).
// Env restored + hot-reloaded (configured=true verified). This sends the compact full timeline.
import { Database } from "bun:sqlite";

const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";
const TZ = "Asia/Tehran";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const rows = db.query("SELECT serial, symbol, direction, strategy, status, entryPrice, pnlPercent, marginUsd, leverage, reachedTp, createdAt, tags FROM Signal WHERE serial >= 3268 ORDER BY serial ASC").all();
db.close();

const S = { TP3: "TP3🟢", TP2: "TP2🟢", TP1: "TP1🟢", SL: "SL🔴", EXPIRED: "EXP⚪", ACTIVE: "LIVE🟡", CLOSED: "CLS🔵", VOID: "VOID⚫" };
const STRAT = { "AI-SCALP": "SC", "AI-SWING": "SW", "MEAN-REVERT": "MR", BREAKOUT: "BO", MOMENTUM: "MO" };
const row = (s) => {
  const t = fmtT(s.createdAt).slice(0, 5);
  const pnl = s.pnlPercent != null ? `${s.pnlPercent >= 0 ? "+" : ""}${s.pnlPercent.toFixed(0)}%` : "";
  const deg = (s.tags || "").includes("FAPI-DEG") ? " ⚠️DEG" : "";
  return `NX-${s.serial} ${esc(s.symbol.replace("USDT", ""))} ${s.direction === "LONG" ? "L" : "S"}·${STRAT[s.strategy] ?? "?"} ${S[s.status] ?? s.status} ${t}${pnl ? " " + pnl : ""}${deg}`;
};

const st = {};
for (const r of rows) st[r.status] = (st[r.status] ?? 0) + 1;
const wins = rows.filter((r) => r.reachedTp >= 1).length;
const settled = rows.filter((r) => r.reachedTp >= 1 || ["SL", "EXPIRED"].includes(r.status)).length;
const degN = rows.filter((r) => (r.tags || "").includes("FAPI-DEG")).length;

const header = `📡 <b>NEXUS//SIGNALS — BACKFILL تایم‌لاین ۳۶ ساعت (${rows.length} سیگنال)</b>
<i>${fmtT(Date.now())} تهران · NX-3268→NX-${rows[rows.length - 1].serial} · ${fmtT(rows[0].createdAt).slice(0, 5)}→${fmtT(rows[rows.length - 1].createdAt).slice(0, 5)}</i>

ریشه‌ی قطع کارت‌ها: بازگردانی <code>.env</code> به نسخه‌ی ۱۱-۰۲ خط <code>TELEGRAM_SIGNAL_CHANNEL</code> را پاک کرد؛ بوت ۲۱:۱۸ شب ۱۱-۰۶ بدون آینه بالا آمد و کل موج صدورِ «گیتهای باز» بدون کارت ماند.
✅ خط برگشت + هات‌ریلود شد — <b>از سیگنال بعدی کارت‌ها خودکار و زنده می‌آیند</b>.

<b>📚 نتایج دوره:</b> ${Object.entries(st).map(([k, v]) => `${S[k] ?? k}×${v}`).join(" · ")}
🎯 TP≥1: <b>${wins}</b> از ${settled} تسویه‌شده · ⚠️ ردیف degraded (بن fapi): <b>${degN}</b>

<i>اگر کارت‌های تکیِ سریال‌های اولیه را دریافت کرده‌اید، این جدول همان‌ها را کامل می‌کند.</i>`;

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text: text.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  return j.ok ? "OK" : `FAIL: ${j.description}`;
}

// split rows into chunks of 42 compact rows (~2.2KB each) — 3 messages
const CHUNK = 42;
console.log("header →", await send(header));
for (let i = 0; i < rows.length; i += CHUNK) {
  const part = rows.slice(i, i + CHUNK);
  const body = `<b>(${Math.floor(i / CHUNK) + 1}/${Math.ceil(rows.length / CHUNK)}) NX-${part[0].serial}→${part[part.length - 1].serial}</b>\n<code>${part.map(row).join("\n")}</code>`;
  await new Promise((r) => setTimeout(r, 1300));
  console.log(`part ${Math.floor(i / CHUNK) + 1} →`, await send(body));
}
console.log("DONE");
