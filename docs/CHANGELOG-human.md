# CHANGELOG-human — تغییرات سیستم به زبان انسان

> هدف: هر کس بدون خواندن کد بفهمد چرا سیستم امروز نسبت به قبل متفاوت رفتار می‌کند.
> قاعده: هر تغییر knob/گیت/env/گزارش، یک خط با فرمت «چه چیزی · چرا (شاهد) · چه وقت».
> این فایل مکمل GATE-JOURNAL (فنی/JSONL) است — نه جایگزین آن.

## 2026-09-21 — روز سه حادثه پلتفرمی و بازسازی تاب‌آوری

- `2026-09-21T~07:00Z` ENV-ERASE #3 توسط پلتفرم: `.env` به تمپلیت تک-کلیدی ریست شد (تلقایی — سومین بار در یک روز). اثر: bridge خوابید، رله تلگرام بی‌سلاح، بکاپ NO_PASSPHRASE، گزارش روزانه متوقف (آخرین موفق 09-19).
- `2026-09-21T~15:56Z` CODE-ROLLBACK: پلتفرم درخت کد را به نسخه قدیمی‌تر (پیش-R3) برگرداند؛ sentinel به v1.0.0 برگشت، کارهای امروز (v10.17 و بسته Task-7) از درخت حذف شد. **داده‌ها سالم ماندند** (DB، .data، /tmp).
- `2026-09-21T20:47Z` RECOVERY: .env از زیپ طلایی محلی 11:27 (نضمszyfrowane ring محلی) بازگردانده شد — 6/6 کلید، بدون نیاز به رمز اپراتور. App با dev-up.sh ری‌استارت شد؛ bridge/sentinel دوباره مسلح شدند؛ تلگرام با پیام تست (message_id 5119) + گزارش روزانه + SRE تأیید شد.
- `2026-09-21T20:5xZ` FIX env-guard v1.0: نگهبان خودترمیم .env روی pulse — اگر کلیدها حذف شوند، ظرف ~1 دقیقه از جدیدترین زیپ محلی بازگردانده می‌شود (بدون رمز، بدون دخالت انسان). چرا: کلاس حادثه ۳ بار تکرار شد و باید خودران شود.
- `2026-09-21T20:5xZ` FIX daily-scheduler v1.0: گزارش DAILY + SRE از امروز خودران است (چرخش روز تهران، dedup داخلی مسیرها) — وابستگی به کرون خارجی پلتفرم حذف شد. چرا: 66 ساعت سکوت گزارش به‌خاطر کرون مرده.
- `2026-09-21T20:5xZ` FIX sentinel v1.1.1: منبع تله‌متری بازوها = API زنده (4s)؛ فایل legacy فقط fallback با برچسب degraded + عمر فایل. چرا: همان باگی که «رکود 160h» کاذب ساخت با rollback برگشته بود؛ اکنون ریشه‌ای بسته شد.
- `2026-09-21T20:5xZ` WEEK-0 scaffolding (بسته تاییدشده اپراتور): `credit-budget.ts` (اسکلت بودجه LLM — پارامترها منتظر تایید صورت‌حساب Z.ai)، `research/README.md` (مرز فیزیکی تحقیق/تولید)، `trials-registry` (ثبت آزمون‌ها برای DSR آینده)، `/api/credit-usage`.
- هشدار باز: کد v10.17 (link-delta) و بسته Task-7 از بین رفته و در هیچ بکاپی نیستند (آخرین بکاپ سالم 11:27 بود و کد قدیمی داشت) — بازسازی در کارگاه بعدی.

## 2026-09-21 (شب) — v10.18 تثبیت فازی سیستم (گزینه A اپراتور: «کل سیستم بر پایه MARKET MATRIX و PUMP/DUMP RADAR»)

