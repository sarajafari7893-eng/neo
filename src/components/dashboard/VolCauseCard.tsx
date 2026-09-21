"use client";

/* ── VOL-CAUSE · TOP-VOLATILITY FORENSICS (AI CORE surface) ──
   Operator request 2026-09-07: «با تحقیق و جستجوی عمیق دلایل شکل گیری
   Top volatility در MARKET MATRIX رو یاد بگیر و در سیستم برای ردیابی و
   یادگیری و استفاده پیاده کن» — then relocated per «VOL-CAUSE FORENSICS
   رو هم به صفحه AI CORE ببر». Every time a symbol enters the top-|Δ24h|
   board, the engine snapshots the measured state and attributes causes
   (whale push, liquidation cascade, funding squeeze, OI surge/unwind,
   crowd flush, VOL-ONSET, thin tape, session) with transparent rule
   weights. Events settle with REAL 2h/6h forward returns; a learning
   loop aggregates per-cause expectancy into volcause.study; the engine
   consumes learned continuation profiles at deploy (gated n ≥ 30 ·
   cont ≥ 55% · |fwd6h| ≥ 0.12%) — telemetry-only until then. */

import { useEffect, useState } from "react";
import { FlaskConical, Microscope } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { VolCauseBoardDTO } from "@/lib/volCause";
import { fmtPrice, timeAgo } from "@/lib/format";
import { useMounted, useNow } from "@/hooks/usePulse";
import { cn } from "@/lib/utils";

type Board = VolCauseBoardDTO;

const CAUSE_TONE: Record<string, "neon" | "danger" | "amber" | "violet" | "magenta" | "muted"> = {
  "WHALE-PUSH": "neon",
  "LIQ-CASCADE": "danger",
  "FUNDING-SQUEEZE": "amber",
  "OI-SURGE": "neon",
  UNWIND: "violet",
  "CROWD-FLUSH": "magenta",
  "VOL-ONSET": "amber",
  "THIN-TAPE": "muted",
  "SESSION-THIN": "muted",
  "MOMENTUM-CARRY": "muted",
  MIXED: "muted",
};

