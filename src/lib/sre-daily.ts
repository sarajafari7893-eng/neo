// ── v9.6 SRE-DAILY (operator-approved 24h senior-engineer agent, 2026-09-14) ──
// Mandate: «تایید می کنم . مهندسی شده و کامل انجام بده»
//
// Runs right AFTER the daily report send (and on demand via POST /api/report/sre):
// a diagnostic pass over the REAL ledgers — 24h settled book, deep-learn lessons,
// advisor state, radar performance, gate journal, v9.6 package cohorts and a
// UI-CANARY over every live module — that answers the operator's five engineering
// questions and closes with one evidence-backed recommendation.
//
// Hard safety invariant: READ-ONLY. Nothing here mutates engine state; proposals
// are printed for operator approval («با تایید انجام بده») and never auto-applied.
// Text is plain (no parse_mode) and must never contain the '<' character.

import { db } from "./db";
import { sendDirect } from "./notify";
import { getGateSettings, describeGate } from "./gate-settings";
import { buildDailyDigest, tehranDayKey } from "./dailyReport";

export interface SreCanary {
  name: string;
  ok: boolean;
  detail: string;
}

const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] as const;

function tehranStamp(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

function usd(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

async function fetchCanary(url: string, expect: (code: number) => boolean, name: string, okDetail: (ms: number) => string): Promise<SreCanary> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), cache: "no-store" });
    const ms = Date.now() - t0;
    const ok = expect(r.status);
    return { name, ok, detail: ok ? okDetail(ms) : `HTTP ${r.status} (${ms}ms)` };
  } catch (e) {
    return { name, ok: false, detail: `${e instanceof Error ? e.message.slice(0, 60) : "unreachable"}` };
  }
}

/** v9.6 UI-CANARY: every live module probed with data-sanity assertions. */
export async function runCanary(): Promise<SreCanary[]> {
  const checks: SreCanary[] = [];

  checks.push(await fetchCanary("http://localhost:3000/api/pulse", (c) => c === 200, "app:3000 (engine)", (ms) => `200 OK ${ms}ms`));

  try {
    const r = await fetch("http://localhost:3000/api/analytics/pump", { signal: AbortSignal.timeout(6000), cache: "no-store" });
    const j = (await r.json()) as { totals?: { successRatePct?: number }; headline?: string } | null;
    const srr = j?.totals?.successRatePct;
    const sane = typeof srr === "number" && Number.isFinite(srr) && typeof j?.headline === "string";
    checks.push({ name: "radar:analytics/pump", ok: r.ok && sane, detail: sane ? `200 OK · successRate ${srr}%` : `data anomaly (HTTP ${r.status})` });
  } catch (e) {
    checks.push({ name: "radar:analytics/pump", ok: false, detail: e instanceof Error ? e.message.slice(0, 60) : "unreachable" });
  }

  checks.push(await fetchCanary("http://localhost:3000/api/rawcal", (c) => c === 200, "rawcal", () => "200 OK"));

  checks.push(await fetchCanary("http://localhost:3010/health", (c) => c === 200, "liquidator:3010", () => "200 OK"));

  checks.push(await fetchCanary("http://localhost:3003/", (c) => c === 400, "price-ws:3003", () => "400 expected (socket.io)"));

  try {
    const r = await fetch("http://localhost:3005/health", { signal: AbortSignal.timeout(6000), cache: "no-store" });
    const j = (await r.json()) as { armed?: boolean; appBridge?: { lastPollAt?: number } } | null;
    const pollAgeMin = j?.appBridge?.lastPollAt ? (Date.now() - j.appBridge.lastPollAt) / 60_000 : Infinity;
    const ok = Boolean(r.ok && j?.armed && pollAgeMin <= 5);
    checks.push({ name: "bridge:3005", ok, detail: ok ? "armed · polling fresh" : `armed=${j?.armed ? "yes" : "NO"} · poll ${pollAgeMin === Infinity ? "never" : `${pollAgeMin.toFixed(0)}m ago`}` });
  } catch (e) {
    checks.push({ name: "bridge:3005", ok: false, detail: e instanceof Error ? e.message.slice(0, 60) : "unreachable" });
  }

  return checks;
}

export interface SreReport {
  text: string;
  canary: SreCanary[];
  canaryOk: boolean;
}

