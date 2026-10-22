"use client";

// ── FlowRadar Neo v6.2 — NET EST PNL LEDGER card ──────────────────────
// Operator request (persian): «محاسبه گر مجموع EST PNL خالص برای سیگنالهای
// منقضی شده، تی پی و استاپ با نمودار روزانه و هفتگی و ماهانه» + v6.1.1:
// «در هر میله بعد از other اصل سود یا ضرر رو نشون بده» + v6.2 mandate:
// «فرمول EST PNL % باید بر اساس نتیجه واقعی سیگنالها محاسبه شود»
// Two ledgers, one chart:
//   REAL $  — margin × engine NET % (fee/funding-aware), stacked by final
//             status, with the actual NET dollar result printed on every bar.
//   EST PNL % — the ACTUAL result of every signal (engine-recorded fee-NET,
//             levered pnlPercent), summed per bucket — NO idealized +50/−30
//             norms anymore (v6.2). Violet line (right axis) + sums.
//             Buckets are ASIA/TEHRAN local calendar units (+03:30).

import { useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AMBER, AXIS_LINE_STROKE, AXIS_TICK, DANGER, GRID_STROKE, MUTED_LINE, NEON, NexusTooltip, VIOLET, useNeon } from "./chart-theme";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AfterlifeStats, PnlLedger, PnlLedgerRow } from "@/lib/api-types";

type Range = "daily" | "weekly" | "monthly";

const RANGES: Array<{ id: Range; label: string }> = [
  { id: "daily", label: "DAILY" },
  { id: "weekly", label: "WEEKLY" },
  { id: "monthly", label: "MONTHLY" },
];

function signedUsd(v: number): string {
  return `${v > 0 ? "+" : ""}${fmtUsd(v)}`;
}

function signedPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** per-bar REAL NET $ label — the actual profit/loss printed above/below each bar */
function NetUsdLabel(props: { x?: number | string; y?: number | string; value?: number | string }) {
  const x = typeof props.x === "number" ? props.x : Number(props.x);
  const y = typeof props.y === "number" ? props.y : Number(props.y);
  const v = typeof props.value === "number" ? props.value : Number(props.value);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(v) || Math.abs(v) < 0.005) return null;
  const below = v < 0;
  return (
    <text
      x={x}
      y={below ? y + 14 : y - 6}
      textAnchor="middle"
      fill={below ? "rgb(255,138,148)" : "rgb(190,240,216)"}
      fontSize={8.5}
      fontWeight={700}
      fontFamily="var(--font-terminal)"
      stroke="rgba(5,7,10,0.85)"
      strokeWidth={2.5}
      paintOrder="stroke"
      style={{ pointerEvents: "none" }}
    >
      {signedUsd(Number(v.toFixed(2)))}
    </text>
  );
}

function KpiTile({ label, value, count, color, format = "usd" }: { label: string; value: number; count?: number; color: string; format?: "usd" | "pct" }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2 py-1.5">
      <div className="label-tech truncate text-[8px] tracking-[0.18em] text-ink-3">{label}</div>
      <div className="font-terminal text-[13px] font-bold tabular-nums leading-tight" style={{ color }}>
        {format === "pct" ? signedPct(value) : signedUsd(value)}
      </div>
      {count !== undefined && (
        <div className="font-terminal text-[8px] tracking-[0.1em] text-ink-3">
          {count} TRADE{count === 1 ? "" : "S"}
        </div>
      )}
    </div>
  );
}