const fmtPct = (v: number | null, d = 1) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const fmtK = (v: number | null) => (v === null ? "—" : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1e3)}k`);

function useVolCause(intervalMs = 60_000): Board | null {
  const [data, setData] = useState<Board | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/vol-cause", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as Board;
        if (alive) setData(j);
      } catch {
        /* keep last-good — telemetry never breaks the page */
      }
    };
    void load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [intervalMs]);
  return data;
}

export default function VolCauseCard() {
  const board = useVolCause();
  const mounted = useMounted();
  const now = useNow(30_000);

  return (
    <BentoCard tone="violet" corners className="mt-4">
      <div aria-hidden className="grid-bg-fine pointer-events-none absolute inset-0 rounded-[inherit] opacity-20 [mask-image:radial-gradient(circle_at_15%_0%,black_10%,transparent_70%)]" />
      <div className="relative">
        {/* header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Microscope size={13} className="text-violet-neon" aria-hidden />
            <span className="label-tech">VOL-CAUSE FORENSICS</span>
            <NeonBadge tone="violet" className="px-2 py-0.5 text-[10px]">
              WHY did top volatility form
            </NeonBadge>
            <LiveDot tone="violet" />
          </div>
          <div className="flex items-center gap-2">
            {board && (
              <span className="label-tech hidden text-[10px] text-ink-3 sm:inline">
                {board.totals.total} captured · {board.totals.unsettled} settling · study n={board.study?.settled ?? 0}
              </span>
            )}
          </div>
        </div>

        {/* events table */}
        {!board || board.events.length === 0 ? (
          <div className="label-tech mt-3 rounded-lg border border-dashed border-violet-neon/25 p-4 text-center text-[11px] text-ink-3">
            {board ? "NO TOP-VOLATILITY ENTRY YET — CAPTURE ARMS WHEN |Δ24h| ≥ 3.5% ENTERS THE TOP-4" : "ARMING FORENSIC CAPTURE…"}
          </div>
        ) : (
          <ul className="mt-2 max-h-96 divide-y divide-white/5 overflow-y-auto">
            {board.events.slice(0, 10).map((e) => (
              <li key={e.id} className="px-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("font-terminal text-[11px] font-bold", e.direction === "UP" ? "text-neon" : "text-danger-neon")}>
                    {e.direction === "UP" ? "▲" : "▼"} {e.symbol}
                  </span>
                  <NeonBadge tone={CAUSE_TONE[e.primaryCause] ?? "muted"} className="px-2 py-0.5 text-[9px]">
                    {e.primaryCause}
                  </NeonBadge>
                  <span className="font-terminal text-[10px] tabular-nums text-ink-3" title="|Δ24h| at capture">
                    |Δ24h| {fmtPct(Math.abs(e.change24h))}
                  </span>
                  <span className="hidden font-terminal text-[10px] tabular-nums text-ink-3 sm:inline" title="price at capture">
                    @ ${fmtPrice(e.price)}
                  </span>
                  <span className="hidden font-terminal text-[10px] tabular-nums text-ink-3 md:inline" title="session at capture">
                    {e.session}
                  </span>
                  <span className="ml-auto font-terminal text-[10px] tabular-nums text-ink-3">
                    {mounted && now > 0 ? timeAgo(e.detectedAt, now) : "--"}
                    {e.settled ? "" : " · settling…"}
                  </span>
                </div>
                {/* factor chips + forward returns */}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-4 font-terminal text-[10px] tabular-nums text-ink-3">
                  <span title="open interest Δ 1h">OI Δ1h {fmtPct(e.oiDelta1h)}</span>
                  <span title="taker CVD % of vol">CVD {fmtPct(e.cvdPct)}</span>
                  <span title="retail crowd long/short">L/S {e.crowdLS?.toFixed(2) ?? "—"}</span>
                  <span title="funding 8h">FUND {e.funding8h !== null ? `${(e.funding8h * 100).toFixed(3)}%` : "—"}</span>
                  <span title="liquidations, hour-equivalent">LIQ {fmtK(e.liqUsd1h)}</span>
                  {e.onsetScore !== null && <span title="VOL-ONSET score at capture">ONSET {e.onsetScore}</span>}
                  <span className={cn("ml-auto font-bold", e.direction === "UP" ? (e.fwd6hPct ?? 0) >= 0 ? "text-neon" : "text-danger-neon" : (e.fwd6hPct ?? 0) <= 0 ? "text-neon" : "text-danger-neon")} title="settled 6h forward return from capture price">
                    fwd6h {fmtPct(e.fwd6hPct, 2)}
                  </span>
                  <span className="hidden tabular-nums sm:inline" title="settled 2h forward return">
                    2h {fmtPct(e.fwd2hPct, 2)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* learning loop — per-cause expectancy */}
        <div className="mt-3 rounded-lg border border-white/8 bg-white/[0.02] p-3">
          <div className="flex items-center gap-2">
            <FlaskConical size={12} className="text-violet-neon" aria-hidden />
            <span className="label-tech text-[10px]">LEARNING LOOP — per-cause forward-return expectancy (settled events)</span>
          </div>
          {board?.study && board.study.causes.length > 0 ? (
            <>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {board.study.causes.slice(0, 5).map((c) => (
                  <div key={c.cause} className="rounded-md border border-white/8 bg-white/[0.02] px-2.5 py-1.5" title={`${c.cause} — mean fwd6h ${fmtPct(c.meanFwd6h, 2)}, continuation ${c.continuationRatePct ?? "—"}%, gate ${c.learnedAllowed ? "PASSED" : "pending"}`}>
                    <div className="flex items-center justify-between gap-1">
                      <span className="label-tech truncate text-[9px] text-ink-3">{c.cause}</span>
                      <span className={cn("label-tech shrink-0 text-[8px]", c.learnedAllowed ? "text-neon" : "text-ink-3")}>{c.learnedAllowed ? "ACTIVE" : `n=${c.n}`}</span>
                    </div>
                    <div className={cn("font-terminal text-sm font-bold tabular-nums", (c.meanFwd6h ?? 0) >= 0 ? "text-neon" : "text-danger-neon")}>
                      {fmtPct(c.meanFwd6h, 2)}
                    </div>
                    <div className="label-tech text-[9px] text-ink-3">cont {c.continuationRatePct ?? "—"}%</div>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-ink-3">
                {board.study.verdict} — the deploy engine reads this table: a matching learned profile nudges conviction
                (+2..4) and sizing (×1.15); until the gate clears, causes ride along as vote-0 telemetry only.
              </p>
            </>
          ) : (
            <p className="label-tech mt-2 text-[10px] text-ink-3">
              {board ? "STUDY EMPTY — stats build as captured events settle with real 2h/6h returns" : "MEASURING…"}
            </p>
          )}
        </div>

        {/* rules footnote */}
        <p className="mt-2 text-[10px] leading-snug text-ink-3">
          {board?.rules.capture ?? ""} · {board?.rules.settle ?? ""} · learn gate: {board?.rules.learnGate ?? ""} — nothing invented:
          every attribution cites measured OI Δ / taker CVD / funding / liquidations / crowd / onset readings at capture time.
        </p>
      </div>
    </BentoCard>
  );
}
