// SENTINEL-20261124-DATA-HISTORY — report card → @mytradeneo (trace 1a20afd151b58a5d)
// «چرا تاریخچه دیتای جمع اوری شده از اول این ماه تا الان 24/11 ناقص شده و از بین رفته»
const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tehran", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const text =
`📊 <b>NEXUS//SIGNALS — کالبدشکافی «تاریخچه دیتای ناقص» ۱–۲۴ نوامبر</b>
<i>${fmtT(Date.now())} Tehran · مأموریت SENTINEL-20261124-DATA-HISTORY</i>

<b>چرا ناقص شد — ۴ علت اندازه‌گیری‌شده:</b>
① <b>دو قطعی کامل سرویس</b> (sandbox معلق):
   • ۱۲→۱۸ نوامبر — اثر انگشت mtime: <b>صفر فایل</b> در ۷ روز نوشته شد → سیستم اصلاً بالا نبود؛ داده‌ای «از بین نرفته»، اصلاً جمع نشده
   • ۲۱ نوامبر 12:29Z → ۲۳ نوامبر 21:59Z — قطعی دوم
② <b>ریست ورک‌اسپیس</b> ۲۳ نوامبر 23:15Z — پلتفرم کل درخت را از اسنپ‌شات بازگرداند (DB سالم با 3671 سیگنال برگشت)
③ <b>retention ساختاری (طراحی، نه خرابی):</b> PricePoint=۴۸ ساعت · SignalEvent=۳۰ روز (+آرشیو JSONL) · FuturesSnapshot=۳۰ روز — تاریخچه عمیق قیمت‌ها طبق طراحی rolling پاک می‌شود
④ <b>بن فعلی fapi</b> روی ۳ IP → جمع‌آوری زنده‌ی امروز تنک است (۱۸–۲۲ ردیف/روز به‌جای ۱۶۰+)

<b>ریکاوری مهندسی — انجام شد:</b>
✅ StableFlow (جریان استیبل‌کوین): <b>۵۴ ردیف BACKFILL روزانه</b> از DefiLlama فقط برای روزهای واقعاً خالی (۱۲–۱۸، ۲۰، ۲۲ نوامبر) — تقویم ماه: <b>صفر روز خالی</b>
✅ FuturesSnapshot: مکانیزم backfill خودِ سیستم (گرید 1h ~۱۴روز) مسلح شد — ban-aware، هر ۱۰دقیقه retry؛ با اولین پنجره‌ی آزاد fapi خودش می‌نشیند (الان ۳ IP بن ۴۱۸ هستند — hammering ممنوع طبق قرارداد gate)
❌ Signal / SignalEvent / VolCauseEvent: رویدادهای داخلی موتورند — بازسازی از هیچ منبعی ممکن نیست؛ جعلشان نقض صداقت است (SignalEvent قدیمی‌ها در <code>.data/signal-events-archive.jsonl</code> آرشیوند)
🛡 freeze هسته دست‌نخورده: <code>engine.ts md5 eaf8be07…</code>

<b>پیشگیری — حلقه‌ی بکاپ جدید:</b>
🛡 <code>VACUUM INTO</code> هر ۳.۵ ساعت (بدون توقف DB زنده) + آرشیو journalهای حیاتی → دو slot: <code>.data/db-backups</code> + <code>/tmp/nexus-db-backups</code> — اولین اسنپ‌شات گرفته شد (signals=3671 ✔) · هوک watchdog هم مسلح شد
→ از این پس هر ریست، برگردان از <b>تازه‌ترین</b> بکاپ خودمان ممکن است، نه اسنپ‌شات کهنه‌ی پلتفرم

<b>شفافیت:</b> حین ریکاوری دو gate حالت stale داشتند — regimeGuard=1 (برخلاف پین عملیات ۱۱-۰۹) → به ۰+پین برگرداندم؛ AI-SCALP/MEAN-REVERT را اشتباهی باز کردم که <b>خودم فوری برگرداندم</b> — مأموریت عملکرد ۲۰۲۶-۱۱-۱۰ (توقف دو استراتژی ضعیف) اولویت دارد و برقرار است.

<i>حکم سنتینل: «از بین رفتن» = قطعی‌های sandbox + retention طراحی‌شده؛ شکاف‌های قابل بازسازی بازسازی شد، بقیه صداقت‌آگاه ثبت‌اند. 🟢</i>`;

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const j = await res.json();
console.log("send:", j.ok, j.description ?? "");
