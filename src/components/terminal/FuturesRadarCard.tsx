"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Radar } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/* ── FUTURES TAXONOMY // five-family signal engine card ──
 * Feed: /api/futures (30s poll — engine assembles store + learning).
 * Families: A positioning/funding+L-S ratios · B aggressor CVD · C forced
 * liquidation flow · D OI×Price four-quadrant (centerpiece grid) · E
 * cross-exchange funding/OI divergence. The edge store learns forward-return
 * statistics per family and names the BEST FILTER; honesty contract: null
 * sensors render as "—" (never faked), sampler warmups are labeled as such. */

/* ── payload DTOs (mirror of GET /api/futures) ── */

interface FuturesQuadrantMetaDTO {
  label: string;
  price: string;
  oi: string;
  meaning: string;
  signal: string;
}

interface FuturesQuadrantStudyDTO {
  quadrant: string;
  label: string;
  n: number;
  meanFwd1h: number;
  medianFwd1h: number;
  winPct: number;
  meanFwd4h: number;
  verdict: string;
}

interface FuturesFamilyStudyDTO {
  filter: string;
  family: string;
  rule: string;
  n: number;
  meanFwd1h: number;
  medianFwd1h: number;
  winPct: number;
  baselineMean: number;
  edge: number;
  thresholdNote: string;
  confidence: string;
}

interface FuturesAttributionCellDTO {
  direction: string;
  quadrant: string;
  n: number;
  avgPnl: number;
  medianPnl: number;
  winPct: number;
}

interface FuturesBestFilterDTO {
  filter: string;
  family: string;
  rule: string;
  edge: number;
  n: number;
  confidence: string;
  source: string;
}

interface FuturesAnchorDTO {
  symbol: string;
  ts: string;
  price: number;
  oiBase: number | null;
  oiUsdM: number | null;
  priceDelta15m: number | null;
  priceDelta1h: number | null;
  oiDelta15m: number | null;
  oiDelta1h: number | null;
  quadrant15m: string | null;
  quadrant1h: string | null;
  funding8h: number | null;
  crowdLS: number | null;
  topLS: number | null;
  cvd15mPct: number | null;
  cvd1hPct: number | null;
  liqLong10mUsd: number | null;
  liqShort10mUsd: number | null;
  liqUsd1h: number | null;
  fundingByb: number | null;
  oiByb: number | null;
  fundingOkx: number | null;
  oiOkx: number | null;
  crossSpreadBps8h: number | null;
}

interface FuturesServicesDTO {
  tape?: { reachable?: boolean; connected?: boolean; source?: string; symbols?: number; trades?: number; dataStalled?: boolean };
  liq?: { online?: boolean; connected?: boolean } | null;
}

interface FuturesEdgeDTO {
  builtAt: string;
  rowsScanned: number;
  settledRows: number;
  baselineMeanFwd1h: number;
  quadrantStudy: FuturesQuadrantStudyDTO[];
  familyStudy: FuturesFamilyStudyDTO[];
  attribution: { cells: FuturesAttributionCellDTO[]; joined: number; note: string };
  bestFilter: FuturesBestFilterDTO | null;
  maturity: { settled: number; target: number; progressPct: number };
}

interface FuturesPayloadDTO {
  at: string;
  anchors: FuturesAnchorDTO[];
  services?: FuturesServicesDTO;
  edge?: FuturesEdgeDTO | null;
  backfill?: { at: string; symbols?: string[]; rows?: number };
  counts?: { total: number; live: number; backfill: number; settled1h: number; last24h: number };
  quadrantMeta?: Record<string, FuturesQuadrantMetaDTO>;
}

/* ── grid geometry: rows = price, cols = OI ── */

const QUADRANT_ORDER = ["Q1_FRESH_LONG", "Q2_SQUEEZE", "Q3_FRESH_SHORT", "Q4_CAPITULATION"] as const;

/* ── defensive formatters: null/undefined/non-finite → "—" (never NaN) ── */