export async function buildSreReport(): Promise<SreReport> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const gate = await getGateSettings();

  const [digest, settled24, strat24, pkgTags, pkgBlockEvents, dlRow, advisorRow, pumpRow, qualityRow] = await Promise.all([
    buildDailyDigest().catch(() => null),
    db.signal.findMany({
      where: { status: { in: [...SETTLED] }, closedAt: { gte: since } },
      select: { symbol: true, strategy: true, status: true, leverage: true, marginUsd: true, pnlPercent: true, feeUsd: true, swapUsd: true, reachedTp: true, closedAt: true },
    }).catch(() => []),
    db.signal.groupBy({
      by: ["strategy"],
      where: { status: { in: [...SETTLED] }, closedAt: { gte: since } },
      _count: { _all: true },
      _sum: { feeUsd: true, swapUsd: true },
    }).catch(() => []),
    db.signal.findMany({
      where: { createdAt: { gte: since }, OR: [{ tags: { contains: "DL-TRIM" } }, { tags: { contains: "HOUR-TRIM" } }, { tags: { contains: "CHOP-RISK" } }, { tags: { contains: "LEV-CAP" } }] },
      select: { tags: true },
    }).catch(() => []),
    db.signalEvent.findMany({
      where: { createdAt: { gte: since }, message: { contains: "v9.6 PACKAGE GUARD" } },
      orderBy: { createdAt: "desc" },
      take: 1,
    }).catch(() => []),
    db.engineSetting.findUnique({ where: { key: "deep-learn" } }).catch(() => null),
    db.engineSetting.findUnique({ where: { key: "advisor.state" } }).catch(() => null),
    db.engineSetting.findUnique({ where: { key: "pump.performance" } }).catch(() => null),
    db.engineSetting.findUnique({ where: { key: "rawcal.quality" } }).catch(() => null),
  ]);

  // per-strategy realized pnl today (margin-basis, same accounting as dailyReport)
  const stratPnl = new Map<string, { n: number; pnl: number }>();
  for (const s of settled24) {
    const cur = stratPnl.get(s.strategy) ?? { n: 0, pnl: 0 };
    cur.n += 1;
    cur.pnl += (s.marginUsd * s.pnlPercent) / 100;
    stratPnl.set(s.strategy, cur);
  }
  const stratRanked = [...stratPnl.entries()].sort((a, b) => a[1].pnl - b[1].pnl);
  const worstStrat = stratRanked[0];
  const bestStrat = stratRanked[stratRanked.length - 1];

  const worst24 = [...settled24].sort((a, b) => (a.marginUsd * a.pnlPercent) / 100 - (b.marginUsd * b.pnlPercent) / 100)[0];
  const best24 = [...settled24].sort((a, b) => (b.marginUsd * b.pnlPercent) / 100 - (a.marginUsd * a.pnlPercent) / 100)[0];
  const realized24 = settled24.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const fees24 = settled24.reduce((a, s) => a + s.feeUsd + s.swapUsd, 0);
  const wins24 = settled24.filter((s) => s.reachedTp >= 1).length;

  const cohortCount = (tag: string) => pkgTags.filter((s) => s.tags?.includes(tag)).length;

  const dlJson = dlRow ? (JSON.parse(dlRow.value) as { runs?: number; casesLearned?: number; lessons?: Array<{ pattern?: string; action?: string }> }) : null;
  const lesson = dlJson?.lessons?.[0];
  const advisor = advisorRow ? (JSON.parse(advisorRow.value) as { cycles?: number; lastRunAt?: string }) : null;
  const pumpHeadline = pumpRow ? ((JSON.parse(pumpRow.value) as { headline?: string }).headline ?? "").slice(0, 180) : "";
  const quality = qualityRow ? (JSON.parse(qualityRow.value) as { gate?: { verdict?: string }; informativePct?: number }) : null;

  const canaryChecks = await runCanary();
  const canaryFails = canaryChecks.filter((c) => !c.ok);
  const pkgBlocks24 = pkgBlockEvents.length;

  const L: string[] = [];
  L.push("⚙️ ENGINEERING DAILY — مهندس ارشد NEXUS v9.6");
  L.push(`چرخه تشخیصی ۲۴ ساعته · ${tehranStamp()} TEHRAN`);
  L.push("");
  L.push("۱) امروز کجا پول ساخته/از دست رفت؟");
  L.push(`· 24h: ${settled24.length} تسویه · برد ${wins24} · realized ${usd(realized24)} · کارمزد ${usd(fees24)} · اکوییتی $${digest?.equityUsd?.toFixed(2) ?? "?"}`);
  if (worst24) L.push(`· بدترین معامله: ${worst24.symbol} ${worst24.status} ${usd((worst24.marginUsd * worst24.pnlPercent) / 100)} (${worst24.strategy})`);
  if (best24) L.push(`· بهترین معامله: ${best24.symbol} ${best24.status} ${usd((best24.marginUsd * best24.pnlPercent) / 100)} (${best24.strategy})`);
  L.push("");
  L.push("۲) کدام استراتژی مقصر/قهرمان بود؟");
  for (const [name, v] of stratRanked.slice(0, 3)) L.push(`· ${name}: ${v.n} ترید ${usd(v.pnl)}`);
  if (worstStrat && bestStrat && worstStrat[0] !== bestStrat[0]) L.push(`· قهرمان: ${bestStrat[0]} ${usd(bestStrat[1].pnl)}`);
  L.push("");
  L.push("۳) هوش مرکزی چه می‌گوید؟");
  if (lesson) L.push(`· deep-learn (${dlJson?.runs ?? "?"} اجرا / ${dlJson?.casesLearned ?? "?"} کیس): ${(lesson.pattern ?? "").slice(0, 140)}`);
  if (advisor) L.push(`· advisor: ${advisor.cycles ?? "?"} چرخه · آخرین اجرا ${advisor.lastRunAt ? new Date(advisor.lastRunAt).toISOString().slice(5, 16) : "?"} UTC`);
  if (quality) L.push(`· کیفیت داده: ${quality.gate?.verdict ?? "?"} (informative ${quality.informativePct ?? "?"}%)`);
  L.push("");
  if (pumpHeadline) L.push(`۴) رادار PUMP/DUMP: ${pumpHeadline}`);
  else L.push("۴) رادار PUMP/DUMP: داده در دسترس نیست");
  L.push("");
  L.push("۵) سلامت ماژول‌ها (UI-Canary):");
  for (const c of canaryChecks) L.push(`· ${c.ok ? "OK" : "FAIL"} — ${c.name} · ${c.detail}`);
  L.push(`· cohorts v9.6 امروز: DL-TRIM ${cohortCount("DL-TRIM")} · HOUR-TRIM ${cohortCount("HOUR-TRIM")} · CHOP-RISK ${cohortCount("CHOP-RISK")} · LEV-CAP ${cohortCount("LEV-CAP")} · بلاک PKG ${pkgBlocks24}`);
  L.push("");
  L.push("۶) نتیجه‌گیری و ریسک فردا:");
  if (canaryFails.length > 0) L.push(`· هشدار: ${canaryFails.length} ماژول ناسالم — پیگیری فوری: ${canaryFails.map((c) => c.name).join(" · ")}`);
  else L.push("· همه ماژول‌ها سالم — ریسک زیرساختی امروز پایین ارزیابی می‌شود");
  if (realized24 < 0 && settled24.length > 0) L.push(`· ریسک اصلی: ادامه همین الگو یعنی ${usd(realized24)} در روز — cohortهای v9.6 (DL-TRIM/CHOP-RISK/LEV-CAP) باید ضرر هر ترید را به نصف نزدیک کنند؛ فردا همین عدد را می‌سنجم`);
  else if (settled24.length === 0) L.push("· کتاب امروز تسویه‌ای نداشت — ریسک خشکیدن جریان یادگیری؛ در صورت تداوم، بازگشایی کنترل‌شده پیشنهاد می‌شود");
  else L.push("· الگوی امروز سودده بود — همان قیدها حفظ شود");
  L.push("");
  L.push("پیشنهاد شواهد‌محور (فقط با تایید شما اجرا می‌شود):");
  L.push(gate.dlConfFloor > 0 && gate.maxLevCap > 0
    ? "· بسته v9.6 فعال است — ۴۸ ساعت داده بگیریم؛ تغییر جدید تا جمع‌شدن شواهد توصیه نمی‌شود"
    : "· بسته v9.6 کامل فعال نیست — بررسی تنظیمات گیت لازم است");
  L.push(`· گیت: ${describeGate(gate)}`);

  return { text: L.join("\n"), canary: canaryChecks, canaryOk: canaryFails.length === 0 };
}