export function NetPnlLedgerCard({ ledger, afterlife }: { ledger: PnlLedger; afterlife: AfterlifeStats }) {
  const accent = useNeon();
  const [range, setRange] = useState<Range>("daily");

  const rows: PnlLedgerRow[] = ledger[range];
  const totals = ledger.totals;
  const hasOther = totals.otherN > 0;

  const data = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        other: hasOther ? r.otherUsd : undefined,
      })),
    [rows, hasOther]
  );

  // window-scoped sums (the «مجموع این محاسبات» the operator asked to see on the chart)
  const winEst = useMemo(() => rows.reduce((a, r) => a + r.estPnlPct, 0), [rows]);
  const winUsd = useMemo(() => rows.reduce((a, r) => a + r.netUsd, 0), [rows]);

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="net-pnl-ledger">
      {/* range toggle + window sums */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1" role="tablist" aria-label="PNL ledger range">
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={cn(
                "rounded-md border px-2.5 py-1 font-terminal text-[9px] font-bold uppercase tracking-[0.18em] transition-all",
                range === r.id
                  ? "border-transparent text-[#05070a]"
                  : "border-white/10 bg-white/[0.03] text-ink-3 hover:border-white/20 hover:text-ink-2"
              )}
              style={range === r.id ? { background: accent, boxShadow: `0 0 12px ${accent}55` } : undefined}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="whitespace-nowrap font-terminal text-[9px] tracking-[0.1em] text-ink-3">
          WINDOW <span style={{ color: accent }}>{signedUsd(Number(winUsd.toFixed(2)))}</span>
          <span className="mx-1 text-ink-3">·</span>
          <span style={{ color: VIOLET }}>EST {signedPct(winEst)}</span>
          <span className="mx-1 text-ink-3">·</span>
          <span className="text-ink-3">TZ +03:30</span>
        </span>
      </div>

      {/* totals strip — REAL $ row + % row */}
      <div className="grid grid-cols-3 gap-1.5">
        <KpiTile label="TP LADDER" value={totals.tpUsd} count={totals.tpN} color={NEON} />
        <KpiTile label="STOPPED" value={totals.stopUsd} count={totals.stopN} color={DANGER} />
        <KpiTile label="EXPIRED" value={totals.expiredUsd} count={totals.expiredN} color={AMBER} />
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <KpiTile label="NET REAL $" value={totals.netUsd} color={accent} />
        <KpiTile label="EST PNL %" value={totals.estPnlPct} color={VIOLET} format="pct" />
        <KpiTile label="AVG %/TRADE" value={totals.avgPct} color="#9fb4ab" format="pct" />
      </div>

      {/* stacked REAL $ composition + EST % overlay */}
      {data.length === 0 ? (
        <div className="flex h-[230px] items-center justify-center font-terminal text-[10px] uppercase tracking-[0.22em] text-ink-3">
          NO SETTLED SIGNALS IN THIS WINDOW YET
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <ComposedChart data={data} margin={{ top: 14, right: 4, left: 0, bottom: 0 }} stackOffset="sign">
            <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: AXIS_LINE_STROKE }} tickMargin={8} minTickGap={10} />
            <YAxis yAxisId="usd" tick={AXIS_TICK} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtUsd(v)} />
            <YAxis
              yAxisId="pct"
              orientation="right"
              tick={{ ...AXIS_TICK, fill: "rgba(178,107,255,0.75)" }}
              tickLine={false}
              axisLine={false}
              width={40}
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}%`}
            />
            <Tooltip
              content={
                <NexusTooltip
                  prefix="$"
                  units={{ estPnlPct: "%", avgPct: "%" }}
                  prefixes={{ estPnlPct: "", avgPct: "" }}
                />
              }
              cursor={{ fill: "rgb(var(--neon-rgb)/0.05)" }}
            />
            <ReferenceLine yAxisId="usd" y={0} stroke={MUTED_LINE} />
            <Bar yAxisId="usd" dataKey="tpUsd" name="TP" stackId="pnl" fill={NEON} fillOpacity={0.85} radius={[2, 2, 0, 0]} maxBarSize={26} />
            <Bar yAxisId="usd" dataKey="stopUsd" name="STOP" stackId="pnl" fill={DANGER} fillOpacity={0.85} radius={[2, 2, 0, 0]} maxBarSize={26} />
            <Bar yAxisId="usd" dataKey="expiredUsd" name="EXPIRED" stackId="pnl" fill={AMBER} fillOpacity={0.85} radius={[2, 2, 0, 0]} maxBarSize={26} />
            {hasOther && <Bar yAxisId="usd" dataKey="otherUsd" name="OTHER" stackId="pnl" fill="#5c6f66" fillOpacity={0.8} radius={[2, 2, 0, 0]} maxBarSize={26} />}
            {/* EST PNL % — v6.2: the ACTUAL result of every signal in the bucket,
                summed (engine fee-NET levered %) — reality-based, no norms */}
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="estPnlPct"
              name="EST PNL %"
              stroke={VIOLET}
              strokeWidth={1.6}
              dot={{ r: 2, fill: VIOLET, strokeWidth: 0 }}
              activeDot={{ r: 3.5 }}
              isAnimationActive={false}
            />
            {/* AVG %/TRADE — hidden helper so the tooltip carries per-trade expectancy */}
            <Line
              yAxisId="pct"
              type="monotone"
              dataKey="avgPct"
              name="AVG %/TRADE"
              stroke="transparent"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
            {/* REAL NET $ printed on every bar — اصل سود یا ضرر */}
            <Line
              yAxisId="usd"
              type="linear"
              dataKey="netUsd"
              name="NET $"
              stroke="transparent"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
              label={<NetUsdLabel />}
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* legend + ledger definitions + afterlife post-mortem tie-in */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-terminal text-[9px] tracking-[0.12em] text-ink-3">
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: NEON }} /> TP LADDER</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: DANGER }} /> STOP</span>
          <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: AMBER }} /> EXPIRED @ TTL MARK</span>
          {hasOther && <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: "#5c6f66" }} /> OTHER</span>}
          <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-3" style={{ background: VIOLET }} /> EST PNL %</span>
        </div>
        <p className="font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-ink-3">
          BARS = REAL NET $ (MARGIN × ENGINE NET %, FEES + FUNDING DEDUCTED — PRINTED ON EVERY BAR) · EXPIRED SIGNALS DO HIT THE ACCOUNT BALANCE AT THE TTL MARK PRICE. VIOLET LINE = EST PNL % — v6.2: THE ACTUAL RESULT OF EVERY SIGNAL (ENGINE FEE-NET LEVERED %) SUMMED PER BUCKET — NO IDEALIZED NORMS. BUCKETS = ASIA/TEHRAN LOCAL DAYS/WEEKS/MONTHS (+03:30).
        </p>
        {totals.excludedN > 0 && (
          <p className="rounded-md border border-rose-400/20 bg-rose-400/[0.04] px-2 py-1.5 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-rose-300" data-testid="ledger-excluded">
            CLEAN LEDGER: {totals.excludedN} INTEGRITY-FLAGGED ROW{totals.excludedN === 1 ? "" : "S"} (VOID · PHANTOM-FEED) EXCLUDED FROM EVERY BUCKET — THE PAPER ACCOUNT KEEPS FULL HISTORY; THIS LEDGER STAYS CLEAN (v10.18 DOCTRINE).
          </p>
        )}
        <p className="rounded-md border border-cyan-400/20 bg-cyan-400/[0.04] px-2 py-1.5 font-terminal text-[9px] leading-relaxed tracking-[0.06em] text-[#45f0df]">
          EXPIRY POST-MORTEM: {afterlife.wouldHaveWonPct}% OF EXPIRED SIGNALS WOULD HAVE HIT TP WITHIN 48H AFTER TTL · AVG POST-EXPIRY MFE {afterlife.avgPostMfe >= 0 ? "+" : ""}
          {afterlife.avgPostMfe.toFixed(1)}% — DYNAMIC EXPIRY GATE: {totals.ttlExtended} EXTENSION{totals.ttlExtended === 1 ? "" : "S"} GRANTED →{" "}
          {totals.extCapturedUsd >= 0 ? "+" : ""}${totals.extCapturedUsd.toFixed(2)} CAPTURED
        </p>
      </div>
    </div>
  );
}
