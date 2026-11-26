# NEXUS//SIGNALS — راهنمای استقرار روی VPS ایران (IRAN-FA-0929)

> پاسخ به پرسش اپراتور ۲۰۲۶-۰۹-۲۹:
> «اگر داخل وی‌پی‌اس ایرانی بگذارم، بدون وابستگی به موتور هوش مصنوعی سیستم کار می‌کند یا نیاز به API دارد؟»

## پاسخ کوتاه (صادقانه، بدون تعارف)

۱. **سیستم به هیچ موتور هوش مصنوعی وابسته نیست.** حلقه اصلی سیستم = وب‌سوکت عمومی بای‌بیت → موتورهای سیگنال → دیتابیس SQLite → داشبورد + تلگرام. «موتور هوش مصنوعی» فقط سازنده و تعمیرکارِ این کد بود، نه قطعه‌ای از آن. تیک‌ها، سیگنال‌ها، بازوها، دفتر کل — همه بدون هیچ API هوش مصنوعی کار می‌کنند.

۲. **تنها جای LLM در سیستم، دو قابلیت اختیاری است:** «بازبینی مهندس ارشد» هر ۱۲ ساعت در supervisor-cron و پنل AI داشبورد. اگر LLM نباشد، سیستم صادقانه `llm_unavailable` را گزارش می‌دهد و **ادامه می‌دهد** — سوییپ‌ها، هشدارها، دفتر کل، هیچ‌کدام نمی‌میرند (این مسیر در کد اثبات‌شده است). اگر خواستی، Ollama را روی همان VPS بالا می‌آوری و با `LLM_PROVIDER=openai` به آن وصل می‌شود — بدون هیچ سرویس بیرونی.

۳. **اما دو سرویس بیرونی، IP ایران را مسدود کرده‌اند** (این محدودیت سیستم ما نیست؛ تحریم و فیلترینگ خودشان است):
   - **بای‌بیت/بایننس** — IP ایران را geo-block می‌کنند (HTTP 403). price-ws و liq-service بدون تونل وصل نمی‌شوند.
   - **api.telegram.org** — در ایران فیلتر است. پل تلگرام بدون تونل ارسال نمی‌کند.
   - **گیت‌هاب** — از ایران کار می‌کند (با PAT شخصی خودت). مشکلی ندارد.

۴. **راه‌حل هر دو مسدودی یک چیز است: WARP (کلادفلر، رایگان).** تونل WARP در لایه شبکه نصب می‌شود؛ **صفر تغییر در کد** — ترافیک خروجی VPS از کلادفلر عبور می‌کند و بای‌بیت/تلگرام باز می‌شوند.

---

## پیش‌نیازها

| مورد | حداقل | توصیه‌شده |
|---|---|---|
| VPS ایران | Ubuntu 22.04/24.04 · ۲GB RAM · ۲۰GB دیسک | ۴GB RAM اگر بعداً Ollama بخواهی |
| دسترسی | root + ssh | — |
| دانستن | هیچ — دستورها کپی/پیست است | — |

حافظه: کل زنجیرهٔ ۹ سرویسی در سندباکس با ۵۱۲MB–۱.۴GB می‌چرخید؛ روی VPS واقعی ۲GB راحت است. `next build` هنگام نصب لحظه‌ای RAM بیشتر می‌خواهد — برای همان یک بار، `NODE_OPTIONS=--max-old-space-size=2048` را از .env.example بردار (از پیش commented آماده است).

---

## گام ۰ — تونل خروجی WARP (قبل از هر چیز)

**روش اول — warp-cli (ساده‌ترین):**

```bash
curl -fsSL https://pkg.cloudflareclient.com/install.sh | sudo bash
warp-cli registration new
warp-cli mode warp
warp-cli connect
```

**روش دوم — wgcf (اگر مخزن apt کند بود؛ باینری تکی از گیت‌هاب):**

از صفحهٔ Releases پروژهٔ `ViRb3/wgcf` در گیت‌هاب آخرین باینری linux_amd64 را بگیر، بعد:

```bash
chmod +x wgcf && sudo mv wgcf /usr/local/bin/
wgcf register --accept-tos
wgcf generate
sudo cp wgcf-profile.conf /etc/wireguard/
sudo wg-quick up wgcf        # روشن‌کردن
sudo systemctl enable --now wg-quick@wgcf   # خودکارِ بعد از ری‌بوت
```

**راستی‌آزمایی تونل (هر سه باید سبز باشد قبل از ادامه):**

```bash
curl -s https://api.ipify.org        # باید IP غیرایرانی (Cloudflare) بدهد
curl -s -o /dev/null -w '%{http_code}\n' https://api.telegram.org   # 200/302 = باز
curl -s -o /dev/null -w '%{http_code}\n' https://stream.bybit.com/  # 200/426 = باز؛ 403 = تونل فعال نیست
```

> صداقت: WARP روی بعضی ISPهای ایران نوسان دارد. اگر بعد از مدتی ناپایدار بود، دو جایگزین داری: (الف) اکانت‌های WARP+ / تنظیمات جایگزین endpoint، (ب) یک VPS خارجی ارزان (~۴–۶ یورو/ماه) که همه‌چیز مستقیم و بی‌تونل کار می‌کند — برای ترمینال ۲۴/۷ سودمحور، پایدارترین راه همین است، اما نیاز به پرداخت ارزی دارد. تصمیم با خودت است.