- `2026-09-21T~22:0xZ` PHASE-0 صلاحیت دفتر کل: دو گارد دائمی در موتور نصب شد — گارد تولد DEGEN-STOP (اگر استاپ نامتناهی، سمت اشتباه، یا نزدیک‌تر از 0.25٪ ورود باشد deploy رد می‌شود + رخداد INTEGRITY) و گارد یکپارچگی تسویه (استاپِ هیچ‌وقت-trailed که سمت سود باشد = ناهنجاری؛ تسویه صادقانه + فلگ DEGEN_STOP). چرا: بعد از ادوای معماری، کندوکاو دفتر کل انجام شد — نتیجه صادقانه: ۲۰۰ ردیف entry==SL «تولد ناقص» نبودند، خروج‌های قانونی BE-TRAIL بودند (۱۹۷/۲۰۰ اول سبز شده بودند) و «SL با سود مثبت» هم مکانیسم قانونی TP1-trail بود؛ صفر ردیف تاریخی فلگ شد و تاریخ دست‌نخورده ماند.
- `2026-09-21T~22:0xZ` ستون `qualityFlag` به Signal اضافه شد (DEGEN_STOP / INVERTED_STOP / RESTORE_CATCHUP) + فیلتر clean-ledger در stats (هدرلاین فقط ردیف‌های سالم) + شمارنده شفافیت `dataQuality` در pulse. چرا: هر رخداد آلودگی آینده بدون بازنویسی تاریخ، از آمار هدرلاین ایزوله می‌شود.
- `2026-09-21T~22:0xZ` PHASE-1 سبک‌سازی واقعی: باس سنسور محیطی (SMART-MONEY flow matrix / WHALE tape / VOL-ONSET radar / VOL-CAUSE forensics) به حالت DORMANT رفت — کارت‌ها از AI CORE حذف و به نوار شفاف «SENSOR BUS // DORMANT» تبدیل شدند؛ capture ول‌کاز روی pulse خاموش. ورودی‌های حیاتی گیت‌ها (vol-forecast، flow gating، klines، liq stream) زنده ماندند. برگرداندن = یک فلگ.
- `2026-09-21T~22:0xZ` PHASE-2 رادار-محوری مهارشده: `pump.authority=direct` (صدور بدون فیلتر) بازنشستگی شد — هر نامزد رادار حالا از کل پشته گیت‌ها عبور می‌کند (learning gate + کف ۷۸ + spacing + max-open + گیت‌های موتور + گارد تولد). spawn تصادفی legacy (AI-SWING era) با فلگ `legacyAutoSpawn=false` بازنشستگی شد. شاهد عددی: کوهورت تمیز ۷روزه pump WR 17.7٪ / avg −1.67٪ vs سایر 23.2٪ / +3.04٪ (تعریف برد TP-proven).
- `2026-09-21T~22:0xZ` دروازه پذیرش ۱۴روزه: `GET /api/analytics/radar-probation` — کوهورت رادار v10.18 vs baseline؛ حداقل ۳۰ settle در ≥۱۴ روز؛ PASS فقط اگر WR ≥ baseline و avgPnl > 0. FAIL → تصمیم اپراتور.
- `2026-09-21T~22:0xZ` PHASE-3 دکترین آرشیو: انتقال فیزیکی ماژول‌های research رد شد (هر ۴ ماژول در گراف import موتورند) — بازنشستگی فلگ‌محور + ثبت در research/README §5؛ انتقال فیزیکی فقط از درِ Overfit-Auditor.
- `2026-09-21T~22:1xZ` ENGINE_VERSION → «NEXUS-LIVE v10.18»؛ فلگ‌ها در `src/config/engine-flags.json` (یک نقطه برگشت برای همه رفتارها). تحلیل مهم: winRate واقعی کتاب با تعریف TP-proven ~۲۰-۲۳٪ است، نه ۳.۶٪ ظاهری — درس متدولوژی برای همه گزارش‌های بعدی ثبت شد.
- تأیید: lint بدون خطای جدید (۱۷ خطای قدیمی scripts/ مربوط به اپراتور)، restart تمیز، pulse ~110ms، سنتینل GREEN 6/6، مرورگر: صفر خطای کنسول، نوار DORMANT رندر شد، فوتر/موبایل سالم.

