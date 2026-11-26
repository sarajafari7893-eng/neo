"use client";

import { useCallback, useEffect, useState } from "react";
import { Crosshair, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";

/* ── v11.3 ENTRY-LEVERS // LATE-ENTRY SHIELD card ──
 * Feed: /api/entry-levers (30s poll — stats are a cached ledger recompute).
 * The evidence-gated answer to the systematic late-entry diagnosis: six
 * deterministic levers (extension ×ATR, crowded flow, chase causes, stale
 * radar detection, scalp valve, leverage cap) evaluated on EVERY deploy,
 * journaled, and promoted from shadow to enforce ONLY when their own
 * statistical gate passes (n≥100 · flagged avg ≤ −0.5 · separation ≥0.5).
 * Reading this card runs the promotion ladder — what you see is the live
 * authority. Operator override cycles the mode per lever (45s cooldown). */

interface LeverStatDTO {
  lever: string;
  flagN: number;
  flagWr: number;
  flagAvg: number;
  baseN: number;
  baseAvg: number;
  fires7d: number;
  gatePass: boolean;
  gateNote: string;
}

interface EntryLeversDTO {
  ts: number;
  modes: Record<string, string>;
  manual?: Record<string, boolean>;
  params: Record<string, number | string | string[]>;
  updatedAt: string;
  autoNotes: string[];
  stats: {
    windowDays: number;
    cohortN: number;
    cohortWr: number;
    cohortAvg: number;
    perLever: LeverStatDTO[];
  };
  journal: Array<Record<string, unknown>>;
  labels: Record<string, string>;
}

const LEVER_SHORT: Record<string, string> = { EXT: "EXTENSION", FLOW: "CROWD-FLOW", CAUSE: "CHASE-CAUSE", STALE: "STALE-FILL", SCALP: "SCALP-VALVE", LEVCAP: "LEV-CAP" };

const MODE_TONE: Record<string, string> = { shadow: "text-amber-neon", enforce: "text-magenta-neon", off: "text-ink-3" };
const MODE_ORDER = ["shadow", "enforce", "off"] as const;

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function avgCls(v: number): string {
  return v > 0.2 ? "text-neon" : v < -0.5 ? "text-danger-neon" : "text-amber-neon";
}

function LeverRow({ s, mode, pinned, target, onCycle, busy }: { s: LeverStatDTO; mode: string; pinned: boolean; target: number; onCycle: () => void; busy: boolean }) {
  const pct = Math.min(100, (s.flagN / target) * 100);
  return (
    <div className="px-1 py-1.5" title={s.gateNote}>
      <div className="flex items-center gap-1.5 font-terminal text-[10px]">
        <button
          onClick={onCycle}
          disabled={busy}
          className={`w-[92px] shrink-0 truncate text-left font-bold hover:underline ${MODE_TONE[mode] ?? "text-ink-3"} disabled:opacity-50`}
          title={`${LEVER_SHORT[s.lever]} — mode ${mode.toUpperCase()}${pinned ? " (operator-pinned)" : ""} (click to cycle shadow→enforce→off)`}
        >
          {LEVER_SHORT[s.lever] ?? s.lever}
          {pinned ? <span className="ml-1 text-[8px] text-cyan-neon">◈</span> : null}
        </button>
        <span className={`w-[62px] shrink-0 text-[9px] ${MODE_TONE[mode] ?? "text-ink-3"}`}>{mode.toUpperCase()}</span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
          <div className={`h-full rounded-full opacity-80 ${s.gatePass ? "bg-magenta-neon" : "bg-neon"}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-14 shrink-0 text-right tabular-nums text-ink-3" title={`flagged settled rows / gate target (${target})`}>
          {s.flagN}/{target}
        </span>
        <span className="w-10 shrink-0 text-right tabular-nums text-ink" title={`fires in last 7d`}>
          {s.fires7d}×7d
        </span>
        <span className="w-12 shrink-0 text-right tabular-nums text-ink-2" title="flagged cohort win rate">
          {s.flagN ? `${s.flagWr.toFixed(0)}%` : "—"}
        </span>
        <span className={`w-14 shrink-0 text-right tabular-nums ${s.flagN ? avgCls(s.flagAvg) : "text-ink-3"}`} title="flagged cohort avg pnl% (margin-relative) vs unflagged base">
          {s.flagN ? s.flagAvg.toFixed(2) : "—"}
        </span>
      </div>
    </div>
  );
}

export default function EntryLeversCard() {
  const [data, setData] = useState<EntryLeversDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/entry-levers", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as EntryLeversDTO);
    } catch {
      /* transient */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void pull();
    const t = setInterval(() => void pull(), 30_000);
    return () => clearInterval(t);
  }, [pull]);

  const cycle = useCallback(
    async (lever: string, current: string) => {
      const next = MODE_ORDER[(MODE_ORDER.indexOf(current as (typeof MODE_ORDER)[number]) + 1) % MODE_ORDER.length];
      setBusy(true);
      try {
        const res = await fetch("/api/entry-levers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lever, mode: next }) });
        const body = (await res.json()) as { error?: string };
        if (!res.ok) toast.error(body.error ?? "mode change refused");
        else toast.success(`${lever} → ${next.toUpperCase()}`);
        await pull();
      } catch {
        toast.error("network error");
      } finally {
        setBusy(false);
      }
    },
    [pull],
  );

  const st = data?.stats;
  const target = Number(data?.params.promoteMinN ?? 100);

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Crosshair className="h-4 w-4 text-violet-neon" aria-hidden />
          <span className="label-tech">Entry levers // late-entry shield — evidence-gated authority</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-2">
          <NeonBadge tone={st?.perLever.some((l) => data?.modes[l.lever] === "enforce") ? "violet" : "amber"}>
            {st?.perLever.filter((l) => data?.modes[l.lever] === "enforce").length ?? 0} ENFORCING
          </NeonBadge>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => void pull()} aria-label="refresh entry levers">
            <RefreshCw className={`h-3 w-3 ${loaded ? "" : "animate-spin"}`} />
          </Button>
        </div>
      </div>

      {!st ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] text-ink-3">
          <LiveDot /> {loaded ? "shield state unavailable" : "loading shield state…"}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1 pb-1 font-terminal text-[9px] text-ink-3">
            <span>
              WINDOW {st.windowDays}d · cohort n={st.cohortN} · WR {st.cohortWr.toFixed(1)}% · avg {st.cohortAvg.toFixed(2)}
            </span>
            <span className="ml-auto" title="promotion gate: n≥100 · flagged avg ≤ −0.5 · separation ≥ 0.5 · auto-demote on heal">
              GATE n≥{target} · avg≤−0.5 · sep≥0.5
            </span>
          </div>
          {st.perLever.map((l) => (
            <LeverRow key={l.lever} s={l} mode={data?.modes[l.lever] ?? "shadow"} pinned={!!data?.manual?.[l.lever]} target={target} busy={busy} onCycle={() => void cycle(l.lever, data?.modes[l.lever] ?? "shadow")} />
          ))}
          {data?.autoNotes?.length ? (
            <div className="mt-1 border-t border-white/5 pt-1.5 font-terminal text-[9px] text-ink-3">
              {data.autoNotes.slice(0, 2).map((n, i) => (
                <div key={i} className="truncate px-1">
                  ⟡ {n}
                </div>
              ))}
            </div>
          ) : null}
          {data?.journal?.length ? (
            <div className="mt-0.5 font-terminal text-[9px] text-ink-3">
              {data.journal.slice(0, 2).map((j, i) => {
                const fired = (j.fired as Array<{ lever: string }>)?.map((f) => f.lever).join(",") || "—";
                return (
                  <div key={i} className="truncate px-1">
                    {j.at ? ago(new Date(String(j.at)).getTime()) : "—"} · {String(j.symbol ?? "?")} · {String(j.observe ?? false) === "true" ? "OBSERVE" : j.block ? `BLOCKED(${String(j.block)})` : "shadow-log"} · [{fired}]
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="px-1 pt-1 font-terminal text-[9px] leading-relaxed text-ink-3">
            Seven deterministic levers judge every deploy · shadow journal now, enforce ONLY on own-cohort evidence · click a lever to cycle its mode ·
            forced/capture deploys are OBSERVE-ONLY · fail-open.
          </div>
        </div>
      )}
    </BentoCard>
  );
}
