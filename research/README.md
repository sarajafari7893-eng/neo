# RESEARCH // PRODUCTION BOUNDARY DOCTRINE
# دکترین مرز لایهٔ پژوهش و لایهٔ عملیاتی — NEXUS//SIGNALS

> Week-0 scaffolding (task 10-b, 2026-09-21). This directory is the **physical
> boundary** between the deterministic production trading engine and every
> experimental / LLM-driven research capability. Nothing in `research/` may
> ever be imported by the hot path. This file is doctrine — changes to it
> require an operator mandate and a worklog entry.
>
> این پوشش، مرز فیزیکی میان موتور معاملاتی قطعی (production) و تمام
> قابلیت‌های آزمایشی/پژوهشی مبتنی بر LLM است. هیچ چیزی از `research/` نباید
> به مسیر داغ (hot path) وارد شود. تغییر این سند فقط با دستور صریح اپراتور
> و ثبت در worklog مجاز است.

---

## 1. The two layers / دو لایه

### PRODUCTION HOT PATH (لایهٔ عملیاتی — مسیر داغ)
- **Definition:** `src/lib/engine.ts` **plus its entire synchronous import
  graph** — everything reachable from the 4-second tick.
  تعریف: `src/lib/engine.ts` و تمام گراف واردات همگام آن — هر چیزی که از تیک ۴ ثانیه‌ای قابل رسیدن باشد.
- **Properties:** deterministic; no LLM in the tick; every gate/knob clamped,
  journaled and audited (`src/lib/gate-settings.ts`, gate-journal, four-pack).
  ویژگی‌ها: قطعی؛ بدون LLM در تیک؛ هر گیت/کنوب clamp و journal و audit شده است.
- **Protected files (never edited by research agents):** `engine.ts`
  (esp. `deploySignal` path), `ai.ts`, `governor.ts`, `shadow-veto.ts`,
  `env-guard.ts`, `daily-scheduler.ts`, `instrumentation.ts`, middleware,
  `prisma/schema.prisma`, and every file in the tick's synchronous import graph.
  فایل‌های محافظت‌شده: موتور (به‌ویژه مسیر deploySignal)، ai، governor،
  shadow-veto، env-guard، daily-scheduler، instrumentation، میدل‌ور،
  اسکیما و همهٔ واردات همگام تیک.

### RESEARCH LAYER (لایهٔ پژوهش)
- **Definition:** this `research/` directory **plus** the explicitly-allowed
  research libs and their consumption points:
  تعریف: همین پوشهٔ `research/` به‌علاوهٔ کتابخانه‌های پژوهشی صراحتاً مجاز:
  - `src/lib/backtest.ts` — offline settlement replay (parity with live v6.6 arithmetic)
  - `src/lib/research-shadow.ts` — paper ladder journaled beside every live deployment (`.data/research-shadow/`)
  - `src/lib/strategy-probation.ts` — STRAT-PROBATION paper-arm probation before any strategy promotion
  - `src/lib/near-miss.ts` — BARRIER-CAP-NEAR-MISS / veto-near-miss paper queues
- Everything else in the research layer lives HERE, in `research/`, as
  self-contained modules with their own entry contracts.
  بقیهٔ لایهٔ پژوهش همین‌جا، به‌صورت ماژول‌های مستقل با قرارداد ورودی مشخص، زندگی می‌کند.

---

## 2. The rules / قواعد

| # | Rule (EN) | قاعده (FA) |
|---|---|---|
| R1 | Research agents may **READ** the ledger (signals, events, EngineSetting, journals, `.data/*` JSONL) freely. | ایجنت‌های پژوهشی می‌توانند دفتر کل (سیگنال‌ها، ایونت‌ها، EngineSetting، ژورنال‌ها) را آزادانه **بخوانند**. |
| R2 | Research agents may **WRITE only paper-arm inputs**: STRAT-PROBATION entries, research-shadow journals, and `research/hypotheses.jsonl`. | نوشتن فقط در ورودی‌های شاخهٔ کاغذی مجاز است: STRAT-PROBATION، ژورنال research-shadow و `research/hypotheses.jsonl`. |
| R3 | Research agents may **NEVER** edit `engine.ts`, the `deploySignal` path, or **add any gate/knob** to production. | ویرایش `engine.ts`، مسیر `deploySignal` یا افزودن هر گیت/کنوب به production **هرگز** ممنوع است. |
| R4 | **No new knob or gate enters production without a statistical gate**: the Phase-1 Overfit-Auditor (DSR / PBO / CPCV) must sign off first — see §3. | هیچ کنوب/گیت جدید بدون گیت آماری وارد production نمی‌شود: اول Overfit-Auditor فاز-۱ (DSR/PBO/CPCV) باید تأیید کند. |
| R5 | Every change is recorded in the **append-only** `worklog.md` and the trials registry (`.data/trials-registry.jsonl`) so it stays reversible. | هر تغییر در `worklog.md` (فقط-افزودنی) و رجیستری آزمایش‌ها ثبت می‌شود تا همیشه برگشت‌پذیر باشد. |
| R6 | New LLM usage must declare its tier (`hot` / `background` / `research`) to the credit-budget ledger (`src/lib/credit-budget.ts`) once phase-2 wiring lands. | هر مصرف LLM جدید باید tier خود را به دفتر بودجه اعتبار اعلام کند (بعد از سیم‌کشی فاز-۲). |

