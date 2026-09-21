"use client";

// ── NEXUS//SIGNALS — SentinelPanel (operator order 2026-09-21) ──────────────
// Live window into the NEXUS-SENTINEL deep-monitoring service (:3030 → proxied
// by GET /api/sentinel). Surfaces the ONE-LINE system verdict (GREEN/AMBER/RED)
// plus the vitals the operator asked to always see: 6-service probe map, memory
// + dual-disk headroom, engine event velocity, autonomous backup freshness,
// shadow-arm fill progress, and the live anomaly radar.
// Design: reuses BentoCard/NeonBadge/LiveDot primitives, neon token palette
// only, hydration-safe (relative times gated behind useMounted).

import { useQuery } from "@tanstack/react-query";
import { Activity, DatabaseBackup, Gauge, HardDrive, Radar, Server, ShieldCheck } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { useMounted } from "@/hooks/usePulse";

interface Anomaly { sev: "warn" | "crit"; area: string; msg: string }
interface Svc { key: string; label: string; up: boolean; status: number | null; ms: number }
interface Arm { id: string; n: number; target: number; pct: number | null; starved: boolean }
interface SentinelReport {
  ok?: boolean;
  reachable?: boolean;
  error?: string;
  verdict?: "GREEN" | "AMBER" | "RED";
  at?: string;
  kind?: string;
  services?: Svc[];
  mem?: { availableMb: number | null };
  disk?: { rootFreeGb: number | null; tmpFreeGb: number | null };
  db?: { ok?: boolean; signals?: number; events?: number; events1h?: number; lastEventAgeMs?: number | null; dbBytes?: number | null; orphanEvents?: number; stuckPumpTracks?: number };
  backup?: { ok?: boolean; encCount?: number; encAgeMs?: number | null };
  watchdog?: { ok?: boolean; ver?: string | null; modes?: Record<string, string>; nonOk?: number };
  shadow?: { ok?: boolean; fillPct?: number | null; nSum?: number; tSum?: number; fenceEntries24hFloor?: number; arms?: Arm[]; mode?: string | null };
  rawcal?: { armed?: boolean | null; heartbeatAgeH?: number };
  log?: { errors?: number; settlementStalled?: number; oom?: number; enospc?: number };
  anomalies?: Anomaly[];
  uptimeSec?: number;
  ver?: string;
}

const VERDICT_TONE: Record<string, { badge: "neon" | "amber" | "danger"; label: string }> = {
  GREEN: { badge: "neon", label: "ALL SYSTEMS NOMINAL" },
  AMBER: { badge: "amber", label: "DEGRADED — WATCH LIST" },
  RED: { badge: "danger", label: "CRITICAL — ACTION REQUIRED" },
};