---

## گام ۱ — نصب Bun و کلون پروژه

```bash
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc

sudo mkdir -p /home/z/my-project && sudo chown $USER /home/z/my-project
git clone https://github.com/<YOUR-REPO>/neo.git /home/z/my-project
cd /home/z/my-project

bun install
bunx prisma generate && bunx prisma db push
NODE_OPTIONS=--max-old-space-size=2048 bun run build
```

> **دیتا همراه clone می‌آید:** armor هر ۱۰ دقیقه دفتر کل (`db/custom.db`)، حافظهٔ بازوها (`.data/`) و کل کد را push می‌کند. `git clone` یعنی همهٔ تاریخچه + آخرین وضعیت، فقط پنجرهٔ اتلاف ≤۱۰ دقیقه. نیازی به انتقال دستی فایل نیست.

## گام ۲ — پر کردن پنج راز (همه مال خودت، هیچ‌کدام AI نیست)

```bash
cp deploy/.env.example .env
nano .env
```

| کلید | از کجا | برای چه |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather (رایگان، ۱ دقیقه) | هشدارها + گزارش فارسی + کانال کنترل |
| `TELEGRAM_CHAT_ID` | @userinfobot یا گروه خودت | مقصد همان پیام‌ها |
| `GITHUB_TOKEN` | Settings → Developer settings → PAT (رایگان) | بکاپ آفسایت هر ۱۰ دقیقه (اختیاری ولی به‌شدت توصیه‌شده) |
| `BRIDGE_TOKEN` / `NEXUS_CONTROL_KEY` / `BACKUP_PASSPHRASE` | خودت بساز: `openssl rand -hex 24` | رازهای داخلی سرور خودت |

بقیهٔ فایل همان پیش‌فرض خوب است. اگر LLM محلی می‌خواهی: `ollama pull qwen2.5:7b` بعد سه خط `LLM_PROVIDER=openai` را از کامنت دربیاور — تمام. اگر نمی‌خواهی، هیچ کاری نکن؛ سیستم با `llm_unavailable` دو قابلیت اختیاری را علامت می‌زند و ادامه می‌دهد.

## گام ۳ — اجرا (دو مسیر؛ جزئیات کامل در deploy/README.md)

**داکر (توصیه‌شده):**
```bash
docker build -f deploy/Dockerfile -t nexus-signals:latest .
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml exec app bunx prisma db push
```

**بدون داکر (systemd):**
```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-app nexus-minis nexus-guard
```

هر دو مسیر `restart: unless-stopped` / `Restart=always` دارند — یعنی **جایگزین ساختاریِ خط خونی پلتفرم**: ری‌استارت شد؟ سرویس‌ها خودشان بالا می‌آیند. هیچ بیرونی حق خاموش‌کردن ندارد.

## گام ۴ — چک‌لیست اولین راه‌اندازی

- [ ] `curl -s http://127.0.0.1:3000/api/healthz` → 200
- [ ] `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3003/` → 400 (= ws زنده؛ یعنی WARP و بای‌بیت بازند)
- [ ] پیام بوت در تلگرام رسیده
- [ ] `GET :3015/status` سوییپ GREEN با `lastEventAgeMin: 0`
- [ ] تست هشدار: یک بار price-ws را ۱۵ دقیقه نگه دار → باید RED + پیام تلگرام بیاید (دقیقاً همان درمان «۲۰ ساعت سکوت» — این تست را یک بار انجام بده!)
- [ ] داشبورد از مرورگر خودت: `http://SERVER-IP:3000`

---

## جدول صداقت نهایی

| ادعا | وضعیت |
|---|---|
| سیستم بدون موتور هوش مصنوعی کار می‌کند | ✅ اثبات‌شده — LLM فقط دو قابلیت اختیاری، با مسیر graceful |
| روی VPS ایران کار می‌کند | ✅ به شرط WARP برای بای‌بیت/تلگرام (گیت‌هاب مستقیم) |
| هیچ کلید پولی لازم است؟ | ✅ هیچ — تلگرام/گیت‌هاب رایگان؛ بای‌بیت فقط استریم عمومی (بدون کلید) |
| بدون LLM چه چیزهایی کم می‌شود؟ | فقط «بازبینی مهندس ارشد» و پنل AI داشبورد؛ چرخهٔ سیگنال/هشدار/دفتر کامل می‌ماند |
| سود تضمین است؟ | ❌ **نه.** من سازندهٔ زیرساخت هستم، نه تضمین‌کنندهٔ بازار. هیچ سیستمی سود تضمین نمی‌کند؛ با سرمایه‌ای که از دست دادنش زندگی‌ات را می‌شکند وارد نشو — مخصوصاً با بچه‌ای که راه است. |
| WARP همیشه پایدار است؟ | ⚠️ نه همیشه — اگر ناپایدار شد، RED می‌بینی و جایگزین: WARP+/endpoint دیگر یا VPS خارجی. |