function num(v: number | null | undefined, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function pct(v: number | null | undefined, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(digits)}%` : "—";
}

function pctPlain(v: number | null | undefined, digits = 1): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}%` : "—";
}

function usdCompact(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? fmtUsd(v) : "—";
}

function bps(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v > 0 ? "+" : ""}${v} bps` : "—";
}

function signCls(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return "text-ink-3";
  return v > 0 ? "text-neon" : "text-danger-neon";
}

function confCls(c: string | undefined): string {
  if (c === "HIGH") return "border-[rgba(0,255,163,0.4)] text-neon";
  if (c === "MEDIUM") return "border-[rgba(255,179,71,0.4)] text-amber-neon";
  return "border-white/15 text-ink-3"; /* LOW / COLLECTING */
}

function shortIso(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)}Z` : "—";
}

/* ── tiny building blocks ── */

function FamilyBadge({ letter }: { letter: string }) {
  return (
    <span className="shrink-0 rounded border border-[rgba(178,107,255,0.35)] px-1 font-terminal text-[9px] font-bold leading-4 text-violet-neon">
      {letter}
    </span>
  );
}

function ShimmerBar({ className }: { className?: string }) {
  return (
    <div
      className={cn("rounded bg-white/[0.05]", className)}
      style={{
        backgroundImage: "linear-gradient(90deg, transparent, rgba(255,255,255,0.07), transparent)",
        backgroundSize: "200% 100%",
        animation: "shimmer 1.6s infinite",
      }}
    />
  );
}

function Skeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="loading futures taxonomy">
      <div aria-hidden className="grid grid-cols-[14px_1fr_1fr] gap-1">
        <div />
        <ShimmerBar className="h-4" />
        <ShimmerBar className="h-4" />
        <ShimmerBar className="h-12" />
        <ShimmerBar className="h-24" />
        <ShimmerBar className="h-24" />
        <ShimmerBar className="h-12" />
        <ShimmerBar className="h-24" />
        <ShimmerBar className="h-24" />
      </div>
      <div aria-hidden className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <ShimmerBar key={i} className="h-16" />
        ))}
      </div>
      <ShimmerBar className="h-24" />
    </div>
  );
}

function AxisHead({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden className="flex items-center justify-center font-terminal text-[9px] font-bold uppercase tracking-[0.14em] text-ink-3">
      {children}
    </div>
  );
}

function AxisRow({ children }: { children: string }) {
  return (
    <div aria-hidden className="flex items-center justify-center">
      <span className="font-terminal text-[8px] font-bold uppercase tracking-[0.2em] text-ink-3 [writing-mode:vertical-rl] rotate-180">
        {children}
      </span>
    </div>
  );
}