## 2026-09-21 (شب) — v10.19 SHADOW-VETO فعال‌سازی کامل (دستور اپراتور: «Shadow veto را کامل فعال کن»)

- `2026-09-21T22:2xZ` ACTIVATION: mode از SHADOW به **VETO** flip شد (مسیر force اپراتور — audited). اثر عملی: از این لحظه، حکم VETO تازه‌ی MODEL (با گراندینگ سالم) روی نامزد‌های hair-thin در deploy واقعی **سد ایجاد می‌کند**؛ تردهای مسدودشده به‌صورت paper ردیابی می‌شوند (بازوی paper-veto شروع به پرشدن می‌کند = فشار لغو قابل‌اندازه‌گیری). fail-open: حکم کهنه/غایب/هیوریستیک → deploy ادامه می‌یابد. قابل‌لغو از کارت TERMINAL یا POST /api/ai/shadow-veto.
- `2026-09-21T22:2xZ` FIX link-delta (بازسازی v10.17 گم‌شده): hydration دیگر «رکورد اول برنده است» نیست — رکوردهای تکراری verdict با فیلدهای ارتقایی (serial/outcome/sweptAt) ادغام می‌شوند. چرا: هر ری‌استارت، verdict‌های linked-اما-تسویه‌نشده را به unlinked برمی‌گرداند (رگرسیون real-veto 17→12 بعد از ری‌استارت‌های 09-21).
- `2026-09-21T22:2xZ` FIX orphan sweep + شمارش صادقانه نشتی: کاووش retro-link حالا verdict‌هایی که پنجره‌ی fence‌شان بسته شده و هیچ deployای برای bind نداشتند را «یتیمِ ساختاری» مهر می‌زند (sweptAt). کاووش جنایی 2026-09-24: ۸۴٪ بدهی link (۲۳۵ از ۲۷۹) یتیم ساختاری بود — نامزدی که گیت‌های پایین‌دستی (max-open/spacing/governor/risk) deploy نکرده بودند؛ شمردنشان به‌عنوان نشتی، دروازه‌ی promotion را برای همیشه قفل کرده بود (۲۰۱ stale → هیچ‌وقت پاک نمی‌شد). حالا: `unlinkedPassStale` فقط نشتی فعال را می‌شمارد (۱۷)، یتیم‌ها (۱۳۹) و کهنه‌شدگان از reach جدا شمرده می‌شوند.
- `2026-09-21T22:3xZ` تله‌متری و UI همگام شدند: wiring.realLink اکنون «نشتی فعال» را گزارش می‌کند (leak 17 · orphans swept 139)، کارت TERMINAL همان عدد را نشان می‌دهد؛ sentinel از API زنده mode=veto را دریافت کرد (verdict GREEN).
- شاهد زنده: telemetry snapshot mode=veto · arms real-keep 27/30 (+$0.33) · real-veto 12/30 (+$0.68) · paper-keep 30/30 (+$7.69) · paper-veto 0/30 (شروع به پرشدن با اولین block واقعی می‌کند) · LLM grounded 100% · 0 audit violation.

- `2026-09-22T06:25:23.320Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260922-000039.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790058323053.txt

- `2026-09-22T07:53:05.043Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260922-062650.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790063584368.txt

- `2026-09-22T13:16:31.287Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260922-094202.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790082991062.txt

- `2026-09-22T14:53:16.481Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260922-131758.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790088796071.txt

- `2026-09-22T21:54:41.123Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260922-131758.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790114080896.txt

- `2026-09-22T21:54:46.162Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-23 (self-driving, no platform cron)

