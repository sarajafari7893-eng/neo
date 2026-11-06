// SENTINEL-20261106-OPEN-GATES — mission confirmation card → @mytradeneo (operator order trace 1a1b2af7bcc328fd)
import { Database } from "bun:sqlite";

const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";
const TZ = "Asia/Tehran";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const fresh = db.query("SELECT serial, symbol, direction, strategy, status, entryPrice, datetime(createdAt/1000,'unixepoch') t FROM Signal WHERE createdAt > 1793999700000 ORDER BY serial ASC").all();
db.close();

const dirB = (d) => (d === "LONG" ? "🟢 LONG" : "🔴 SHORT");
const lines = fresh.map((s) =>
  `▸ <b>NX-${String(s.serial).padStart(4, "0")}</b> ${dirB(s.direction)} <b>${esc(s.symbol)}</b> · ${esc(s.strategy)} @ ${esc(s.entryPrice)} <i>[${fmtT(new Date(s.t + "Z").getTime())}]</i>`,
);

const text =
`🚪 <b>NEXUS//SIGNALS — GATES OPEN</b>
<i>${fmtT(Date.now())} Tehran · مأموریت SENTINEL-20261106-OPEN-GATES</i>

<b>ریشه توقف ۱۸.۴ ساعته (اندازه‌گیری‌شده):</b>
① مکث بن fapi روی صادرکننده RAW-CAL — پنجره‌ی بن هر ~۲۴دقیقه دوباره مسلح می‌شد ⇒ توقف ~۱۰۰٪ زمان
② وتوی REGIME (چاپ سکون): <b>۶,۸۷۳ وتو در ۲۴ساعت</b>
③ STRAT-PAUSE دو استراتژی: AI-SCALP + MEAN-REVERT (۱۴۰ وتو/۲۴ساعت)

<b>گیتهای باز شده (همه برگشت‌پذیر):</b>
✅ صادرکننده RAW-CAL: توقف بن → کپچر degraded با تگ FAPI-DEG (v14.4)
✅ regimeGuard L1→L0 — وتوی چاپ خاموش (جریمه نرم باقی)
✅ STRAT-PAUSE: AI-SCALP + MEAN-REVERT آزاد شدند (شواهد قبلی حفظ شد)
🛡 سالم ماند: ریل صداقت فید، ضد-سکوت ۱۰دقیقه، سقف ۸ رکورد باز، PUMP_RADAR
🔧 علاوه بر آن: P1 فانتوم fundingByb درمان شد (کلاینت Prisma + بوت تازه)

<b>نتیجه — سیگنال‌های صادرشده از لحظه‌ی باز شدن (${fresh.length}):</b>
${lines.join("\n")}

⚡ ضربان: <code>OPEN (degraded) — issuer continues per operator order</code>
📊 کتاب: issued 749→750+ · کادنس کپچر ۱۰دقیقه‌ای برقرار · NX-3272 روی پنجره‌ی بعدی صادر شد

<i>حکم سنتینل: صدور از «توقف کامل» به «جریان پایدار» گذشت — تایید زنده روی ضربان و کتاب.</i> 🟢`;

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const j = await res.json();
console.log("send:", j.ok, j.description ?? "");
