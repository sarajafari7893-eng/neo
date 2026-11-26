// SENTINEL-20261124-RESET-RECOVERY — engineered recovery report card → @mytradeneo (operator order trace 1a20ae6dbe7b54c9)
const TOKEN = (await Bun.file("/home/z/my-project/.env").text()).match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
if (!TOKEN) { console.log("NO TOKEN"); process.exit(1); }
const CHAT = "@mytradeneo";
const TZ = "Asia/Tehran";
const fmtT = (ms) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const text =
`🛠 <b>NEXUS//SIGNALS — ریست: کالبدشکافی + ریکاوری مهندسی</b>
<i>${fmtT(Date.now())} Tehran · مأموریت SENTINEL-20261124-RESET-RECOVERY</i>

<b>چرا سیستم ریست شد (اندازه‌گیری‌شده):</b>
① باکس ~۲.۵ روز معلق بود — آخرین ضربان ۲۱ نوامبر 12:28Z ← ری‌بوت کامل ۲۳ نوامبر 23:15Z (suspend غیرتمیز وسط نوشتن)
② بعد از ری‌بوت: dev-up با fail-streak=3→4 وipe کامل .next + ۶ بار راه‌اندازی مجدد در ۱۵ دقیقه
③ <b>ریشه اصلی:</b> خرابی ایندکس SQLite (کد 779 «database disk image is malformed») روی <code>PricePoint</code>/<code>FlowScan</code> — WAL نیم‌سوخته بعد از suspend → ۲۰۲ خطای نوشتن؛ فانتوم fundingByb = صفر مورد (این بار مقصر نبود)
④ فشار حافظه: mem-crit (۱۸۰–۲۴۰MB آزاد) ×۳ → مکث وچ‌داگ + چرخش اپ — ریست دوم در 00:13Z

<b>ریکاوری مهندسی — انجام شد:</b>
✅ بکاپ قانونی ۶۲.۹MB ← <code>.data/db-corrupt-backup-1124</code>
✅ kill کنترل‌شده ← <code>REINDEX</code> (فقط ۱۸۶ms) + checkpoint TRUNCATE
✅ <code>integrity_check: OK — database is clean</code> — ۱۴/۱۴ جدول سالم
✅ self-heal فقط ۴ ثانیه — بوت تمیز 00:19:17Z · بعد از ترمیم: صفر خطای malformed
✅ داده‌ها دست‌نخورده: Signal=3668 · EngineSetting=67 · PricePoint=13446 · FlowScan=1020
✅ env-guard خودش <code>.env</code> را ترمیم کرد — رله‌ی کانال مسلح شد (mirror → @mytradeneo، چرخه کامل عمر)
🛡 freeze هسته دست‌نخورده: <code>engine.ts md5 eaf8be07…</code> — حتی یک خط کد تغییر نکرد

<b>وضعیت زنده:</b>
⚡ صدور ادامه دارد — NX-3667 WLDUSDT / NX-3668 TAOUSDT روی 00:16Z صادر شدند · کادنس ۱۰دقیقه‌ای فعال
⚠ بن fapi روی ۳ IP فعال است (پنجره ~۲۴دقیقه) — صدور degraded با تگ FAPI-DEG طبق دستور عملیات ادامه دارد
📊 سلامت: healthz 200 · pulse 0.8s · رله تلگرام ARMED

<i>حکم سنتینل: علت ریست پیدا، درمان و مهر سلامت شد — سیستم احیا و پایدار است. 🟢</i>`;

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
});
const j = await res.json();
console.log("send:", j.ok, j.description ?? "");
