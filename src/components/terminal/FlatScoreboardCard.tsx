"use client";

// ── Task 84 FLAT-10 SCOREBOARD CARD (operator mandate 2026-10-06) ───────────
// «مارجین ثابت $10 + معیار سوددهی فقط EST PNL%» → واحد رسمی سوددهی.
// Score = estPnl% (fee-net, margin-invariant, REALITY-ONLY from settled rows).
// $ = netPct × 10/100 — exact linear rescale. +100%/day ≡ +$10/day.
// Basis $1000 (unit = 1%) · physical $100 SEED untouched · live promotion
// only via operator APPROVE after paper confirmation.
// RAM-DISCIPLINE (Task-83 lesson): consumes the SHARED pulse feed — this card
// runs ZERO polling loops of its own.

import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { usePulse } from "@/hooks/usePulse";
import type { FlatDayBarDTO, FlatScoreboardBlockDTO, GoldenLaneBlockDTO } from "@/lib/api-types";

function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(digits)}%`;
}

function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(digits)}`;
}

const toneOf = (v: number | null | undefined): string =>
  v === null || v === undefined ? "text-zinc-100" : v > 0 ? "text-emerald-300" : v < 0 ? "text-rose-300" : "text-zinc-100";

/* ── 30-day bar strip (pure divs — no chart lib, RAM-lean) ────────────────── */
function BarStrip({ bars, target }: { bars: FlatDayBarDTO[]; target: number }) {
  if (!bars.length) return <div className="py-6 text-center text-[11px] text-zinc-500">هنوز دادهٔ ستل‌شده‌ای نیست</div>;
  const scaleMax = Math.max(target, ...bars.map((b) => Math.abs(b.netPct)), 50);
  const targetH = (target / scaleMax) * 100;
  return (
    <div>
      <div className="relative flex h-24 items-end gap-[2px]" role="img" aria-label="نمودار روزانه estPnl٪ در واحد فلت-۱۰">
        <div
          className="pointer-events-none absolute inset-x-0 border-t border-dashed border-amber-400/50"
          style={{ bottom: `${targetH}%` }}
        />
        <span className="pointer-events-none absolute right-1 -translate-y-1/2 text-[8px] font-bold text-amber-300/80" style={{ bottom: `${targetH}%` }}>
          TARGET {target}%
        </span>
        {bars.map((b) => {
          const h = Math.max(2, (Math.abs(b.netPct) / scaleMax) * 100);
          const pos = b.netPct >= 0;
          return (
            <div key={b.dayKey} className="group relative flex h-full flex-1 flex-col justify-end" title={`${b.dayKey} · ${pct(b.netPct)} · ${usd(b.flat10Usd)} · ${b.n} معامله${b.partial ? " · در جریان" : ""}`}>
              <div
                className={`w-full rounded-t-[2px] ${pos ? "bg-emerald-400/70 group-hover:bg-emerald-300" : "bg-rose-500/70 group-hover:bg-rose-400"} ${b.partial ? "opacity-60" : ""} ${b.targetHit ? "ring-1 ring-amber-300/80" : ""}`}
                style={{ height: `${pos ? h : 0}%` }}
              />
              <div
                className={`w-full rounded-b-[2px] ${pos ? "" : "bg-rose-500/70 group-hover:bg-rose-400"} ${b.partial ? "opacity-60" : ""}`}
                style={{ height: `${!pos ? h : 0}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-zinc-500">
        <span>{bars[0]?.dayKey.slice(5)}</span>
        <span>۲۰ روز اخیر (تهران) · حلقهٔ کهربایی = هدف +{target}%</span>
        <span className="text-amber-300/80">{bars[bars.length - 1]?.dayKey.slice(5)} (در جریان)</span>
      </div>
    </div>
  );
}

/* ── stat cell ──────────────────────────────────────────────────────────────── */
function Cell({ k, v, tone, sub }: { k: string; v: string; tone?: string; sub?: string }) {
  return (
    <div className="rounded bg-white/[0.03] px-2 py-1.5">
      <div className={`text-[13px] font-bold ${tone ?? "text-zinc-100"}`}>{v}</div>
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">{k}</div>
      {sub ? <div className="text-[9px] text-zinc-600">{sub}</div> : null}
    </div>
  );
}

/* ── day panel (today / yesterday) ─────────────────────────────────────────── */
function DayPanel({ label, d, target }: { label: string; d: FlatScoreboardBlockDTO["today"]; target: number }) {
  if (!d) {
    return (
      <div className="rounded-lg border border-white/5 bg-black/20 p-4">
        <div className="text-[11px] font-semibold text-zinc-400">{label}</div>
        <div className="mt-2 text-[12px] text-zinc-500">هنوز معاملهٔ ستل‌شده‌ای در این روز ثبت نشده</div>
      </div>
    );
  }
  const progress = d.targetProgressPct ?? 0;
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold text-zinc-300">{label}</span>
        <span className="text-[10px] text-zinc-500">{d.n} ستل</span>
      </div>
      <div className="mt-2 flex items-baseline gap-3">
        <span className={`text-3xl font-black tracking-tight ${toneOf(d.netPct)}`}>{pct(d.netPct)}</span>
        <span className={`text-lg font-bold ${toneOf(d.flat10Usd)}`}>{usd(d.flat10Usd)}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full transition-all ${progress >= 100 ? "bg-amber-300" : "bg-emerald-400/80"}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-zinc-500">
        <span>پیشرفت به هدف +{target}% (≡ +$10)</span>
        <span>{progress.toFixed(0)}%</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Cell k="gross estPnl%" v={pct(d.grossPct)} tone={toneOf(d.grossPct)} />
        <Cell k="جرم فیس روز" v={d.feePct !== null ? `−${Math.abs(d.feePct).toFixed(1)}%` : "—"} tone="text-amber-300" />
      </div>
    </div>
  );
}

/* ── main card ─────────────────────────────────────────────────────────────── */
export default function FlatScoreboardCard() {
  const { data } = usePulse();
  const fsb = data?.feed?.flatScoreboard ?? null;
  const lanes = data?.feed?.goldenLane ?? null;
  if (!fsb) return null;

  const lane10 = (g: GoldenLaneBlockDTO | null) =>
    g?.lanes.map((l) => ({ id: l.id, name: l.name.split(" (")[0], net10: Number((l.net2 * 5).toFixed(2)) })) ?? [];

  return (
    <BentoCard className="lg:col-span-12">
      <div dir="rtl">
        {/* header */}
        <div className="flex flex-wrap items-center gap-2">
          <LiveDot />
          <h3 className="text-[15px] font-bold tracking-wide text-zinc-100">مارک‌بورد رسمی FLAT-10</h3>
          <NeonBadge tone="neon">{fsb.version}</NeonBadge>
          {fsb.tampered ? <NeonBadge tone="danger">TAMPERED</NeonBadge> : null}
          <NeonBadge tone="violet">واحد: مارجین ثابت ${fsb.unitUsd} = {fsb.unitPctOfBasis}٪ مبنا ${fsb.basisUsd}</NeonBadge>
          <span className="ms-auto text-[10px] text-zinc-500">امتیاز فقط: estPnl% خالص از فیس · واقعیت ستل‌شده</span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
          معیار سوددهی فقط <span className="font-bold text-zinc-200">EST PNL%</span> است — جمع درصدِ لوریج‌دارِ خالص-از-فیسِ نتایج واقعی ستل‌شده (مستقل از مارجین). تبدیل دلاری خطیِ دقیق: هر +۱٪ ≡ ${" "}
          {(fsb.unitUsd / 100).toFixed(2)} → هدف روزانه <span className="font-bold text-amber-300">+{fsb.targetDailyPct}% ≡ +${fsb.targetDailyUsd}</span>
        </p>

        {/* today + yesterday */}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <DayPanel label="امروز (تهران)" d={fsb.today} target={fsb.targetDailyPct} />
          <DayPanel label="دیروز (تهران)" d={fsb.yesterday} target={fsb.targetDailyPct} />
        </div>

        {/* 7d + all-time */}
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-white/5 bg-black/20 p-4">
            <div className="text-[11px] font-semibold text-zinc-300">۷ روز کامل اخیر</div>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
              <Cell k="estPnl%" v={pct(fsb.rolling7d.netPct)} tone={toneOf(fsb.rolling7d.netPct)} />
              <Cell k="دلار فلت-۱۰" v={usd(fsb.rolling7d.flat10Usd)} tone={toneOf(fsb.rolling7d.flat10Usd)} />
              <Cell k="روزِ هدف+" v={`${fsb.rolling7d.targetDays}/${fsb.rolling7d.days}`} tone={fsb.rolling7d.targetDays > 0 ? "text-amber-300" : undefined} />
              <Cell k="روز مثبت" v={`${fsb.rolling7d.positiveDays}/${fsb.rolling7d.days}`} />
              <Cell k="ستل" v={String(fsb.rolling7d.n)} />
            </div>
          </div>
          <div className="rounded-lg border border-white/5 bg-black/20 p-4">
            <div className="text-[11px] font-semibold text-zinc-300">کل تاریخچه ({fsb.allTime.days} روز کامل)</div>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Cell k="estPnl%" v={pct(fsb.allTime.netPct)} tone={toneOf(fsb.allTime.netPct)} />
              <Cell k="دلار فلت-۱۰" v={usd(fsb.allTime.flat10Usd)} tone={toneOf(fsb.allTime.flat10Usd)} />
              <Cell k="میانگین/روز" v={`${pct(fsb.allTime.meanDayPct)} · ${usd(fsb.allTime.meanDayUsd)}`} tone={toneOf(fsb.allTime.meanDayPct)} />
              <Cell k="بهترین روز" v={pct(fsb.allTime.bestDayPct)} tone="text-emerald-300" />
              <Cell k="بدترین روز" v={pct(fsb.allTime.worstDayPct)} tone="text-rose-300" />
              <Cell k="روزِ هدف+" v={`${fsb.allTime.targetDays}/${fsb.allTime.days}`} tone={fsb.allTime.targetDays > 0 ? "text-amber-300" : undefined} />
            </div>
          </div>
        </div>

        {/* bars */}
        <div className="mt-4 rounded-lg border border-white/5 bg-black/20 p-4">
          <BarStrip bars={fsb.bars} target={fsb.targetDailyPct} />
        </div>

        {/* fee mass + lanes at flat-10 */}
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-4">
            <div className="text-[11px] font-semibold text-amber-300">جرم فیس (دشمن شمارهٔ یک هدف +۱۰۰٪)</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
              میانگین <span className="font-bold text-amber-300">{fsb.feeMass.perTradeAvgPct}%</span> به‌ازای هر معامله · جرم ۷ روز اخیر{" "}
              <span className="font-bold text-amber-300">−{fsb.feeMass.trailing7dPct !== null ? Math.abs(fsb.feeMass.trailing7dPct) : "—"}%</span> — کتاب باید اول این را جبران کند؛ راهِ لبه: کاهش تعداد و کیفیت ورود، نه افزایش مارجین.
            </p>
          </div>
          <div className="rounded-lg border border-white/5 bg-black/20 p-4">
            <div className="text-[11px] font-semibold text-zinc-300">لِین‌های paper به واحد فلت-۱۰ (net × ۵ از $۲)</div>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {lane10(lanes).map((l) => (
                <Cell key={l.id} k={l.name} v={usd(l.net10)} tone={toneOf(l.net10)} />
              ))}
              {!lanes ? <div className="col-span-2 text-[11px] text-zinc-500">لِین‌ها در دسترس نیستند</div> : null}
            </div>
          </div>
        </div>

        {/* doctrine footer */}
        <p className="mt-3 border-t border-white/5 pt-2 text-[10px] leading-relaxed text-zinc-500">
          دکترین: قواعد بر مبنای ${fsb.basisUsd} سنجیده می‌شوند (مارجین واحد ${fsb.unitUsd} = {fsb.unitPctOfBasis}٪) · حساب فیزیکی $100 دست‌نخورده · ارتقا به لایو فقط با APPROVE اپراتور پس از تأیید پنجرهٔ paper ·
          قواعد پیش‌ثبت‌شده با SHA-256 در .data/flat-scoreboard-preregister.json — ژورنال بسته‌شدن روزها در .data/flat-scoreboard.jsonl
        </p>
      </div>
    </BentoCard>
  );
}
