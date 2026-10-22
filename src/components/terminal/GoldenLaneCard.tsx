"use client";

// ── Task 79 GOLDEN-LANE CARD (operator mandate 2026-10-05) ─────────────────
// The pre-registered paper evaluation of the Task-78 Golden Formula v1.0 and
// the R6-EDGE challenger, rendered live from /api/golden-lane. Doctrine path:
// 7d PAPER → (operator APPROVE) → live $2 → day-30 re-run. Kill-switches and
// rails are shown at all times — the operator must see the safety rails as
// prominently as the numbers.

import { useCallback, useEffect, useState } from "react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { GoldenLaneBlockDTO, LaneStatusDTO } from "@/lib/api-types";

const PHASE_STYLE: Record<LaneStatusDTO["phase"], { chip: string; label: string }> = {
  PAPER: { chip: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "PAPER" },
  "PROMOTE-CANDIDATE": { chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "PROMOTE ✓" },
  EXTEND: { chip: "bg-sky-500/15 text-sky-300 border-sky-500/30", label: "EXTEND" },
  ABSTAIN: { chip: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30", label: "ABSTAIN" },
  KILLED: { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "KILLED" },
};

function usd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(digits)}`;
}

function LanePanel({ lane, margin }: { lane: LaneStatusDTO; margin: number }) {
  const ph = PHASE_STYLE[lane.phase];
  const killKeys = Object.entries(lane.kills)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <div className="rounded-lg border border-white/5 bg-black/20 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-zinc-100">{lane.name}</span>
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${ph.chip}`}>{ph.label}</span>
        {killKeys.map((k) => (
          <span key={k} className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-bold text-rose-300">
            {k} TRIPPED
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{lane.detail}</p>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
        {[
          { k: "match", v: String(lane.matched), tone: "" },
          { k: "settled", v: String(lane.settled), tone: "" },
          { k: "open", v: String(lane.open), tone: "" },
          { k: "wr", v: lane.winRatePct !== null ? `${lane.winRatePct}%` : "—", tone: "" },
          { k: `net @ $${margin}`, v: usd(lane.net2), tone: lane.net2 > 0 ? "text-emerald-300" : lane.net2 < 0 ? "text-rose-300" : "text-zinc-100" },
          { k: "avg/trade", v: usd(lane.avgNet2, 3), tone: lane.avgNet2 !== null && lane.avgNet2 > 0 ? "text-emerald-300" : lane.avgNet2 !== null && lane.avgNet2 < 0 ? "text-rose-300" : "text-zinc-100" },
        ].map((x) => (
          <div key={x.k} className="rounded bg-white/[0.03] px-1 py-1.5">
            <div className={`text-[13px] font-bold ${x.tone || "text-zinc-100"}`}>{x.v}</div>
            <div className="text-[9px] uppercase tracking-wide text-zinc-500">{x.k}</div>
          </div>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
        <span>
          rails: day <b className={lane.dailyStopBreached ? "text-rose-300" : "text-zinc-300"}>{usd(lane.todayNet2)}</b> / stop −$5
          {lane.dailyStopBreached ? " ⚠" : ""}
        </span>
        <span>
          week <b className={lane.weeklyStopBreached ? "text-rose-300" : "text-zinc-300"}>{usd(lane.weekNet2)}</b> / stop −$10
          {lane.weeklyStopBreached ? " ⚠" : ""}
        </span>
        <span>
          best/worst day {usd(lane.bestDay)} / {usd(lane.worstDay)}
        </span>
        <span>K1..K4 {killKeys.length ? killKeys.join("·") : "armed"}</span>
      </div>

      {lane.recent.length > 0 && (
        <div className="mt-2 max-h-28 overflow-y-auto rounded bg-black/30 p-1.5 [scrollbar-width:thin]">
          {lane.recent.map((m) => (
            <div key={`${m.lane}:${m.signalId}`} className="flex items-center justify-between gap-2 px-1 py-0.5 text-[10px]">
              <span className="truncate text-zinc-400">
                NX-{String(m.serial).padStart(4, "0")} · {m.symbol} {m.direction === "LONG" ? "▲" : "▼"} · {m.strategy} · h{m.tehranHour} · tp1 {m.tp1DistPct.toFixed(2)}%
              </span>
              <span className={`shrink-0 font-mono font-bold ${m.net2 === null ? "text-zinc-500" : m.net2 >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {m.status} {usd(m.net2, 3)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function GoldenLaneCard() {
  const [data, setData] = useState<GoldenLaneBlockDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/golden-lane", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as GoldenLaneBlockDTO);
        setErr(null);
      } else {
        setErr(`HTTP ${res.status}`);
      }
    } catch {
      setErr("network");
    }
  }, []);
  useEffect(() => {
    // deferred first pull — keeps the effect body free of synchronous setState
    const first = setTimeout(() => void pull(), 0);
    const id = setInterval(() => void pull(), 15_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [pull]);

  return (
    <BentoCard className="lg:col-span-12">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="label-tech">Golden lane // فرمول طلایی v1.0 — لِین Paper پیش‌ثبت‌شده</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-2">
          {err && <span className="font-terminal text-[9px] text-rose-300">{err}</span>}
          {data?.lanes.map((l) => (
            <NeonBadge key={l.id} tone={l.phase === "PROMOTE-CANDIDATE" ? "violet" : l.phase === "KILLED" ? "magenta" : l.phase === "PAPER" ? "amber" : "muted"}>
              {l.id.toUpperCase()} · {l.phase}
            </NeonBadge>
          ))}
        </div>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-zinc-400">
        {data
          ? `پنجرهٔ ۷روزه از ${new Date(data.windowStart).toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" })} · مارجین $${data.marginUsd} · ریل‌ها: روزانه −$${Math.abs(data.dailyStop)} / هفتگی −$${Math.abs(data.weeklyStop)} · مسیر دکترین: paper ← تایید اپراتور ← live $2 ← re-run روز ۳۰`
          : "در حال اتصال به لِین…"}
      </p>

      {data?.tampered && (
        <div className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">⚠ TAMPER flag — فایل پیش‌ثبت با کانفیگ فعلی نخواند؛ پیکربندی بازرسی شود</div>
      )}
      {data?.lastError && <div className="mb-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">sync error: {data.lastError}</div>}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {data?.lanes.map((lane) => (
          <LanePanel key={lane.id} lane={lane} margin={data.marginUsd} />
        ))}
        {!data && <div className="bento h-40 animate-pulse xl:col-span-2" />}
      </div>
    </BentoCard>
  );
}
