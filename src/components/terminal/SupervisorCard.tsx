"use client";

import { useEffect, useState } from "react";
import { ScanEye } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";

/**
 * SupervisorCard — v10.28 SENIOR-ENGINEER SUPERVISOR CRON tile (operator
 * order 2026-09-25: standalone cron on :3040 with its own process/state —
 * NOT embedded in sentinel/watchdog). Displays the supervisor's oversight
 * mirror: service probe grid, verdict, win-rate / EST PNL% target function,
 * RAW-CAL book progress and the OPEN follow-through count. Feed:
 * /api/supervisor (proxy → :3040/status, 30s poll). The supervisor itself
 * keeps running regardless of this dashboard.
 */

interface SupProbe { key: string; label: string; ok: boolean; status: number | null; ms: number | null }
interface SupStatus {
  ok: boolean;
  ver?: string;
  error?: string;
  uptimeS?: number;
  lastQuick?: { at: number; verdict: string; crit: number; warn: number; probesDown: number } | null;
  lastDeep?: { at: number; verdict: string; crit: number; warn: number } | null;
  probes?: SupProbe[];
  followupsOpen?: number;
  tgConfigured?: boolean;
}

function agoSec(ts?: number | null): string {
  if (!ts) return "--";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export default function SupervisorCard() {
  const [st, setSt] = useState<SupStatus | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/supervisor", { cache: "no-store" });
        const j = (await r.json()) as SupStatus;
        if (!alive) return;
        setSt(j);
        setErr(false);
      } catch {
        if (alive) setErr(true);
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const q = st?.lastQuick ?? null;
  const crit = q?.crit ?? 0;
  const warn = q?.warn ?? 0;
  const live = !!q && Date.now() - q.at < 7 * 60_000;
  const verdictTone = crit ? "text-red-neon" : warn ? "text-amber-neon" : "text-emerald-neon";
  const probes = st?.probes ?? [];

  return (
    <BentoCard className="p-4 sm:p-4" delay={0.05}>
      <div className="mb-3 flex items-center gap-2">
        <ScanEye className="size-3.5 text-violet-neon" aria-hidden />
        <span className="label-tech">Supervisor Cron · Senior-Engineer Oversight</span>
        <NeonBadge tone={live ? "neon" : "amber"} className="ml-auto">
          {live ? "STANDING WATCH" : "STALE"}
        </NeonBadge>
      </div>

      {!st ? (
        <div className="py-6 text-center font-terminal text-[11px] text-ink-3">{err ? "supervisor unreachable — watchdog heal expected" : "linking to :3040 …"}</div>
      ) : !st.ok ? (
        <div className="py-6 text-center font-terminal text-[11px] text-amber-neon">{st.error ?? "supervisor degraded"}</div>
      ) : (
        <div className="space-y-2.5 font-terminal text-[11px]">
          {/* verdict + cadence */}
          <div className="flex items-center justify-between gap-2">
            <span className={cn("font-bold", verdictTone)}>{q?.verdict ?? "--"}</span>
            <span className="flex items-center gap-1.5 text-[9px] text-ink-3">
              <LiveDot className={live ? "text-emerald-neon" : "text-amber-neon"} />
              sweep {agoSec(q?.at ?? null)} ago · deep {st.lastDeep ? agoSec(st.lastDeep.at) : "--"} · uptime {Math.round((st.uptimeS ?? 0) / 60)}m
            </span>
          </div>

          {/* probe grid */}
          <div className="grid grid-cols-4 gap-1.5" role="list" aria-label="service probes">
            {probes.map((p) => (
              <div key={p.key} role="listitem" title={`${p.label} — ${p.ok ? `ok (${p.status}${p.ms != null ? `, ${p.ms}ms` : ""})` : `DOWN (${p.status ?? "no-resp"})`}`} className={cn("flex items-center gap-1 rounded border px-1.5 py-1", p.ok ? "border-white/8 bg-white/[0.02]" : "border-red-neon/40 bg-red-neon/[0.06]")}>
                <span className={cn("size-1.5 shrink-0 rounded-full", p.ok ? "bg-emerald-neon" : "bg-red-neon")} aria-hidden />
                <span className="truncate text-[9px] text-ink-2">{p.label.replace(" :", "\n")}</span>
              </div>
            ))}
          </div>

          {/* target function row */}
          <div className="grid grid-cols-3 gap-1.5">
            <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
              <div className="label-tech text-[8px]">FOLLOW-THROUGH</div>
              <div className="font-bold tabular-nums text-ink-1">{st.followupsOpen ?? 0} <span className="text-[9px] font-normal text-ink-3">OPEN</span></div>
            </div>
            <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
              <div className="label-tech text-[8px]">ESCALATION</div>
              <div className="font-bold tabular-nums text-ink-1">{st.tgConfigured ? "TG ON" : "TG OFF"} <span className="text-[9px] font-normal text-ink-3">direct</span></div>
            </div>
            <div className="rounded border border-white/8 bg-white/[0.02] px-2 py-1.5">
              <div className="label-tech text-[8px]">FINDINGS</div>
              <div className="font-bold tabular-nums"><span className="text-red-neon">{crit}</span> / <span className="text-amber-neon">{warn}</span></div>
            </div>
          </div>

          <p className="text-[9px] leading-relaxed text-ink-3">
            standalone :3040 · own process/state · DB read-only · Telegram escalation independent of :3000 · cycles 5m/30m + daily 09:00 EST digest — mandate: WR ↑ · EST PNL% ↑
          </p>
        </div>
      )}
    </BentoCard>
  );
}
