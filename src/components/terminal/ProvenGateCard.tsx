"use client";

// ── Task 80/82 PROVEN-GATE CARD (operator mandates 2026-10-05) ───────────────
// Live visibility of the PROVEN entry gate on the real book: the two
// Reality-Check-surviving filters (Tehran hour mask + tp1≥1% floor) and the
// book-level circuit breakers. Task 82 / BR-2.1: daily/weekly stop rails are
// DISABLED by operator command — advisory only; K1 rolling-20 and the K2/K3/K4
// locks stay armed. The gate's own opportunity cost is journaled, never assumed.

import { useCallback, useEffect, useState } from "react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { ProvenGateBlockDTO } from "@/lib/api-types";

const STATE_STYLE: Record<ProvenGateBlockDTO["state"], { chip: string; label: string }> = {
  ARMED: { chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "ARMED" },
  "DAILY-STOP": { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "DAILY STOP" },
  "WEEKLY-STOP": { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "WEEKLY STOP" },
  "K1-PAUSE": { chip: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "K1 PAUSE" },
  "K2-LOCK": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K2 LOCK" },
  "K3-RUIN": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K3 RUIN" },
  "K4-INVALID": { chip: "bg-rose-600/20 text-rose-200 border-rose-600/40", label: "K4 INVALID" },
  OFF: { chip: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30", label: "OFF" },
};

function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(digits)}`;
}

export default function ProvenGateCard() {
  const [data, setData] = useState<ProvenGateBlockDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/pulse", { cache: "no-store" });
      if (res.ok) {
        const snap = (await res.json()) as { feed?: { provenGate?: ProvenGateBlockDTO | null } };
        setData(snap.feed?.provenGate ?? null);
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
  const railBreached = data ? data.state !== "ARMED" && data.state !== "OFF" : false;
  const railsOff = data ? !data.railsEnforced : false;

  return (
    <BentoCard className="lg:col-span-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="label-tech">Proven gate // دروازهٔ ورود اثبات‌شده</span>
          <LiveDot />
        </div>
        {st && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${st.chip}`}>{st.label}</span>}
      </div>

      {err && <div className="mb-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300">{err}</div>}

      <p className="mb-3 text-[11px] leading-relaxed text-zinc-400">
        {data
          ? `کتاب واقعی فقط از فیلترهای اثبات‌شده عبور می‌کند: ماسک ساعتی تهران {${data.hours.join("،")}} + کف فاصلهٔ TP1 ≥ ${data.tp1FloorPct}٪ — شواهد RC p=0.039 و اورلی OOS −$12.60←+$9.81`
          : "در حال اتصال به دروازه…"}
      </p>

      {data && (
        <>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { k: "pass today", v: String(data.today.pass), tone: "text-emerald-300" },
              { k: "veto hour", v: String(data.today.vetoHour), tone: "text-amber-300" },
              { k: "veto tp1<1%", v: String(data.today.vetoTp1), tone: "text-amber-300" },
              { k: "rail blocks", v: String(data.today.blockedByRail), tone: data.today.blockedByRail > 0 ? "text-rose-300" : "text-zinc-100" },
              { k: "bypass (cal)", v: String(data.today.bypass), tone: "text-zinc-400" },
              { k: "hour now", v: `h${data.book.currentHour}${data.book.hourInMask ? " ✓" : " ✗"}`, tone: data.book.hourInMask ? "text-emerald-300" : "text-rose-300" },
            ].map((x) => (
              <div key={x.k} className="rounded bg-white/[0.03] px-1 py-1.5">
                <div className={`text-[13px] font-bold ${x.tone}`}>{x.v}</div>
                <div className="text-[9px] uppercase tracking-wide text-zinc-500">{x.k}</div>
              </div>
            ))}
          </div>

          <div className="mt-2.5 space-y-1 text-[10px] text-zinc-500">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>
                مبنای 1000 — امروز <b className={(data.basis.todayNet ?? 0) < 0 ? "text-rose-300" : "text-emerald-300"}>{usd(data.basis.todayNet)}</b> / ریل {usd(data.dailyStop, 0)}
                {railsOff && <span className="text-violet-300/70"> · ادوایزری</span>}
              </span>
              <span>
                هفته <b className={(data.basis.weekNet ?? 0) < 0 ? "text-rose-300" : "text-emerald-300"}>{usd(data.basis.weekNet)}</b> / ریل {usd(data.weeklyStop, 0)}
                {railsOff && <span className="text-violet-300/70"> · ادوایزری</span>}
              </span>
              <span>
                rolling-20 <b className={(data.basis.rolling20Net ?? 0) <= data.k1RollingNet ? "text-rose-300" : "text-zinc-300"}>{usd(data.basis.rolling20Net)}</b> / K1 {usd(data.k1RollingNet, 0)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-zinc-600">
              <span>خام (ثابت $100) — امروز {usd(data.book.todayNet)} · هفته {usd(data.book.weekNet)}</span>
              <span>· مارجین مسیر ارتقا ${data.basis.marginPerTradeUsd}</span>
            </div>
          </div>

          {data.lastVeto && (
            <div className="mt-2 rounded border border-white/5 bg-black/30 px-2 py-1 text-[10px] text-zinc-400">
              آخرین وتو: <b className="text-zinc-200">{data.lastVeto.symbol}</b> · {data.lastVeto.code} · {data.lastVeto.detail}
              {data.lastVetoAt ? ` · ${new Date(data.lastVetoAt).toLocaleTimeString("fa-IR", { timeZone: "Asia/Tehran" })}` : ""}
            </div>
          )}

          {railsOff && (
            <div className="mt-2 rounded border border-violet-500/30 bg-violet-500/[0.06] px-2 py-1 text-[10px] text-violet-300">
              حد ضرر روزانه و هفتگی به فرمان اپراتور غیرفعال است (BR-2.1) — فقط تلمتری؛ K1 (rolling-20) و قفل‌های K2/K3/K4 مسلح‌اند.
            </div>
          )}

          {railBreached && (
            <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
              ⚠ مدارشکن فعال ({data.state}) — دیپلوی جدید متوقف است (تنها RAW-CAL و اپراتور عبور می‌کنند){data.state.startsWith("K") && data.state !== "K1-PAUSE" ? " · قفل نیازمند ریست اپراتور" : ""}
            </div>
          )}
          {!data.enabled && (
            <div className="mt-2 rounded border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 text-[10px] text-zinc-300">
              دروازه خاموش است (.data/proven-gate-off) — کتاب بدون فیلتر اثبات‌شده دیپلوی می‌کند
            </div>
          )}
        </>
      )}
      {!data && !err && <div className="bento h-28 animate-pulse" />}
      <div className="mt-2 flex items-center gap-2">
        <NeonBadge tone="muted">evidence: 78-3b/78-3c</NeonBadge>
        <NeonBadge tone={railBreached ? "magenta" : railsOff ? "violet" : "violet"}>{railBreached ? "BREAKER ENGAGED" : railsOff ? "RAILS OFF · مانیتور" : "RAILS ARMED"}</NeonBadge>
      </div>
    </BentoCard>
  );
}