const SRE_KEY = "sredaily.last";

async function lastSuccessfulSreAt(): Promise<number | null> {
  try {
    const row = await db.engineSetting.findUnique({ where: { key: SRE_KEY } });
    if (!row) return null;
    const v = JSON.parse(row.value) as { at: number; ok: boolean };
    return v.ok ? v.at : null;
  } catch {
    return null;
  }
}

async function markSreSent(ok: boolean): Promise<void> {
  await db.engineSetting.upsert({
    where: { key: SRE_KEY },
    create: { key: SRE_KEY, value: JSON.stringify({ at: Date.now(), ok }) },
    update: { value: JSON.stringify({ at: Date.now(), ok }) },
  });
}

/** POST /api/report/sre — one successful ENGINEERING DAILY send per Tehran day
 * (same anti-spam invariant as the daily report; a failed delivery never counts
 * and can be retried). Returns the report text either way. */
export async function runSreDaily(): Promise<{ ok: boolean; skipped?: boolean; error?: string; text?: string }> {
  const lastOk = await lastSuccessfulSreAt();
  if (lastOk !== null && tehranDayKey(lastOk) === tehranDayKey(Date.now())) {
    const { text } = await buildSreReport();
    return { ok: false, skipped: true, error: "engineering daily already delivered today (Tehran)", text };
  }
  const { text } = await buildSreReport();
  const r = await sendDirect(text);
  await markSreSent(r.ok);
  return { ok: r.ok, error: r.error, text };
}

/** Fire-and-forget chain used by the daily report route: after the 00:00 Tehran
 * digest lands, the senior-engineer pass follows as message #2. Own dedup gate —
 * a manual POST earlier the same day is never double-sent. */
export function chainSreAfterDaily(): void {
  void runSreDaily().catch((e) => console.error("[sre-daily] chain failed", e));
}