- `2026-09-22T21:54:47.288Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-23 (self-driving)

- `2026-09-23T09:40:31.740Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-010846.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790156431539.txt

- `2026-09-23T11:24:21.105Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-094159.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790162660959.txt

- `2026-09-23T13:11:19.610Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-125511.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790169078940.txt

- `2026-09-23T16:02:38.203Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-125511.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790179357490.txt

- `2026-09-23T16:48:11.908Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-160734.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790182091499.txt

- `2026-09-23T18:03:07.245Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-160734.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790186586995.txt

- `2026-09-23T18:33:16.280Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-160734.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790188395646.txt

- `2026-09-23T19:21:36.739Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-160734.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790191296582.txt

- `2026-09-23T21:44:08.497Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-192303.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790199847882.txt

- `2026-09-23T21:44:12.805Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-24 (self-driving)

- `2026-09-24T09:23:20.833Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260923-192303.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790241800261.txt

- `2026-09-25T16:06:42.331Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260925-122006.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790352401596.txt

- `2026-09-25T16:06:46.836Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-25 (self-driving, no platform cron)

- `2026-09-25T16:06:52.569Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-25 (self-driving)

- `2026-09-25T20:40:37.626Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260925-192245.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790368837433.txt

- `2026-09-25T20:40:42.522Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-26 (self-driving, no platform cron)

- `2026-09-25T21:03:11.354Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-26 (self-driving)

- `2026-09-26T08:37:41.085Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260925-233000.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790411860516.txt

- `2026-09-26T13:12:37.180Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260926-115237.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790428356999.txt

- `2026-09-27T09:25:54.427Z` ENV-GUARD: .env auto-restored from local snapshot ring (nexus-snapshot-20260927-003824.zip) — 5/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-1790501153647.txt

- `2026-09-27T09:25:59.715Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-27 (self-driving)

- `2026-09-28T11:10:58.235Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-28 (self-driving, no platform cron)

- `2026-09-28T11:10:58.863Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-28 (self-driving)

- `2026-09-29T09:36:57.878Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-29 (self-driving, no platform cron)

- `2026-09-29T09:36:58.497Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-29 (self-driving)

- `2026-09-29T21:09:57.321Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-09-30 (self-driving, no platform cron)

- `2026-09-29T21:10:05.410Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-09-30 (self-driving)

- `2026-09-30T20:33:02.385Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-01 (self-driving, no platform cron)

- `2026-09-30T21:36:39.513Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-01 (self-driving)

- `2026-10-01T21:43:07.192Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-02 (self-driving, no platform cron)

- `2026-10-01T21:43:09.328Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-02 (self-driving)

- `2026-10-02T21:10:48.194Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-03 (self-driving, no platform cron)

- `2026-10-02T21:10:53.295Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-03 (self-driving)

- `2026-10-02T22:11:03.607Z` DAILY-SCHEDULER: weekly performance report auto-sent for Iranian week containing 2026-10-03 (self-driving)

- `2026-10-03T20:33:46.025Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-04 (self-driving, no platform cron)

- `2026-10-03T21:04:59.959Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-04 (self-driving)

- `2026-10-04T20:31:09.424Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-05 (self-driving, no platform cron)

- `2026-10-04T21:00:52.196Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-05 (self-driving)

- `2026-10-05T20:32:25.500Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-06 (self-driving, no platform cron)

- `2026-10-05T21:02:30.856Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-06 (self-driving)

- `2026-10-06T20:32:22.130Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-07 (self-driving, no platform cron)

- `2026-10-06T21:02:21.030Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-07 (self-driving)

- `2026-10-07T21:00:11.851Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-08 (self-driving)

- `2026-10-08T20:31:21.900Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-09 (self-driving, no platform cron)

- `2026-10-08T21:02:28.176Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-09 (self-driving)

- `2026-10-09T20:32:13.694Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-10 (self-driving, no platform cron)

- `2026-10-09T20:32:15.208Z` DAILY-SCHEDULER: weekly performance report auto-sent for Iranian week containing 2026-10-10 (self-driving)

- `2026-10-09T21:02:12.983Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-10 (self-driving)