---

## 3. Planned research agents (future `research/` modules) / ایجنت‌های برنامه‌ریزی‌شده

### 3.1 `research/hypothesis-agent` — HYPOTHESIS AGENT
- **Entry contract:** consumes the ledger read-only; emits **at most
  2 hypotheses per week** into `research/hypotheses.jsonl` (one JSON line per
  hypothesis: `id, at, claim, metric, cohort, falsificationPlan, status`).
- قرارداد ورودی: فقط-خواندنی از دفتر کل؛ حداکثر **۲ فرضیه در هفته** در
  `research/hypotheses.jsonl` ثبت می‌کند (هر خط یک فرضیه با طرح ابطال).
- Output is a *paper-arm input only* — a hypothesis has zero effect on
  production until it survives the Critic AND the Auditor (R2/R4).

### 3.2 `research/adversarial-critic` — ADVERSARIAL CRITIC
- **Entry contract:** for every hypothesis it **must attempt falsification**
  before any promotion: recompute the claimed edge on out-of-sample cohorts,
  hunt censoring/selection bias, stress the metric against fee/latency
  reality, and write a verdict (`falsified | survived | inconclusive`) with
  the exact queries used.
- قرارداد ورودی: برای هر فرضیه باید **تلاش برای ابطال** انجام دهد — بازمحاسبهٔ
  لبهٔ ادعاشده روی دادهٔ خارج از نمونه، شکار سانسور/سوگیری انتخاب، تنش سنجش
  مقابل کارمزد/تأخیر، و ثبت حکم نهایی به‌همراه کوئری‌های دقیق.
- A hypothesis the critic did not attack is not a hypothesis; it is noise.

### 3.3 `research/overfit-auditor` — OVERFIT-AUDITOR (Phase-1 statistical gate)
- **Entry contract:** owns **DSR (Deflated Sharpe Ratio), PBO (Probability of
  Backtest Overfitting), CPCV (Combinatorially-Purged Cross-Validation)** for
  every proposed knob/gate/config change **before** it may touch production.
  Its trials-count input is the append-only `.data/trials-registry.jsonl`
  (`src/lib/trials-registry.ts`) — every knob/gate/config/hypothesis trial
  must be recorded there, honestly, including the ones that failed.
- قرارداد ورودی: مالک **DSR / PBO / CPCV** برای هر تغییر پیشنهادی کنوب/گیت/کانفیگ
  **پیش از** ورود به production. ورودی شمارش آزمایش‌ها از
  `.data/trials-registry.jsonl` (فقط-افزودنی) تأمین می‌شود — هر آزمایش،
  موفق یا ناموفق، باید با صداقت ثبت شود.
- Verdicts are binary and logged: `PASS → operator-visible proposal`,
  `FAIL → hypothesis archived with the failure reason`.

---

## 4. Promotion path / مسیر ارتقا (the only door into production)

```
ledger (read-only)
   → Hypothesis Agent   (≤2/week, research/hypotheses.jsonl)
   → Adversarial Critic (falsification attempt mandatory)
   → paper arm          (STRAT-PROBATION / research-shadow / near-miss queues)
   → Overfit-Auditor    (DSR / PBO / CPCV + trials registry)
   → operator mandate   (explicit approval + worklog + reversible changelog)
   → THEN, and only then, a human-supervised edit outside research/
```
```
دفتر کل (فقط-خواندنی) → ایجنت فرضیه (≤۲/هفته) → منتقد خصم (ابطال اجباری)
→ شاخهٔ کاغذی → ممیز بیش‌برازش (DSR/PBO/CPCV) → دستور اپراتور
→ و فقط بعد از آن، ویرایشِ تحت‌نظارت انسان بیرون از research/
```

Anything that skips a door is an incident, not a shortcut.
هر مسیری که از این درها عبور نکند «حادثه» است، نه میان‌بر.