function ageHuman(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `+${m % 60}m` : ""} ago`;
}

function Mini({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-[rgba(159,180,171,0.12)] bg-[rgba(8,12,16,0.45)] px-3 py-2.5 min-h-[64px]" aria-label={label}>
      <span className="mt-0.5 text-ink-3">{icon}</span>
      <div className="min-w-0">
        <div className="font-terminal text-[9px] uppercase tracking-[0.18em] text-ink-3">{label}</div>
        <div className={`font-terminal text-sm font-semibold leading-tight ${tone ?? "text-ink"}`}>{value}</div>
        {sub ? <div className="truncate font-terminal text-[10px] text-ink-3">{sub}</div> : null}
      </div>
    </div>
  );
}

export default function SentinelPanel() {
  const mounted = useMounted();
  const { data, isLoading } = useQuery<SentinelReport>({
    queryKey: ["sentinel"],
    queryFn: async () => {
      const r = await fetch("/api/sentinel", { cache: "no-store" });
      return r.json();
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const v = data?.verdict ?? null;
  const tone = v ? VERDICT_TONE[v] : null;
  const svcs = data?.services ?? [];
  const up = svcs.filter((s) => s.up).length;
  const anomalies = data?.anomalies ?? [];
  const encAge = data?.backup?.encAgeMs ?? null;
  const arms = data?.shadow?.arms ?? [];

  return (
    <BentoCard delay={0} tone="violet" corners ariaLabel="System sentinel status">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar className="size-4 text-violet-neon" aria-hidden />
          <span className="font-terminal text-[11px] font-bold text-violet-neon/80">[06]</span>
          <h2 className="font-terminal text-lg font-bold uppercase tracking-[0.14em] text-foreground sm:text-xl">
            System Sentinel
          </h2>
        </div>
        {isLoading && !data ? (
          <span className="font-terminal text-xs text-ink-3">LINKING SENTINEL :3030…</span>
        ) : data && data.ok === false && data.reachable === false ? (
          <NeonBadge tone="amber">SENTINEL OFFLINE — WATCHDOG WILL REVIVE</NeonBadge>
        ) : (
          <div className="flex items-center gap-2">
            <LiveDot tone={v === "RED" ? "danger" : v === "AMBER" ? "amber" : "neon"} />
            <NeonBadge tone={tone?.badge ?? "neon"}>
              {v ?? "…"} {tone?.label ?? ""}
            </NeonBadge>
            <span className="hidden font-terminal text-[10px] uppercase tracking-[0.14em] text-ink-3 sm:inline">
              {mounted && data?.at ? `scan ${ageHuman(Date.now() - new Date(data.at).getTime())}` : ""}
            </span>
          </div>
        )}
      </div>

      {/* vitals grid */}
      <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
        <Mini
          icon={<Server className="size-3.5" aria-hidden />}
          label="SERVICES"
          value={`${up}/${svcs.length || 6} UP`}
          sub={svcs.map((s) => `${s.key}${s.up ? "✓" : "✕"}`).join(" ") || "—"}
          tone={up === (svcs.length || 6) ? "text-neon" : "text-danger-neon"}
        />
        <Mini
          icon={<Gauge className="size-3.5" aria-hidden />}
          label="MEMORY"
          value={data?.mem?.availableMb != null ? `${data.mem.availableMb}MB` : "—"}
          sub="available · crit 250"
          tone={data?.mem?.availableMb != null && data.mem.availableMb < 350 ? "text-amber-neon" : "text-ink"}
        />
        <Mini
          icon={<HardDrive className="size-3.5" aria-hidden />}
          label="DISK ROOT"
          value={data?.disk?.rootFreeGb != null ? `${data.disk.rootFreeGb}GB` : "—"}
          sub={data?.disk?.tmpFreeGb != null ? `PolarFS /tmp ${data.disk.tmpFreeGb}GB` : undefined}
          tone={data?.disk?.rootFreeGb != null && data.disk.rootFreeGb < 1.2 ? "text-amber-neon" : "text-ink"}
        />
        <Mini
          icon={<Activity className="size-3.5" aria-hidden />}
          label="ENGINE EVENTS 1H"
          value={data?.db?.events1h != null ? data.db.events1h.toLocaleString() : "—"}
          sub={data?.db?.signals != null ? `${data.db.signals} signals · ${(((data.db.dbBytes ?? 0) as number) / 1_048_576).toFixed(1)}MB` : undefined}
          tone="text-cyan-neon"
        />
        <Mini
          icon={<DatabaseBackup className="size-3.5" aria-hidden />}
          label="AUTO BACKUP / 3H"
          value={encAge != null ? ageHuman(encAge) : data?.backup?.encCount ? "ring ok" : "none yet"}
          sub={data?.backup?.encCount ? `${data.backup.encCount} encrypted in ring` : "sentinel schedules backup.sh"}
          tone={encAge != null && encAge > 3.2 * 3600_000 ? "text-amber-neon" : "text-neon"}
        />
        <Mini
          icon={<ShieldCheck className="size-3.5" aria-hidden />}
          label="SHADOW ARMS"
          value={data?.shadow?.nSum != null ? `${data.shadow.nSum}/${data.shadow.tSum ?? "?"}` : "—"}
          sub={data?.shadow?.mode ? `${data.shadow.mode} · fence 24h≥${data.shadow.fenceEntries24hFloor ?? 0}` : undefined}
          tone="text-violet-neon"
        />
      </div>

      {/* shadow arm fill bars */}
      {arms.length > 0 && (
        <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="shadow arm fill progress">
          {arms.map((a) => (
            <div key={a.id} className="rounded-md border border-[rgba(159,180,171,0.1)] px-2.5 py-1.5">
              <div className="flex items-center justify-between font-terminal text-[9px] uppercase tracking-[0.12em] text-ink-3">
                <span className="truncate">{a.id}</span>
                <span className={a.starved ? "text-amber-neon" : "text-ink-3"}>{a.starved ? "STARVED" : `${a.n}/${a.target}`}</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[rgba(159,180,171,0.12)]">
                <div className="h-full rounded-full bg-[rgba(178,107,255,0.7)]" style={{ width: `${Math.min(100, a.pct ?? 0)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* anomaly radar */}
      <div
        className="mt-3 max-h-28 overflow-y-auto rounded-md border border-[rgba(159,180,171,0.1)] bg-[rgba(8,12,16,0.35)] px-3 py-2"
        role="log"
        aria-label="sentinel anomaly radar"
      >
        {anomalies.length === 0 ? (
          <div className="flex items-center gap-2 font-terminal text-[11px] text-neon">
            <Radar className="size-3.5" aria-hidden /> NO ANOMALIES — 60s telemetry · deep scan 30min · auto-backup 3h
          </div>
        ) : (
          <ul className="space-y-1">
            {anomalies.slice(0, 6).map((a, i) => (
              <li key={i} className="flex items-start gap-2 font-terminal text-[11px]">
                <span className={a.sev === "crit" ? "text-danger-neon" : "text-amber-neon"}>{a.sev === "crit" ? "✕" : "▲"}</span>
                <span className="uppercase text-ink-3">{a.area}</span>
                <span className="text-ink">{a.msg}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </BentoCard>
  );
}
