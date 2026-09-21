# 📋 گزارش ممیزی جامع NEXUS//SIGNALS

**وضعیت ردیابی و صدور سیگنال — نسخه ارائه به مهندس ارشد و اپراتور**

| | |
|---|---|
| تاریخ ممیزی اصلی | 2026-09-21 · 15:14 UTC |
| نسخه بازسازی‌شده | 2026-09-21 · 21:05 UTC — فایل اصلی توسط rollback پلتفرم حذف شده بود؛ از context ممیزی بازسازی شد |
| نوع ممیزی | فقط-خواندنی (Read-Only) روی کد زنده + تله‌متری زمان‌واقعی + DB |
| Verdict هنگام ممیزی | **AMBER** (سرویس‌ها 6/6 سبز؛ هشدار: چرخه بکاپ) |
| ⚠️ توجه | بعد از این ممیزی، پلتفرم کد را به پیش-R3 برگرداند (حادثه سوم). مرجع وضعیت فعلی: `docs/CHANGELOG-human.md` و worklog Task 10 |

---

## 0. خلاصه اجرایی (لحظه ممیزی)

| شاخص | مقدار زنده |
|---|---|
| وضعیت سرویس‌ها | 6/6 آنلاین: app:3000 / ws:3003 / bridge:3005 / liq:3010 / trade:3011 / sentinel:3030 |
| موتور | زنده — آخرین رویداد 13 ثانیه پیش، سرعت 1,817 رویداد/ساعت |
| سیگنال کل (EPOCH-2) | **692** = 335 SL / 319 EXPIRED / 33 TP3 / 1 TP1 / 4 ACTIVE |
| WR هفتگی | **31.2%** (433 ستل) · میانگین −1.14% لوریج‌دار · ستل میانگین 1.32 ساعت |
| Shadow Arms | **74/120** — real-keep 27/30 · real-veto 17/30 · paper-keep **30/30 ✅** · paper-veto 0/30 (mode-conditional) |
| رویداد روز | **RAWCAL بودجه کامل EPOCH-2 (671/671 ستل) تکمیل و 14:37Z خودکار خلع سلاح شد** |
| تأخیر پالس API | 63–70ms گرم / ~190ms سرد |

**پیام اصلی:** سیستم ردیابی سالم، سریع و traceable است. «نبود نتیجه» نه ضعف ردیابی بلکه طراحی سخت‌گیرانه دروازه ارتقا + اثبات‌نشده‌بودن لبه AI است.

## 1. معماری و سیم‌کشی
هاب = Next.js app :3000. هیچ سرویسی push نمی‌کند. Caddy :81 فقط XTransformPort=3003 → ws، بقیه → app، غیر از آن 403.
- app هر 20s از liq:3010 (timeout 2.5s)، 15s از trade:3011، proxy به bridge:3005 با x-nexus-key fail-closed
- sentinel تله‌متری بازوها را از API زنده می‌خواند (+ mirror اتمی به فایل legacy)
- خروجی تلگرام دوگانه-by-design: notify.ts داخل app (مسیر اصلی) + :3005 relay (بقا هنگام restart)

## 2. داده‌های ورودی
Binance fapi تیکر/کلاین (55s) · اجماع OKX/Bybit/HL (15s) · فور-لیکوییدیشن 4 صرافی (20s) · جریان ترد (35s) · OI/Funding (150s) · MTF کلاین (45–480s) · نهنگ‌ها (60s) · ماکرو (30min) · صدک نوسان (30min).
یونی‌ورس دینامیک 12–64 (پیش‌فرض 40)، رفرش 30min. محافظ‌ها: FEED-FRESH (3 خطا → بلوک)، SIM-PRICE BAN، SETTLEMENT STALENESS (>120s ممنوع).

## 3. موتور: تیک 4s + 26 ریل
setInterval(tick,4000)، MIN_TICK_MS=3500. ریل‌ها: %3 گرمایش · %8 shadow sweep · %10 RAWCAL+regime+dislocation · %12 PricePoint · %20 تله‌متری+TRIGGER BUS · %25 MTF/OI boards · %30 SUPERVISOR+SHADOW MODULES · %40 retroLink+closeRealOutcomes+autoPromote+learner+advisor · %45 liq-heat · %50 FLOW-SHIFT · %60 archive · %75 DEEP-LEARN · %80 pump journal · %150 VERDICT-CORE.

## 4. سرنوشت داده تا صدور
ادمیسون (FEED-FRESH→SIM-BAN→dedup→ضد-cascade) → 6 فاکتور کانفلوئنس ±100 → دسته استراتژی → effMin پویا → 24 دروازه سریالی → نردبان R:R (TP1=1R، TP2≈1.7R، TP3=rrR؛ SL=slAtr×ATR×regime) → سایز (2-8% از $100) → shadow-veto gate → db.signal.create(ACTIVE) → fireEvent(CREATED) → تلگرام → resolveSignals هر تیک → AFTERLIFE 48h → ledger → حلقه یادگیری.
**همه معاملات paper** ($100، کارمزد taker 0.05%×2+funding).