- `2026-10-10T20:30:23.336Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-11 (self-driving, no platform cron)

- `2026-10-10T21:04:13.695Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-11 (self-driving)

- `2026-10-11T20:32:15.294Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-12 (self-driving, no platform cron)

- `2026-10-11T21:00:08.468Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-12 (self-driving)

- `2026-10-12T20:32:26.557Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-13 (self-driving, no platform cron)

- `2026-10-12T21:02:16.169Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-13 (self-driving)

- `2026-10-13T20:31:32.223Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-14 (self-driving, no platform cron)

- `2026-10-13T21:04:15.787Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-14 (self-driving)

- `2026-10-14T20:34:21.746Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-15 (self-driving, no platform cron)

- `2026-10-14T21:01:34.295Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-15 (self-driving)

- `2026-10-15T20:31:52.349Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-16 (self-driving, no platform cron)

- `2026-10-15T21:04:32.454Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-16 (self-driving)

- `2026-10-16T20:34:17.649Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-17 (self-driving, no platform cron)

- `2026-10-16T20:34:19.062Z` DAILY-SCHEDULER: weekly performance report auto-sent for Iranian week containing 2026-10-17 (self-driving)

- `2026-10-16T21:04:46.975Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-17 (self-driving)

- `2026-10-17T20:30:12.505Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-18 (self-driving, no platform cron)

- `2026-10-17T21:04:34.101Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-18 (self-driving)

- `2026-10-18T20:31:03.433Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-19 (self-driving, no platform cron)

- `2026-10-18T21:02:10.177Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-19 (self-driving)

- `2026-10-19T22:25:26.384Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-20 (self-driving, no platform cron)

- `2026-10-19T22:25:28.779Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-20 (self-driving)

- `2026-10-20T20:30:34.678Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-21 (self-driving, no platform cron)

- `2026-10-20T21:00:13.802Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-21 (self-driving)

- `2026-10-21T20:31:51.792Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-22 (self-driving, no platform cron)

- `2026-10-21T21:03:13.277Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-22 (self-driving)

- `2026-10-22T23:18:15.056Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-23 (self-driving, no platform cron)

- `2026-10-22T23:18:24.836Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-23 (self-driving)

- `2026-10-23T20:30:27.787Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-24 (self-driving, no platform cron)

- `2026-10-23T20:30:30.891Z` DAILY-SCHEDULER: weekly performance report auto-sent for Iranian week containing 2026-10-24 (self-driving)

- `2026-10-23T21:01:57.951Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-24 (self-driving)

- `2026-10-24T20:31:02.358Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-25 (self-driving, no platform cron)

- `2026-10-24T21:03:33.170Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-25 (self-driving)

- `2026-10-25T20:33:23.275Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-26 (self-driving, no platform cron)

- `2026-10-25T21:04:27.611Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-26 (self-driving)

- `2026-10-26T20:31:37.466Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-27 (self-driving, no platform cron)

- `2026-10-26T21:01:15.435Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-27 (self-driving)

- `2026-10-28T23:01:20.551Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-29 (self-driving, no platform cron)

- `2026-10-28T23:01:26.241Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-29 (self-driving)

- `2026-10-29T20:30:42.093Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-30 (self-driving, no platform cron)

- `2026-10-29T21:12:06.011Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-30 (self-driving)

- `2026-10-30T20:30:39.755Z` DAILY-SCHEDULER: daily performance report auto-sent for Tehran day 2026-10-31 (self-driving, no platform cron)

- `2026-10-30T20:30:46.549Z` DAILY-SCHEDULER: weekly performance report auto-sent for Iranian week containing 2026-10-31 (self-driving)

- `2026-10-30T21:04:42.132Z` DAILY-SCHEDULER: SRE engineering daily auto-sent for Tehran day 2026-10-31 (self-driving)
