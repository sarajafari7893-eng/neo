"use client";

// ── Task 81/82 BANKROLL CARD (operator mandates 2026-10-05: «قوانین جدید
// بانکرول… بر اساس 1000» + «حد ضرر روزانه و هفتگی را غیر فعال کن و نیازی نیست») ────────────────────────
// Dual-basis display: SEED $100 (the physical tracked account — untouched) vs
// BASIS $1000 (every rule and every edge ratio). BR-2.1: the daily/weekly
// stop rails are DISABLED by operator command — shown as advisory telemetry
// (would-have-fired bars), while the K-suite (K1/K3/K4) stays armed.

import { useCallback, useEffect, useState } from "react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { BankrollBlockDTO } from "@/lib/api-types";

const STATE_STYLE: Record<BankrollBlockDTO["state"], { chip: string; label: string }> = {
  ARMED: { chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "ARMED" },
  "DAILY-STOP": { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "DAILY STOP" },
  "WEEKLY-STOP": { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "WEEKLY STOP" },
  "K1-PAUSE": { chip: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "K1 PAUSE" },
  "K2-LOCK": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K2 LOCK" },
  "K3-RUIN": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K3 RUIN" },
  "K4-INVALID": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K4 INVALID" },
};

function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(digits)}`;
}

function RailBar(props: { label: string; net: number | null; stop: number; usedPct: number | null; tone: string; advisory?: boolean }) {
  const used = props.usedPct ?? 0;
  // BR-2.1: with rails off, bars are advisory telemetry — neutral violet, no alarm tones
  const barColor = props.advisory ? "bg-violet-400/70" : used >= 100 ? "bg-rose-500" : used >= 70 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px]">
        <span className="text-zinc-400">
          {props.label}
          {props.advisory && <span className="mr-1 text-violet-300/70">· ادوایزری</span>}
        </span>
        <span className={props.tone}>
          <b>{usd(props.net)}</b> / ریل {usd(props.stop, 0)}
          {props.usedPct !== null ? ` · ${used}٪` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-white/[0.06]">
        <div className={`h-full ${barColor} transition-all duration-500`} style={{ width: `${Math.min(100, used)}%` }} />
      </div>
    </div>
  );
}

export default function BankrollCard() {
  const [data, setData] = useState<BankrollBlockDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/pulse", { cache: "no-store" });
      if (res.ok) {
        const snap = (await res.json()) as { feed?: { bankroll?: BankrollBlockDTO | null } };
        setData(snap.feed?.bankroll ?? null);
        setErr(null);
      } else {
        setErr(`HTTP ${res.status}`);
      }
    } catch {
      setErr("network");
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void pull(), 0);
    const id = setInterval(() => void pull(), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [pull]);

  const st = data ? STATE_STYLE[data.state] : null;
  const locked = data?.kSuite.locked ?? false;
  const tripped = data ? data.state !== "ARMED" : false;
  const railsOff = data ? !data.railsEnforced : false;

  return (
    <BentoCard className="lg:col-span-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="label-tech">Bankroll basis // بانکرول دومبنا (BR-2.1)</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-1.5">
          {railsOff && <span className="rounded border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-violet-300">ریل‌ها OFF (فرمان اپراتور)</span>}
          {st && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${st.chip}`}>{st.label}</span>}
        </div>
      </div>

      {err && <div className="mb-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300">{err}</div>}

      <p className="mb-2.5 text-[11px] leading-relaxed text-zinc-400">
        بالانس فیزیکی <b className="text-zinc-100">$100</b> دست‌نخورده می‌ماند — اما همهٔ قوانین بانکرولی و لبه‌ای بر مبنای{" "}
        <b className="text-zinc-100">$1000</b> سنجیده می‌شوند: سود/زیان تحقق‌یافتهٔ کتاب با باز-ارزش‌گذاری خطیِ دقیق به مارجین مبنای $20 (2٪) پروژه می‌شود. حد ضرر روزانه و هفتگی به فرمان اپراتور{" "}
        <b className="text-violet-300">غیرفعال</b> است — فقط تلمتری؛ K1/K3/K4 مسلح‌اند.
      </p>

      {data && (
        <>
          {/* dual balance row */}
          <div className="mb-2.5 grid grid-cols-2 gap-2 text-center">
            <div className="rounded bg-white/[0.03] px-2 py-2">
              <div className="text-[15px] font-bold text-zinc-100">${data.seed.balanceUsd}</div>
              <div className="text-[9px] uppercase tracking-wide text-zinc-500">SEED · حساب فیزیکی</div>
              <div className="mt-0.5 text-[9px] text-zinc-500">
                خام: امروز {usd(data.seed.todayNet)} · هفته {usd(data.seed.weekNet)}
              </div>
            </div>
            <div className="rounded border border-violet-500/20 bg-violet-500/[0.06] px-2 py-2">
              <div className="text-[15px] font-bold text-violet-200">${data.basis.bankrollUsd}</div>
              <div className="text-[9px] uppercase tracking-wide text-violet-300/70">BASIS · مبنای قوانین</div>
              <div className="mt-0.5 text-[9px] text-violet-300/60">
                مارجین قانون ${data.basis.marginPerTradeUsd} (2٪) · {data.settled.week} ستل هفته
              </div>
            </div>
          </div>

          {/* rails — BR-2.1: daily/weekly advisory-only, K1 still armed */}
          <div className="space-y-2">
            <RailBar advisory={railsOff} label="ریل روزانه (۵٪ مبنا)" net={data.basis.todayNet} stop={data.basis.dailyStop} usedPct={data.rails.dailyUsedPct} tone="text-zinc-300" />
            <RailBar advisory={railsOff} label="ریل هفتگی (۱۰٪ مبنا — هفتهٔ شنبه‌شروع)" net={data.basis.weekNet} stop={data.basis.weeklyStop} usedPct={data.rails.weeklyUsedPct} tone="text-zinc-300" />
            <RailBar label="K1 · rolling-20 (۶٪ مبنا)" net={data.basis.rolling20Net} stop={data.basis.k1Rolling} usedPct={data.rails.k1UsedPct} tone="text-zinc-300" />
          </div>

          {/* target vs edge */}
          <div className="mt-2.5 rounded border border-white/5 bg-black/30 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-400">
            هدف روزانه <b className="text-zinc-100">${data.basis.dailyTarget}</b> (۰٫۵٪ مبنا) در برابر لبهٔ تعفیف‌شدهٔ{" "}
            <b className="text-zinc-100">
              ${data.basis.deflatedEdgeLow}–${data.basis.deflatedEdgeHigh}/روز
            </b>{" "}
            → هدف = <b className="text-emerald-300">{data.target.targetVsEdgePct}٪ لبه</b> — در باند PLAUSIBLE؛ این جواب ریاضیِ «$5/روز روی 1000» است.
          </div>

          {/* K-suite */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[9px]">
            <NeonBadge tone={data.kSuite.k1Tripped ? "magenta" : "muted"}>K1 {data.kSuite.k1Tripped ? "TRIPPED" : "clear"}</NeonBadge>
            <NeonBadge tone={data.kSuite.k2Locked ? "magenta" : "muted"}>{railsOff ? "K2 خنثی (ریل خاموش)" : `K2 ${data.kSuite.k2Hits}/2 در ۳۰روز`}</NeonBadge>
            <NeonBadge tone={data.kSuite.k3Locked ? "magenta" : "muted"}>K3 {data.basis.last300Net === null ? "—" : usd(data.basis.last300Net, 0)}</NeonBadge>
            <NeonBadge tone={data.kSuite.k4Invalid ? "magenta" : "muted"}>K4 {data.kSuite.engineVersion ?? "—"}</NeonBadge>
          </div>

          {tripped && !locked && (
            <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
              ⚠ K1 (rolling-20 ≤ −$60 مبنایی) فعال — دیپلوی تا رول‌شدن روز تهران متوقف (تنها RAW-CAL و فرمان اپراتور عبور می‌کنند). ریل‌های روزانه/هفتگی به فرمان اپراتور غیرفعال‌اند؛ پوشش دُم بر عهدهٔ K1/K3/K4.
            </div>
          )}
          {locked && (
            <div className="mt-2 rounded border border-rose-600/40 bg-rose-600/10 px-2 py-1 text-[10px] text-rose-200">
              🔒 قفل K-سوئیت ({data.kSuite.lockCode}) — رفع قفل فقط با فرمان اپراتور (.data/bankroll-reset)
            </div>
          )}
          {data.weeklyBreachEvents.length > 0 && (
            <div className="mt-2 text-[9px] text-zinc-500">
              ژورنال برخورد هفتگی: {data.weeklyBreachEvents.length} رویداد (تلمتری — اجرا نمی‌شود) — آخرین هفتهٔ #{data.weeklyBreachEvents[data.weeklyBreachEvents.length - 1].weekIdx} با {usd(data.weeklyBreachEvents[data.weeklyBreachEvents.length - 1].weekNetBasis)}
            </div>
          )}
        </>
      )}
      {!data && !err && <div className="bento h-28 animate-pulse" />}
      <div className="mt-2 flex items-center gap-2">
        <NeonBadge tone="muted">rescale: خطیِ دقیق (pnl% نامتغیر)</NeonBadge>
        <NeonBadge tone={tripped ? "magenta" : "violet"}>{tripped ? "K1 ENGAGED" : railsOff ? "RAILS OFF · مانیتور" : "BASIS ARMED"}</NeonBadge>
      </div>
    </BentoCard>
  );
}
