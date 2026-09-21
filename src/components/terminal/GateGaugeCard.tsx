"use client";

import { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { GateGaugeDTO, GateSampleDTO, GateThrDTO } from "@/lib/api-types";

/* ── v8.2 GATE GAUGE // SIGNAL AUDIT card ──
 * Feed: /api/ai/gauge (8s poll — in-memory journal, cheap).
 * Shows LIVE which candidates sit on the confirm/reject boundary: the needle
 * is the candidate's |adjScore|, the white tick is its EFFECTIVE threshold
 * (dynamic MIN_SCORE + regime/spill/chase/MTF/liq-heat modifiers), the amber
 * zone is the boundary band (gap −8..0). The reason ledgers aggregate the
 * journal (6h window) and the CORE FEED panel mirrors what the central
 * deep-learn loop received and concluded from those reasons. */

const BOUNDARY_W = 8; // gap −8..0 = boundary band (mirrors gate-journal bandOf)

const THR_META: Array<{ key: keyof GateThrDTO; label: string }> = [
  { key: "regime", label: "REG" },
  { key: "spill", label: "SPILL" },
  { key: "chase", label: "CHASE" },
  { key: "mtf", label: "MTF" },
  { key: "liq", label: "LIQ" },
];

const BAND_CLS: Record<GateSampleDTO["band"], string> = {
  PASS: "text-neon",
  BOUNDARY: "text-amber-neon",
  REJECT: "text-danger-neon",
};

const BAND_LABEL: Record<GateSampleDTO["band"], string> = {
  PASS: "CONFIRM",
  BOUNDARY: "ON THE FENCE",
  REJECT: "REJECT",
};

const SRC_LABEL: Record<GateSampleDTO["source"], string> = {
  "auto-scan": "SCAN",
  trigger: "TRG",
  forced: "OP",
  shadow: "SHD",
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/* semicircle gauge geometry: 180°=left(0) → 0°=right(vmax) */
const CX = 92;
const CY = 86;
const R = 68;

function polar(r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY - r * Math.sin(rad)];
}

function arc(r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = Math.abs(a0 - a1) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

const valAng = (v: number, vmax: number) => 180 - Math.max(0, Math.min(1, v / vmax)) * 180;

function Gauge({ s }: { s: GateSampleDTO }) {
  const abs = Math.abs(s.score);
  const vmax = Math.max(s.effMin, abs) * 1.2 + 6;
  const bndStart = Math.max(0, s.effMin - BOUNDARY_W);
  const aBnd = valAng(bndStart, vmax);
  const aGate = valAng(s.effMin, vmax);
  const aScore = valAng(abs, vmax);
  const [nx, ny] = polar(R - 15, aScore);
  const [tx0, ty0] = polar(R - 7, aGate);
  const [tx1, ty1] = polar(R + 7, aGate);
  const passing = s.gap >= 0;

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 184 100" className="w-full max-w-[220px]" role="img" aria-label={`Gate gauge ${s.symbol} score ${abs.toFixed(1)} vs effective threshold ${s.effMin}`}>
        {/* zones */}
        {bndStart > 0.5 && <path d={arc(R, 180, aBnd)} fill="none" stroke="rgba(255,77,94,0.5)" strokeWidth="9" strokeLinecap="butt" />}
        {s.effMin > bndStart && <path d={arc(R, aBnd, aGate)} fill="none" stroke="rgba(255,179,71,0.75)" strokeWidth="9" strokeLinecap="butt" />}
        <path d={arc(R, aGate, 0)} fill="none" stroke="rgba(0,255,163,0.65)" strokeWidth="9" strokeLinecap="butt" />
        {/* gate tick */}
        <line x1={tx0} y1={ty0} x2={tx1} y2={ty1} stroke="white" strokeWidth="2" opacity="0.9" />
        {/* needle */}
        <line x1={CX} y1={CY} x2={nx} y2={ny} stroke={passing ? "#00ffa3" : s.band === "BOUNDARY" ? "#ffb347" : "#ff4d5e"} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx={CX} cy={CY} r="4.5" fill="#0a0f0d" stroke={passing ? "#00ffa3" : s.band === "BOUNDARY" ? "#ffb347" : "#ff4d5e"} strokeWidth="2" />
        {/* scale labels */}
        <text x="14" y="98" fontSize="7" fill="rgba(159,180,171,0.7)" fontFamily="monospace">0</text>
        <text x="158" y="98" fontSize="7" fill="rgba(159,180,171,0.7)" fontFamily="monospace">{vmax.toFixed(0)}</text>
      </svg>
      <div className="-mt-2 text-center">
        <div className="font-terminal text-[10px] uppercase tracking-[0.14em] text-ink-3">gap to gate</div>
        <div className={`font-terminal text-2xl font-bold tabular-nums ${BAND_CLS[s.band]}`}>
          {s.gap >= 0 ? "+" : ""}
          {s.gap.toFixed(1)}
        </div>
        <div className="mt-0.5 font-terminal text-[11px] font-bold">
          <span className={s.direction === "LONG" ? "text-neon" : "text-magenta-neon"}>{s.symbol.replace("USDT", "")} {s.direction}</span>
          <span className="ml-1.5 tabular-nums text-ink-2">
            |{abs.toFixed(1)}| vs eff {s.effMin}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-center gap-1.5 font-terminal text-[9px] uppercase tracking-wider">
          <span className={`${BAND_CLS[s.band]} font-bold`}>{BAND_LABEL[s.band]}</span>
          <span className="text-ink-3">· {SRC_LABEL[s.source]} · {ago(s.at)} ago</span>
        </div>
      </div>
    </div>
  );
}

function ThrChips({ thr }: { thr: GateThrDTO }) {
  const live = THR_META.filter((t) => thr[t.key] !== 0);
  if (live.length === 0) return <span className="text-ink-3">—</span>;
  return (
    <>
      {live.map((t) => (
        <span
          key={t.key}
          title={`${t.label} threshold modifier ${thr[t.key] > 0 ? "+" : ""}${thr[t.key]} (${thr[t.key] > 0 ? "raises the gate — reject pressure" : "discount — confirm pressure"})`}
          className={`rounded border px-0.5 font-bold leading-4 ${thr[t.key] > 0 ? "border-[rgba(255,179,71,0.4)] text-amber-neon" : "border-[rgba(69,240,223,0.4)] text-cyan-neon"}`}
        >
          {t.label}
          {thr[t.key]! > 0 ? "+" : ""}
          {thr[t.key]}
        </span>
      ))}
    </>
  );
}

function RosterRow({ s }: { s: GateSampleDTO }) {
  const conf = s.confirms[0];
  const opp = s.opposes[0];
  return (
    <div className="grid grid-cols-[64px_46px_50px_1fr_1fr_92px] items-center gap-1 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]" title={s.notes ?? undefined}>
      <span className="truncate font-bold text-ink">{s.symbol.replace("USDT", "")}</span>
      <span className={`font-bold ${s.direction === "LONG" ? "text-neon" : "text-magenta-neon"}`}>{s.direction === "LONG" ? "LNG" : "SHT"}</span>
      <span className="text-ink-2">
        {Math.abs(s.score).toFixed(1)}/{s.effMin}
      </span>
      <span className="truncate text-[9px] text-neon" title={conf ? `${conf.factor} ${conf.vote >= 0 ? "+" : ""}${conf.vote} — ${conf.detail ?? ""}` : undefined}>
        {conf ? `+ ${conf.factor.toLowerCase()} ${conf.vote}` : ""}
      </span>
      <span className="truncate text-[9px] text-danger-neon" title={opp ? `${opp.factor} ${opp.vote} — ${opp.detail ?? ""}` : undefined}>
        {opp ? `− ${opp.factor.toLowerCase()} ${opp.vote}` : ""}
      </span>
      <span className="flex justify-end gap-0.5">
        <ThrChips thr={s.thr} />
      </span>
    </div>
  );
}

export default function GateGaugeCard() {
  const [data, setData] = useState<GateGaugeDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch("/api/ai/gauge", { cache: "no-store" });
        if (res.ok) {
          const d = (await res.json()) as GateGaugeDTO;
          if (alive) setData(d);
        }
      } catch {
        /* next tick retries */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void pull();
    const id = setInterval(pull, 8_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const top = data?.live[0] ?? null;
  const roster = data?.live.slice(0, 8) ?? [];
  const stats = data?.stats ?? null;
  const lesson = data?.core.lessons[0] ?? null;
  const bnd = stats?.boundary ?? null;

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Scale className="h-4 w-4 text-neon" aria-hidden />
          <span className="label-tech">Gate gauge // signal audit — confirm/reject boundary</span>
          <LiveDot />
        </div>
        <NeonBadge tone="violet">v8.2 · JOURNAL → CORE</NeonBadge>
      </div>

      {!data ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-neon/25 font-terminal text-[10px] text-ink-3">
          {!loaded ? "connecting…" : "journal warming — first scan verdicts land within ~15s"}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
            {/* needle gauge — nearest-to-gate candidate */}
            <div>{top ? <Gauge s={top} /> : <div className="flex h-36 items-center justify-center font-terminal text-[10px] text-ink-3">no verdicts yet this session</div>}</div>

            {/* boundary roster */}
            <div className="min-w-0">
              <div className="mb-1 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
                <span>at the gate · nearest verdicts first</span>
                <span>
                  base MIN_SCORE {data.gate.minScore} + dynamic adj
                </span>
              </div>
              <div className="mb-1 grid grid-cols-[64px_46px_50px_1fr_1fr_92px] gap-1 px-1 font-terminal text-[9px] uppercase tracking-wider text-ink-3/70">
                <span>symbol</span>
                <span>dir</span>
                <span>scr/eff</span>
                <span>top confirm</span>
                <span>top oppose</span>
                <span className="text-right">thr mods</span>
              </div>
              {roster.length === 0 ? (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-neon/20 font-terminal text-[10px] text-ink-3">scan pass pending — roster fills on the next engine evaluation</div>
              ) : (
                <div className="max-h-[150px] space-y-0.5 overflow-y-auto pr-1">
                  {roster.map((s) => (
                    <RosterRow key={`${s.symbol}-${s.direction}`} s={s} />
                  ))}
                </div>
              )}
              <p className="mt-1 px-1 font-terminal text-[9px] text-ink-3">
                Bands: CONFIRM (gap ≥ 0) · <span className="text-amber-neon">ON THE FENCE (−8..0 — the boundary band)</span> · REJECT (&lt; −8). Thr mods: <span className="text-amber-neon">+ raises the gate</span> (regime/spill/chase/MTF-conflict/liq-heat), <span className="text-cyan-neon">− discounts it</span>.
              </p>
            </div>
          </div>

          {/* ledgers + core feed */}
          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
              <div className="mb-1.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-neon">confirm ledger · 6h</div>
              {(stats?.confirmReasons.length ?? 0) === 0 ? (
                <div className="py-3 text-center font-terminal text-[10px] text-ink-3">no confirming votes journaled yet</div>
              ) : (
                <div className="space-y-1">
                  {stats!.confirmReasons.slice(0, 4).map((r) => (
                    <div key={r.factor} className="flex items-center gap-1.5 font-terminal text-[10px]">
                      <span className="w-[118px] truncate text-ink-2" title={r.lastDetail ?? r.factor}>
                        {r.factor.toLowerCase()}
                      </span>
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
                        <div className="h-full rounded-full bg-neon opacity-80" style={{ width: `${Math.min(100, Math.abs(r.avgVote) * 45)}%` }} />
                      </div>
                      <span className="w-14 text-right tabular-nums text-ink-3">
                        ×{r.count} {r.avgVote >= 0 ? "+" : ""}
                        {r.avgVote}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
              <div className="mb-1.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-danger-neon">reject ledger · 6h</div>
              <div className="space-y-1">
                {(stats?.opposeReasons.length ?? 0) === 0 && (stats?.blocks.length ?? 0) === 0 ? (
                  <div className="py-3 text-center font-terminal text-[10px] text-ink-3">nothing rejected this window</div>
                ) : (
                  <>
                    {stats!.opposeReasons.slice(0, 3).map((r) => (
                      <div key={r.factor} className="flex items-center justify-between font-terminal text-[10px]">
                        <span className="truncate text-ink-2" title={r.lastDetail ?? r.factor}>
                          ✕ {r.factor.toLowerCase()}
                        </span>
                        <span className="tabular-nums text-ink-3">
                          ×{r.count} avg {r.avgVote}
                        </span>
                      </div>
                    ))}
                    {stats!.blocks.slice(0, 3).map((b) => (
                      <div key={b.gate} className="flex items-center justify-between font-terminal text-[10px]" title={b.lastReason}>
                        <span className="truncate font-bold text-amber-neon">▣ {b.gate.toLowerCase()}</span>
                        <span className="tabular-nums text-ink-3">×{b.count}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-violet-neon/25 bg-violet-neon/[0.04] p-2">
              <div className="mb-1.5 flex items-center justify-between font-terminal text-[9px] uppercase tracking-[0.14em] text-violet-neon">
                <span>core feed · deep-learn</span>
                <span>{data.core.runs} runs</span>
              </div>
              {lesson ? (
                <div className="space-y-1 font-terminal text-[10px] leading-relaxed">
                  <div className="text-ink" title={lesson.pattern}>
                    {lesson.pattern.slice(0, 110)}
                    {lesson.pattern.length > 110 ? "…" : ""}
                  </div>
                  <div className="text-ink-2" title={lesson.action}>
                    → {lesson.action.slice(0, 110)}
                    {lesson.action.length > 110 ? "…" : ""}
                  </div>
                  <div className="text-[9px] text-ink-3">
                    {lesson.label} · conf {lesson.confidence}% · {ago(new Date(lesson.at).getTime())} ago
                  </div>
                </div>
              ) : (
                <div className="py-3 text-center font-terminal text-[10px] text-ink-3">journal streams to the core on the next deep-learn cycle (~30min cadence)</div>
              )}
            </div>
          </div>

          {/* footer stats */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-terminal text-[9px] tabular-nums text-ink-3">
            <span>
              window {stats!.windowHours}h · <span className="text-ink-2">{stats!.samples}</span> verdicts
            </span>
            <span className="text-neon">CONFIRM {stats!.byBand.PASS}</span>
            <span className="text-amber-neon">
              FENCE {stats!.byBand.BOUNDARY}
              {bnd ? ` (${bnd.sharePct}% · avg gap ${bnd.avgGap})` : ""}
            </span>
            <span className="text-danger-neon">REJECT {stats!.byBand.REJECT}</span>
            <span>
              deploys <span className="text-ink-2">{stats!.deploys}</span>
              {stats!.avgDeployScore !== null ? ` (avg |score| ${stats!.avgDeployScore})` : ""}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <span>
                journal {data.health.samples} rec · {data.health.fileKB}KB → .data/gate-journal.jsonl
              </span>
              <span
                className={data.health.hydratedAt > 0 ? "text-neon" : "text-amber-neon"}
                title={data.health.hydratedAt > 0 ? `rings hydrated from the on-disk journal at ${new Date(data.health.hydratedAt).toISOString().slice(11, 19)} UTC (v8.2.1 split-brain fix: read-path hydration + tail refresh)` : "rings COLD — module instance has never hydrated; if this persists the journal file is missing"}
              >
                {data.health.hydratedAt > 0 ? `hydrated ${new Date(data.health.hydratedAt).toISOString().slice(11, 19)}Z` : "rings COLD"}
              </span>
            </span>
          </div>
        </div>
      )}
    </BentoCard>
  );
}
