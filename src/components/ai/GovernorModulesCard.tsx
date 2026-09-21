"use client";

// ── FlowRadar Neo v10.0 — GOVERNOR MODULES card (AI CORE) ───────────────────
// The operator four-module package in one window: R1 RISK-GOVERNOR,
// R2 TIME-GOVERNOR, R5 UI-CANARY (each shadow-first with an operator
// SHADOW/ENGAGED authority toggle) and R6 DAILY SENIOR-REVIEW (nightly
// read-only auditor). Data: /api/governors.

import { useCallback, useEffect, useState } from "react";
import { Activity, ShieldAlert, Clock3, Radar, ClipboardCheck, Loader2, RefreshCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface RiskGovernorState {
  cycles: number;
  lastRunAt: string | null;
  verdict: "STANDARD" | "DEFENSIVE" | "HEAVY-DEFENSIVE" | "OFFENSIVE";
  sizeMult: number;
  reasons: string[];
  streak: number;
  lastProposalAt: string | null;
  lastApplied: { at: string; knob: string; from: number; to: number } | null;
  journal: Array<{ at: string; verdict: string; sizeMult: number; line: string }>;
}

interface HourCell {
  h: number;
  n: number;
  pnlUsd: number;
  wr: number;
  tier: "TOXIC" | "PRIME" | "NEUTRAL" | "THIN";
  weight: number;
}

interface TimeGovernorState {
  cycles: number;
  lastRunAt: string | null;
  hourly: HourCell[];
  toxicHours: number[];
  primeHours: number[];
  estUpliftUsd: number;
  line: string;
  journal: Array<{ at: string; line: string }>;
}

interface CanaryState {
  cycles: number;
  lastRunAt: string | null;
  probes: Array<{ name: string; path: string; ok: boolean; status: number; latencyMs: number; shapeOk: boolean; err: string | null }>;
  verdict: "GREEN" | "AMBER" | "RED";
  redStreak: number;
  line: string;
}

interface SeniorState {
  cycles: number;
  lastRunAt: string | null;
  report: {
    at: string;
    ledger: { settled: number; last20PnlUsd: number; worst: { strategy: string; n: number; expectancyPct: number; pnlUsd: number } | null };
    rawcal: { open: number; settled24h: number; note: string };
    riskGovernor: { verdict: string; sizeMult: number; streak: number } | null;
    timeGovernor: { toxicHours: number[]; primeHours: number[]; estUpliftUsd: number } | null;
    canary: { verdict: string; line: string } | null;
    proposalsQueued: Array<{ knob: string; from: number; to: number; rationale: string }>;
  } | null;
  tg: { ok: boolean; error: string | null } | null;
}

interface GovernorsSnapshot {
  mode: "SHADOW" | "ENGAGED";
  riskGovernor: RiskGovernorState;
  timeGovernor: TimeGovernorState;
  canary: CanaryState;
  seniorReview: SeniorState;
  journal?: FourPackEvent[];
}

// v10.8 FOUR-PACK JSON journal doctrine — one retrievable audit stream
interface FourPackEvent {
  at: number;
  module: string;
  kind: "cycle" | "flip" | "proposal" | "apply" | "mode" | "audit" | "page";
  verdict: string | null;
  line: string;
}

const MODULE_TAG: Record<string, { label: string; cls: string }> = {
  "r1-risk-governor": { label: "R1", cls: "border-neon/40 bg-neon/10 text-neon" },
  "r2-time-governor": { label: "R2", cls: "border-amber-neon/40 bg-amber-neon/10 text-amber-neon" },
  "r5-ui-canary": { label: "R5", cls: "border-cyan-neon/40 bg-cyan-neon/10 text-cyan-neon" },
  "r6-senior-review": { label: "R6", cls: "border-violet-neon/40 bg-violet-neon/10 text-violet-neon" },
  mode: { label: "OP", cls: "border-white/15 bg-white/5 text-ink-2" },
};

const KIND_TONE: Record<string, string> = {
  flip: "text-amber-neon",
  proposal: "text-violet-neon",
  apply: "text-neon",
  page: "text-danger-neon",
  audit: "text-violet-neon",
  mode: "text-ink",
};

function timeAgoShort(iso: string | null): string {
  if (!iso) return "—";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const RISK_TONE: Record<string, string> = {
  STANDARD: "border-white/10 text-ink-2 bg-white/[0.04]",
  DEFENSIVE: "border-amber-neon/40 text-amber-neon bg-amber-neon/10",
  "HEAVY-DEFENSIVE": "border-danger-neon/40 text-danger-neon bg-danger-neon/10",
  OFFENSIVE: "border-neon/40 text-neon bg-neon/10",
};

const HOUR_TONE: Record<string, string> = {
  TOXIC: "border-danger-neon/40 bg-danger-neon/10 text-danger-neon",
  PRIME: "border-neon/40 bg-neon/10 text-neon",
  NEUTRAL: "border-white/10 text-ink-3",
  THIN: "border-white/5 text-ink-3/60",
};

function ModuleHeader({ icon, title, badge, badgeClass }: { icon: React.ReactNode; title: string; badge: string; badgeClass: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {icon}
        <h4 className="font-terminal text-xs font-bold tracking-[0.16em] text-ink">{title}</h4>
      </div>
      <span className={cn("shrink-0 rounded border px-2 py-0.5 font-terminal text-[9px] font-bold tracking-[0.14em]", badgeClass)}>{badge}</span>
    </div>
  );
}

export default function GovernorModulesCard() {
  const [snap, setSnap] = useState<GovernorsSnapshot | null>(null);
  const [fetching, setFetching] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/governors?journal=1&limit=40", { cache: "no-store" });
      if (res.ok) setSnap((await res.json()) as GovernorsSnapshot);
    } catch {
      /* transient */
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (module: "risk-governor" | "time-governor" | "ui-canary", mode?: "SHADOW" | "ENGAGED") => {
    const key = `${module}:${mode ?? "run"}`;
    setActing(key);
    try {
      const res = await fetch("/api/governors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode ? { module, mode } : { module }),
      });
      if (!res.ok) throw new Error(String(res.status));
      toast.success(`${module.toUpperCase()}${mode ? ` → ${mode}` : " cycle done"}`);
      await load();
    } catch {
      toast.error("Action failed — check dev.log");
    } finally {
      setActing(null);
    }
  };

  return (
    <BentoCard className="mt-4 p-4 sm:p-5" delay={0.03}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {fetching ? <Loader2 className="size-4 animate-spin text-neon" aria-hidden /> : <LiveDot />}
          <div>
            <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">GOVERNOR MODULES — FOUR-PACK</h3>
            <p className="label-tech mt-0.5">v10.0 operator package · R1 RISK · R2 TIME · R5 UI-CANARY · R6 SENIOR-REVIEW</p>
          </div>
        </div>
        <NeonBadge tone={snap?.mode === "ENGAGED" ? "neon" : "amber"}>{snap?.mode === "ENGAGED" ? "R1/R5 ENGAGED" : "SHADOW-FIRST"}</NeonBadge>
      </div>

      {!snap ? (
        <p className="py-6 text-center font-terminal text-xs text-ink-3">{fetching ? "loading module telemetry…" : "module telemetry unavailable"}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── R1 RISK GOVERNOR ── */}
          <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5" aria-label="Risk Governor module">
            <ModuleHeader
              icon={<ShieldAlert className="size-4 text-neon" aria-hidden />}
              title="R1 · RISK GOVERNOR"
              badge={snap.riskGovernor.verdict}
              badgeClass={RISK_TONE[snap.riskGovernor.verdict] ?? RISK_TONE.STANDARD!}
            />
            <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
              regime × drawdown × slope20 sizing verdict · ×{snap.riskGovernor.sizeMult.toFixed(2)} size · {snap.riskGovernor.cycles} cycles (streak {snap.riskGovernor.streak}) · last {timeAgoShort(snap.riskGovernor.lastRunAt)}
              {snap.riskGovernor.lastApplied ? ` · last apply ${snap.riskGovernor.lastApplied.knob} ${snap.riskGovernor.lastApplied.from}→${snap.riskGovernor.lastApplied.to}` : " · nothing applied"}
            </p>
            {snap.riskGovernor.reasons.length > 0 && <p className="mt-1 font-terminal text-[10px] text-ink-2">▸ {snap.riskGovernor.reasons[0]}</p>}
            <div className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1">
              {snap.riskGovernor.journal.length === 0 && <p className="font-terminal text-[10px] text-ink-3">journal fills on the first scheduled cycle (~2min rail, 60min throttle)</p>}
              {snap.riskGovernor.journal.slice(0, 6).map((j, i) => (
                <div key={`${j.at}-${i}`} className="flex items-start gap-2 font-terminal text-[10px] leading-relaxed">
                  <span className={cn("mt-1 inline-block size-1.5 shrink-0 rounded-full", j.verdict === "STANDARD" ? "bg-ink-3/60" : j.verdict === "OFFENSIVE" ? "bg-neon" : "bg-amber-neon")} aria-hidden />
                  <span className="text-ink-2">
                    {j.verdict} ×{j.sizeMult.toFixed(2)} — {j.line}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => void act("risk-governor", "SHADOW")} className="h-8 font-terminal text-[10px]">
                SHADOW
              </Button>
              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => void act("risk-governor", "ENGAGED")} className="h-8 font-terminal text-[10px]">
                ENGAGED
              </Button>
            </div>
          </section>

          {/* ── R2 TIME GOVERNOR ── */}
          <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5" aria-label="Time Governor module">
            <ModuleHeader
              icon={<Clock3 className="size-4 text-neon" aria-hidden />}
              title="R2 · TIME GOVERNOR"
              badge={`${snap.timeGovernor.toxicHours.length} TOXIC · ${snap.timeGovernor.primeHours.length} PRIME`}
              badgeClass={snap.timeGovernor.toxicHours.length > 0 ? "border-danger-neon/40 text-danger-neon bg-danger-neon/10" : "border-white/10 text-ink-2 bg-white/[0.04]"}
            />
            <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
              Tehran-hour tiers over a 45d settled ledger · {snap.timeGovernor.cycles} cycles · est. uplift +${snap.timeGovernor.estUpliftUsd.toFixed(2)} · last {timeAgoShort(snap.timeGovernor.lastRunAt)}
            </p>
            <p className="mt-1 font-terminal text-[10px] text-ink-2">▸ {snap.timeGovernor.line}</p>
            {snap.timeGovernor.hourly.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1" aria-label="Hour tier map">
                {snap.timeGovernor.hourly.map((h) => (
                  <span
                    key={h.h}
                    title={`${String(h.h).padStart(2, "0")}:00 Tehran — n=${h.n}, net $${h.pnlUsd.toFixed(2)}, WR ${h.wr.toFixed(0)}%, tier ${h.tier}, weight ×${h.weight}`}
                    className={cn("rounded border px-1.5 py-0.5 font-terminal text-[9px] tabular-nums", HOUR_TONE[h.tier])}
                  >
                    {String(h.h).padStart(2, "0")}×{h.weight.toFixed(2)}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => void act("time-governor")} className="h-8 gap-1.5 font-terminal text-[10px]">
                <RefreshCw className={cn("size-3", acting === "time-governor:run" && "animate-spin")} aria-hidden />
                RUN CYCLE
              </Button>
            </div>
          </section>

          {/* ── R5 UI-CANARY ── */}
          <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5" aria-label="UI Canary module">
            <ModuleHeader
              icon={<Radar className="size-4 text-cyan-neon" aria-hidden />}
              title="R5 · UI-CANARY"
              badge={snap.canary.verdict}
              badgeClass={snap.canary.verdict === "GREEN" ? "border-neon/40 text-neon bg-neon/10" : snap.canary.verdict === "AMBER" ? "border-amber-neon/40 text-amber-neon bg-amber-neon/10" : "border-danger-neon/40 text-danger-neon bg-danger-neon/10"}
            />
            <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
              black-box probes of the dashboard data plane (~15min rail) · {snap.canary.cycles} passes · red streak {snap.canary.redStreak} · last {timeAgoShort(snap.canary.lastRunAt)}
            </p>
            <p className="mt-1 font-terminal text-[10px] text-ink-2">▸ {snap.canary.line}</p>
            {snap.canary.probes.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {snap.canary.probes.map((p) => (
                  <span
                    key={p.name}
                    title={`${p.name} ${p.path} — HTTP ${p.status}, shape ${p.shapeOk ? "ok" : "bad"}, ${p.latencyMs}ms${p.err ? `, err ${p.err}` : ""}`}
                    className={cn("rounded border px-1.5 py-0.5 font-terminal text-[9px]", p.ok && p.shapeOk ? "border-neon/30 bg-neon/5 text-neon/90" : "border-danger-neon/40 bg-danger-neon/10 text-danger-neon")}
                  >
                    {p.name} {p.ok && p.shapeOk ? `${p.latencyMs}ms` : "FAIL"}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => void act("ui-canary", "SHADOW")} className="h-8 font-terminal text-[10px]">
                SHADOW
              </Button>
              <Button size="sm" variant="outline" disabled={acting !== null} onClick={() => void act("ui-canary", "ENGAGED")} className="h-8 font-terminal text-[10px]">
                ENGAGED
              </Button>
            </div>
          </section>

          {/* ── R6 SENIOR-REVIEW ── */}
          <section className="rounded-xl border border-white/8 bg-white/[0.02] p-3.5" aria-label="Daily Senior Review module">
            <ModuleHeader
              icon={<ClipboardCheck className="size-4 text-violet-neon" aria-hidden />}
              title="R6 · DAILY SENIOR-REVIEW"
              badge={snap.seniorReview.report ? `REPORT #${snap.seniorReview.cycles}` : "PENDING FIRST RUN"}
              badgeClass={snap.seniorReview.report ? "border-violet-neon/40 text-violet-neon bg-violet-neon/10" : "border-amber-neon/40 text-amber-neon bg-amber-neon/10"}
            />
            <p className="font-terminal text-[10px] leading-relaxed text-ink-3">
              nightly audit after the 00:00 Tehran report (read-only + clamped proposals, one Telegram digest) · {snap.seniorReview.cycles} review(s) · last {timeAgoShort(snap.seniorReview.lastRunAt)} · TG {snap.seniorReview.tg ? (snap.seniorReview.tg.ok ? "delivered" : `failed (${snap.seniorReview.tg.error ?? "?"})`) : "—"}
            </p>
            {!snap.seniorReview.report ? (
              <p className="mt-2 font-terminal text-[10px] text-ink-3">first audit runs in the 00:00-05:59 Tehran window after the next daily report</p>
            ) : (
              <div className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1 font-terminal text-[10px] leading-relaxed text-ink-2">
                <p>
                  <span className="font-bold text-violet-neon">LEDGER</span> last-20 ${snap.seniorReview.report.ledger.last20PnlUsd.toFixed(2)}
                  {snap.seniorReview.report.ledger.worst ? ` · worst ${snap.seniorReview.report.ledger.worst.strategy} ${snap.seniorReview.report.ledger.worst.expectancyPct}%/trade over n=${snap.seniorReview.report.ledger.worst.n}` : ""}
                </p>
                <p>
                  <span className="font-bold text-violet-neon">RAW-CAL</span> open {snap.seniorReview.report.rawcal.open}, settled 24h {snap.seniorReview.report.rawcal.settled24h} — {snap.seniorReview.report.rawcal.note}
                </p>
                {snap.seniorReview.report.riskGovernor && (
                  <p>
                    <span className="font-bold text-violet-neon">R1</span> {snap.seniorReview.report.riskGovernor.verdict} ×{snap.seniorReview.report.riskGovernor.sizeMult.toFixed(2)} (streak {snap.seniorReview.report.riskGovernor.streak})
                    {snap.seniorReview.report.timeGovernor ? ` · R2 toxic [${snap.seniorReview.report.timeGovernor.toxicHours.join(",") || "—"}] uplift +$${snap.seniorReview.report.timeGovernor.estUpliftUsd.toFixed(2)}` : ""}
                    {snap.seniorReview.report.canary ? ` · R5 ${snap.seniorReview.report.canary.verdict}` : ""}
                  </p>
                )}
                <p>
                  <span className="font-bold text-violet-neon">PROPOSALS</span>{" "}
                  {snap.seniorReview.report.proposalsQueued.length === 0
                    ? "none queued this cycle (read-only audit)"
                    : snap.seniorReview.report.proposalsQueued.map((q) => `${q.knob} ${q.from}→${q.to}`).join(" · ") + " — APPROVE in the advisor panel"}
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── v10.8 JOURNAL DOCTRINE — one retrievable JSON audit stream ── */}
      <section className="mt-4 rounded-xl border border-white/8 bg-white/[0.02] p-3.5" aria-label="Four-pack JSON journal doctrine">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ScrollText className="size-3.5 text-neon" aria-hidden />
            <h4 className="font-terminal text-xs font-bold tracking-[0.16em] text-ink">JOURNAL DOCTRINE · JSON</h4>
            <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-terminal text-[9px] text-ink-3">{snap?.journal?.length ?? 0} recent events</span>
          </div>
          <a
            href="/api/governors/journal?download=1"
            className="rounded border border-neon/40 bg-neon/10 px-2 py-1 font-terminal text-[9px] font-bold tracking-[0.14em] text-neon transition-colors hover:bg-neon/20"
            aria-label="Download four-pack JSON journal"
          >
            ↓ DOWNLOAD JSON
          </a>
        </div>
        <p className="mb-2 font-terminal text-[9px] leading-relaxed text-ink-3">
          every module verdict / flip / proposal / apply / audit lands in .data/fourpack-journal.jsonl (6MB rotate) + fourpack-latest.json — the central AI core reads the same stream in its grounding every cycle
        </p>
        {!snap?.journal?.length ? (
          <p className="font-terminal text-[10px] text-ink-3">journal fills on the next module cycle — R1 hourly · R2 6h · R5 ~15min · R6 nightly</p>
        ) : (
          <div className="max-h-44 space-y-1 overflow-y-auto pr-1 terminal-scroll">
            {snap.journal.slice(0, 10).map((e) => {
              const tag = MODULE_TAG[e.module] ?? MODULE_TAG.mode!;
              return (
                <div key={`${e.at}-${e.module}-${e.kind}`} className="flex items-start gap-2 font-terminal text-[10px] leading-relaxed">
                  <span className={cn("shrink-0 rounded border px-1 py-0.5 text-[8px] font-bold", tag.cls)}>{tag.label}</span>
                  <span className="shrink-0 text-ink-3">{timeAgoShort(new Date(e.at).toISOString())}</span>
                  <span className={cn("shrink-0 font-bold", KIND_TONE[e.kind] ?? "text-ink-3")}>{e.kind.toUpperCase()}</span>
                  <span className="text-ink-2" title={e.line}>
                    {e.verdict ? `[${e.verdict}] ` : ""}
                    {e.line}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </BentoCard>
  );
}