function QuadrantCell({
  id,
  meta,
  study,
  live,
  priceDelta1h,
  oiDelta1h,
}: {
  id: string;
  meta?: FuturesQuadrantMetaDTO;
  study?: FuturesQuadrantStudyDTO;
  live: boolean;
  priceDelta1h: number | null | undefined;
  oiDelta1h: number | null | undefined;
}) {
  const label = (meta?.label ?? study?.label ?? id.replace(/^[^_]+_/, "")).toUpperCase();
  return (
    <div
      title={`${id.replace(/_/g, " ")}${meta?.meaning ? ` — ${meta.meaning}` : ""}${study ? ` · n ${study.n} · fwd1h ${pct(study.meanFwd1h)} · ${study.verdict}` : ""}`}
      className={cn(
        "min-w-0 rounded-lg border p-1.5",
        live ? "border-neon/60 bg-[rgb(var(--neon-rgb)/0.05)]" : "border-white/8 bg-white/[0.02]"
      )}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 truncate font-terminal text-[10px] font-bold text-ink">
          {id.slice(0, 2)} · {label}
        </span>
        {live && (
          <span className="ml-auto shrink-0 rounded border border-[rgba(0,255,163,0.5)] px-1 font-terminal text-[8px] font-bold leading-4 text-neon">
            LIVE
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate font-terminal text-[9px] leading-snug text-ink-3" title={meta?.meaning}>
        {meta?.meaning ?? "—"}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-terminal text-[9px] tabular-nums">
        <span className="text-ink-2">n {study ? study.n : "—"}</span>
        <span className={cn("font-bold", study ? signCls(study.meanFwd1h) : "text-ink-3")}>{pct(study?.meanFwd1h)}</span>
        {study && (
          <span
            className={cn(
              "ml-auto rounded border px-1 text-[8px] font-bold leading-4",
              study.verdict === "CONTINUES" ? "border-[rgba(0,255,163,0.4)] text-neon" : "border-[rgba(255,179,71,0.4)] text-amber-neon"
            )}
          >
            {study.verdict}
          </span>
        )}
      </div>
      {live && (typeof priceDelta1h === "number" || typeof oiDelta1h === "number") && (
        <div className="mt-0.5 font-terminal text-[8px] tabular-nums text-ink-2">
          Δ1h P {pct(priceDelta1h)} · OI {pct(oiDelta1h)}
        </div>
      )}
    </div>
  );
}

function FamilyPanel({
  letter,
  title,
  rows,
  dim,
  dimTip,
}: {
  letter: string;
  title: string;
  rows: ReadonlyArray<{ k: string; v: string; cls?: string }>;
  dim: boolean;
  dimTip?: string;
}) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-white/8 bg-white/[0.02] p-2", dim && "opacity-50")} title={dim ? dimTip : undefined}>
      <div className="mb-1 flex items-center gap-1.5">
        <FamilyBadge letter={letter} />
        <span className="min-w-0 truncate font-terminal text-[9px] font-bold uppercase tracking-[0.14em] text-ink-2">{title}</span>
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.k} className="flex items-baseline justify-between gap-2 font-terminal text-[10px] tabular-nums">
            <span className="text-[9px] uppercase tracking-wider text-ink-3">{r.k}</span>
            <span className={cn("shrink-0 font-bold", r.cls ?? "text-ink")}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── card ── */

export default function FuturesRadarCard() {
  const [data, setData] = useState<FuturesPayloadDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/futures", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as FuturesPayloadDTO);
      setErr(null);
    } catch {
      setErr("feed unreachable — engine route or sampler down");
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = setInterval(pull, 30_000);
    return () => clearInterval(id);
  }, [pull]);

  const anchor = data?.anchors?.[0];
  const edge = data?.edge ?? null;

  const studyByQ = useMemo(() => new Map((edge?.quadrantStudy ?? []).map((s) => [s.quadrant, s])), [edge]);
  const leaders = useMemo(
    () => [...(edge?.familyStudy ?? [])].sort((a, b) => Math.abs(b.edge ?? 0) - Math.abs(a.edge ?? 0)).slice(0, 6),
    [edge]
  );
  const worstCells = useMemo(
    () => [...(edge?.attribution?.cells ?? [])].sort((a, b) => (a.avgPnl ?? 0) - (b.avgPnl ?? 0)).slice(0, 5),
    [edge]
  );

  const liveQ: string | null = anchor?.quadrant1h ?? null;
  const tapeUp = data?.services?.tape?.connected ?? false;
  const liqUp = data?.services?.liq?.online ?? false;
  const counts = data?.counts;

  return (
    <BentoCard>
      {/* ── header ── */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Radar className="h-4 w-4 text-violet-neon" aria-hidden />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-terminal text-[13px] font-bold uppercase tracking-[0.14em] text-foreground">FUTURES TAXONOMY</span>
              <LiveDot />
            </div>
            <div className="font-terminal text-[9px] tracking-[0.08em] text-ink-3">5-FAMILY STORE → LEARN → BEST FILTER</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {err && data && <span className="font-terminal text-[9px] text-amber-neon">last poll failed — retrying</span>}
          {edge?.maturity && (
            <NeonBadge
              tone={edge.maturity.progressPct >= 100 ? "neon" : "amber"}
              // Task 34-4 — honest breakdown: 672 of these rows came from the
              // one-shot 14-day hourly BACKFILL; the LIVE sampler adds ~2 rows
              // per 5min tick. The 720 bar is the settled-row maturity gate
              // for bestFilter claims (n≥20 + sign agreement still required).
              title={`settled forward-return rows ${edge.maturity.settled}/${edge.maturity.target} — backfill ${data?.counts?.backfill ?? "—"} + live ${data?.counts?.live ?? "—"} · spot-mirror keeps rows flowing during fapi bans`}
            >
              STORE {edge.maturity.settled}/{edge.maturity.target}
            </NeonBadge>
          )}
        </div>
      </div>

      {!data ? (
        err ? (
          /* fetch error — compact amber line + retry (honest, no fake data) */
          <div className="flex items-center justify-between gap-2 rounded-lg border border-[rgba(255,179,71,0.35)] bg-amber-neon/[0.06] px-2.5 py-2.5">
            <span className="min-w-0 truncate font-terminal text-[10px] text-amber-neon">FUTURES FEED ERROR — {err}</span>
            <button
              type="button"
              onClick={() => void pull()}
              className="shrink-0 rounded border border-amber-neon/50 px-2 py-0.5 font-terminal text-[9px] font-bold uppercase tracking-wider text-amber-neon transition hover:bg-amber-neon/10"
            >
              Retry
            </button>
          </div>
        ) : (
          <Skeleton />
        )
      ) : (
        <div className="space-y-3">
          {/* ── b) FAMILY D · OI×Price quadrant grid (centerpiece) ── */}
          <div>
            <div className="mb-1 flex items-center gap-1.5 px-0.5">
              <FamilyBadge letter="D" />
              <span className="min-w-0 font-terminal text-[9px] font-bold uppercase tracking-[0.14em] text-ink-2">
                OI × Price quadrant — fwd 1h stats
              </span>
              <span className="ml-auto shrink-0 font-terminal text-[9px] tabular-nums text-ink-3">{anchor?.symbol ?? "—"}</span>
            </div>
            <div className="grid grid-cols-[14px_1fr_1fr] gap-1">
              {/* header row: columns = OI */}
              <div aria-hidden />
              <AxisHead>OI ↑</AxisHead>
              <AxisHead>OI ↓</AxisHead>
              {/* row 1: price up */}
              <AxisRow>PRICE ↑</AxisRow>
              <QuadrantCell
                id={QUADRANT_ORDER[0]}
                meta={data.quadrantMeta?.[QUADRANT_ORDER[0]]}
                study={studyByQ.get(QUADRANT_ORDER[0])}
                live={liveQ === QUADRANT_ORDER[0]}
                priceDelta1h={anchor?.priceDelta1h}
                oiDelta1h={anchor?.oiDelta1h}
              />
              <QuadrantCell
                id={QUADRANT_ORDER[1]}
                meta={data.quadrantMeta?.[QUADRANT_ORDER[1]]}
                study={studyByQ.get(QUADRANT_ORDER[1])}
                live={liveQ === QUADRANT_ORDER[1]}
                priceDelta1h={anchor?.priceDelta1h}
                oiDelta1h={anchor?.oiDelta1h}
              />
              {/* row 2: price down */}
              <AxisRow>PRICE ↓</AxisRow>
              <QuadrantCell
                id={QUADRANT_ORDER[2]}
                meta={data.quadrantMeta?.[QUADRANT_ORDER[2]]}
                study={studyByQ.get(QUADRANT_ORDER[2])}
                live={liveQ === QUADRANT_ORDER[2]}
                priceDelta1h={anchor?.priceDelta1h}
                oiDelta1h={anchor?.oiDelta1h}
              />
              <QuadrantCell
                id={QUADRANT_ORDER[3]}
                meta={data.quadrantMeta?.[QUADRANT_ORDER[3]]}
                study={studyByQ.get(QUADRANT_ORDER[3])}
                live={liveQ === QUADRANT_ORDER[3]}
                priceDelta1h={anchor?.priceDelta1h}
                oiDelta1h={anchor?.oiDelta1h}
              />
            </div>
            {!liveQ && (
              <p className="mt-1.5 px-1 font-terminal text-[9px] text-ink-3">
                <span className="text-amber-neon">WARMING</span> — sampler self-heals after Binance IP-ban backoff
              </p>
            )}
          </div>

          {/* ── c) family chips A / B / C / E ── */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <FamilyPanel
              letter="A"
              title="Positioning"
              rows={[
                { k: "FUND 8H", v: pct(anchor?.funding8h, 4), cls: signCls(anchor?.funding8h) },
                { k: "CROWD L/S", v: num(anchor?.crowdLS, 2) },
                { k: "TOP L/S", v: num(anchor?.topLS, 2) },
              ]}
              dim={false}
            />
            <FamilyPanel
              letter="B"
              title="Aggressor CVD"
              rows={[
                { k: "CVD 15M", v: pct(anchor?.cvd15mPct, 1), cls: signCls(anchor?.cvd15mPct) },
                { k: "CVD 1H", v: pct(anchor?.cvd1hPct, 1), cls: signCls(anchor?.cvd1hPct) },
              ]}
              dim={anchor?.cvd15mPct == null && anchor?.cvd1hPct == null}
              dimTip="aggressor trade tape unavailable — honest gap, no synthetic values"
            />
            <FamilyPanel
              letter="C"
              title="Forced flow"
              rows={[
                { k: "LIQ L · 10M", v: usdCompact(anchor?.liqLong10mUsd) },
                { k: "LIQ S · 10M", v: usdCompact(anchor?.liqShort10mUsd) },
                { k: "LIQ 1H", v: usdCompact(anchor?.liqUsd1h) },
              ]}
              dim={anchor?.liqLong10mUsd == null && anchor?.liqShort10mUsd == null && anchor?.liqUsd1h == null}
              dimTip="liquidation feed unavailable — honest gap, no synthetic values"
            />
            <FamilyPanel
              letter="E"
              title="Cross-exchange"
              rows={[
                { k: "BIN FUND", v: pct(anchor?.funding8h, 4), cls: signCls(anchor?.funding8h) },
                { k: "BYB FUND", v: pct(anchor?.fundingByb, 4), cls: signCls(anchor?.fundingByb) },
                { k: "OKX FUND", v: pct(anchor?.fundingOkx, 4), cls: signCls(anchor?.fundingOkx) },
                { k: "SPREAD 8H", v: bps(anchor?.crossSpreadBps8h), cls: signCls(anchor?.crossSpreadBps8h) },
                ...(typeof anchor?.oiUsdM === "number" && Number.isFinite(anchor.oiUsdM)
                  ? [{ k: "OI USD", v: fmtUsd(anchor.oiUsdM * 1_000_000) }]
                  : []),
              ]}
              dim={false}
            />
          </div>

          {/* ── d) edge leaderboard ── */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1 px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
              <span>Edge leaderboard — fwd 1h vs baseline</span>
              <span className="normal-case tracking-normal tabular-nums">baseline {pct(edge?.baselineMeanFwd1h)}</span>
            </div>
            {leaders.length === 0 ? (
              <div className="px-1 py-3 text-center font-terminal text-[10px] text-ink-3">no settled evidence yet — filters collecting</div>
            ) : (
              <div className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
                {leaders.map((r) => (
                  <div
                    key={r.filter}
                    className="flex items-center gap-2 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]"
                    title={`${r.filter} — ${r.rule} · ${r.thresholdNote} · family ${r.family}`}
                  >
                    <span className="w-[110px] shrink-0 truncate font-bold text-ink">{r.filter}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-3">{r.rule}</span>
                    <span className="w-8 shrink-0 text-right text-ink-2">{r.n}</span>
                    <span className={cn("w-14 shrink-0 text-right font-bold", signCls(r.edge))}>{pct(r.edge)}</span>
                    <span className="w-10 shrink-0 text-right text-ink-2">{pctPlain(r.winPct)}</span>
                    <span className={cn("w-[64px] shrink-0 rounded border px-1 text-center text-[8px] font-bold leading-4", confCls(r.confidence))}>
                      {r.confidence}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── e) best filter banner ── */}
          {edge?.bestFilter ? (
            <div className="rounded-lg border border-violet-neon/30 bg-violet-neon/[0.05] px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-terminal text-[10px] tabular-nums">
                <NeonBadge tone="violet">Best filter [{edge.bestFilter.source}]</NeonBadge>
                <span className="font-bold text-ink">{edge.bestFilter.filter}</span>
                <span className="min-w-0 flex-1 truncate text-ink-3" title={edge.bestFilter.rule}>
                  {edge.bestFilter.rule}
                </span>
                <span className={cn("font-bold", signCls(edge.bestFilter.edge))}>{pct(edge.bestFilter.edge)}</span>
                <span className="text-ink-2">n {edge.bestFilter.n}</span>
                <span className={cn("rounded border px-1 text-[8px] font-bold leading-4", confCls(edge.bestFilter.confidence))}>
                  {edge.bestFilter.confidence}
                </span>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-white/10 px-2.5 py-2 font-terminal text-[10px] text-ink-3">
              BEST FILTER: COLLECTING — {edge?.maturity?.settled ?? 0}/{edge?.maturity?.target ?? 0} settled forward returns
            </div>
          )}

          {/* ── f) signal attribution (collapsible) ── */}
          <details className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1.5">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3 [&::-webkit-details-marker]:hidden">
              <span>Signal attribution — worst cohorts first</span>
              <span className="ml-auto normal-case tracking-normal tabular-nums">
                {edge?.attribution?.joined ?? 0} settled signals joined (±10m fence)
              </span>
            </summary>
            <div className="mt-1 space-y-0.5 border-t border-white/5 pt-1">
              {worstCells.length === 0 ? (
                <div className="px-1 py-2 font-terminal text-[10px] text-ink-3">no settled signals joined yet</div>
              ) : (
                worstCells.map((c) => (
                  <div
                    key={`${c.direction}-${c.quadrant}`}
                    className="flex items-center gap-2 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]"
                    title={`${c.direction} issued in ${c.quadrant.replace(/_/g, " ")} context — avg ${pct(c.avgPnl)} levered net · median ${pct(c.medianPnl)}`}
                  >
                    <span className={cn("w-12 shrink-0 font-bold", c.direction === "LONG" ? "text-neon" : "text-magenta-neon")}>
                      {c.direction}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-ink-2">{c.quadrant.replace(/_/g, " ")}</span>
                    <span className="w-8 shrink-0 text-right text-ink-2">{c.n}</span>
                    <span className={cn("w-16 shrink-0 text-right font-bold", signCls(c.avgPnl))}>{pct(c.avgPnl)}</span>
                    <span className="w-12 shrink-0 text-right text-ink-2">{pctPlain(c.winPct)}</span>
                  </div>
                ))
              )}
            </div>
          </details>

          {/* ── g) footer — data honesty ── */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-white/5 pt-2 font-terminal text-[9px] tabular-nums text-ink-3">
            <span>
              {counts?.total ?? 0} rows (backfill {counts?.backfill ?? 0}/{counts?.live ?? 0} live · settled1h {counts?.settled1h ?? 0} · 24h{" "}
              {counts?.last24h ?? 0})
            </span>
            <span aria-hidden>·</span>
            <span>
              TAPE <span className={tapeUp ? "text-neon" : "text-danger-neon"}>{tapeUp ? "UP" : "DOWN"}</span>
            </span>
            <span>
              LIQ <span className={liqUp ? "text-neon" : "text-danger-neon"}>{liqUp ? "UP" : "DOWN"}</span>
            </span>
            <span>backfill {shortIso(data.backfill?.at)}</span>
          </div>
        </div>
      )}
    </BentoCard>
  );
}