## 5. سرعت پردازش
پالس گرم 63–70ms · تشخیص واکنشی ≤4s (کش گرم) · سرد 10–20s · انتظارهای عمدی پاد-نوفه (RAWCAL 10min، trigger 8min، pump 20min، dedup 10-30min) · ستل میانگین 1.32h. شناسایی داده تأخیر مکانیکی ندارد — تأخیرها عمدی و پاد-نوفه‌اند.

## 6. قیف فیلترینگ (24 دروازه)
پری: FEED-FRESH، SIM-BAN، dedup نماد-باز، ضد-cascade. تعدیل آستانه: REGIME-L0، BTC-SPILLOVER، CHASE+6، MTF-BOARD، LIQ-HEAT، LESSON-GATE، PROBATION. سریالی: MEMORY-GATE (SQN)، BREAKOUT-GUARD، SHORT-GUARD، DISLOCATION، LEARNED+G4-PROBE، FLOW-GATE، ONSET-RETEST، CHASE-PRICE، VOL-BARRIER، DECISIVE-EXCURSION، RISK-CLUSTER، SHADOW-VETO، CAPACITY. + Governor (hysteresis 90min).

## 7. امتیازدهی
کانفلوئنس: EMA25/MACD15/RSI15/RANGE20/BOLL8/VOL8 با کالیبراسیون ×[0.75,1.25]. Confidence = 55+0.42|score|+بونوس [55,96] (زنده 82.6). Flow: CVD9/نهنگ5/OI7/cascade3/فاندینگ5/جمعیت4/top-trader6/شتاب5. صدور deterministic؛ LLM فقط داور shadow (grounding-audit).

## 8. ایجنت‌ها
AI Core داور (share 79.8%، توافق 72%) · GOVERNOR 45min · SUPERVISOR 2min · DEEP-LEARN 30min · VERDICT-CORE 30min · ADVISOR 6h · SENIOR-REVIEW شبانه · SENTINEL 60s/30min (هرگز heal نمی‌کند) · p0-WATCHDOG 15s (heal@2fails، esc@5، breaker 6/h) · watchdog.sh L2 60s (mutual revival).

## 9. یادگیری
Ledger → MEMORY-GATE/کالیبراسیون/LEARNED-GATE/REGIME-GOVERNOR/TTL/بازوها. بازوها: real-keep 27/30 · real-veto 17/30 · paper-keep 30/30 ✅ · paper-veto mode-conditional. RAWCAL: 175 صدور عمر، بودجه 671 ستل ✅ کامل. Promotion نیازمند n=30 + جدا‌یی Wilson — وتوی AI هنوز برنده حذف می‌کند → gate درست است که رد می‌کند.

## 10. ردیابی پس از صدور
ترانش 50/30/20 · BE-arm (NET≥+10%) · EARLY-EXIT (50% TTL) · TTL-GATE (+60m ×≤2 @3%) · AFTERLIFE 48h · **0 true TP-miss در 649 ستل** · 10 نوع رویداد RELAYABLE → کارت تلگرام.

## 11. عملکرد واقعی
7d: 433 ستل، WR 31.2%، −1.14% · 24h: WR 19.5%، −8.25% · EXPIRED دو ماهیت: runner (+32.2%) vs fizzle (−6.9%) · near-miss واقعی ~15/7d · نردبان سخت‌تر با داده رد شد (live +85.1R vs پژوهشی −8.8R) · رادار پمپ: آشکارساز 52.2% (55min)؛ سیگنال‌هایش ≈ کتاب (29.7% عمر) · کوهورت‌های trim زنده.

## 12–14. تاب‌آوری / جمع‌بندی / توصیه‌ها
بکاپ 3h (VACUUM INTO→AES→تلگرام+MANIFEST+env نسخه‌دار) · دو لایه watchdog با احیای متقابل · crash-test واقعی (~105s خودترمیم).
قوت: traceability کامل، صداقت‌سنجی سراسری، دروازه ارتقای سخت‌گیر. ضعف: WR زیر سربه‌سر، EXPIRED-dominance 46%. ریسک: dev-runtime، rollback پلتفرم (اثبات‌شده همین روز!)، SQLite تکی.
توصیه‌ها: پرشدن بازوها (3+13) → R6 lift کالیبراسیون → کاهش fizzle → اتصال syncTapeWatchlist → نگهداشت.

---
*بازسازی‌شده از context ممیزی پس از rollback پلتفرم؛ لخته اعداد اصلی 2026-09-21T15:14Z.*
