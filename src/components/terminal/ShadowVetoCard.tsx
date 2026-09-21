"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, BrainCircuit, Download, Gavel, ShieldCheck } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { ShadowArmDTO, ShadowVetoDTO, ShadowVetoModeDTO, SvTelemetryDTO } from "@/lib/api-types";

/* ── v8.2 SHADOW-VETO // AI CORE PHASE 0 card ──
 * Feed: /api/ai/shadow-veto (8s poll — in-memory rings, cheap).
 * The tiered-authority second opinion at the deploy gate: the core
 * adjudicates every fence candidate (hair-thin passes gap 0..+3, near-miss
 * rejects gap −8..0) with a VETO-ONLY voice, both sides are outcome-tracked
 * (real linkage for passes, honest paper ledger for rejects), and promotion
 * to live veto power is gated on measured evidence (≥30 settled per arm +
 * Wilson-LB95 separation + negative veto-cohort PnL). Fail-open, revocable. */

const MODE_TONE: Record<ShadowVetoModeDTO, string> = {
  off: "text-ink-3",
  shadow: "text-amber-neon",
  veto: "text-violet-neon",
};

const SIDE_CLS: Record<string, string> = { PASS: "text-neon", REJECT: "text-amber-neon" };

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function usd(v: number): string {
  return `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;
}

function ArmRow({ a }: { a: ShadowArmDTO }) {
  const pct = Math.min(100, (a.n / a.target) * 100);
  const critical = a.id === "real-veto";
  return (
    <div className="px-1 py-1.5" title={a.label}>
      <div className="flex items-center gap-1.5 font-terminal text-[10px]">
        <span className={`w-[178px] shrink-0 truncate font-bold ${critical ? "text-magenta-neon" : "text-ink-2"}`}>{a.label}</span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/5">
          <div className={`h-full rounded-full ${critical ? "bg-magenta-neon" : "bg-neon"} opacity-80`} style={{ width: `${pct}%` }} />
        </div>
        <span className="w-12 shrink-0 text-right tabular-nums text-ink-3">
          {a.n}/{a.target}
        </span>
        <span className="w-14 shrink-0 text-right tabular-nums text-ink">{a.winRatePct !== null ? `${a.winRatePct}%` : "—"}</span>
        <span className="w-16 shrink-0 text-right tabular-nums text-cyan-neon">{a.wilsonLB !== null ? `LB ${a.wilsonLB.toFixed(0)}%` : "—"}</span>
        <span className={`w-14 shrink-0 text-right tabular-nums ${a.netUsd > 0 ? "text-neon" : a.netUsd < 0 ? "text-danger-neon" : "text-ink-3"}`}>{a.n ? usd(a.netUsd) : "—"}</span>
      </div>
    </div>
  );
}

export default function ShadowVetoCard() {
  const [data, setData] = useState<ShadowVetoDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/shadow-veto", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as ShadowVetoDTO);
    } catch {
      /* next tick retries */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void pull();
    const id = setInterval(pull, 8_000);
    return () => clearInterval(id);
  }, [pull]);

  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const handleResponse = useCallback(
    async (res: Response, mode: ShadowVetoModeDTO) => {
      let errMsg: string | null = null;
      if (res.ok) {
        setNotice(`mode → ${mode.toUpperCase()}`);
      } else {
        try {
          const body = (await res.json()) as { error?: string };
          errMsg = body.error ?? `HTTP ${res.status}`;
          if (res.status === 429 && body.error?.includes("cooldown")) setCooldown(20);
        } catch {
          errMsg = `HTTP ${res.status}`;
        }
        setNotice(errMsg);
      }
      setBusy(false);
      setTimeout(() => setNotice(null), errMsg ? 6000 : 3500);
      void pull();
    },
    [pull],
  );

  const setMode = useCallback(
    async (mode: ShadowVetoModeDTO) => {
      if (!data || busy) return;
      if (mode === "veto" && !data.promotion.ready) {
        const ok = window.confirm(
          `EVIDENCE GATE NOT MET\n\n${data.promotion.criteria.map((c) => `${c.ok ? "✓" : "✗"} ${c.detail}`).join("\n")}\n\nForce veto mode anyway? The override is audited and revocable.`,
        );
        if (!ok) return;
        setBusy(true);
        const res = await fetch("/api/ai/shadow-veto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, force: true }) });
        await handleResponse(res, mode);
      } else {
        setBusy(true);
        const res = await fetch("/api/ai/shadow-veto", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
        await handleResponse(res, mode);
      }
    },
    [data, busy, pull, handleResponse],
  );

  const mode = data?.config.mode ?? "shadow";
  const arms = data?.arms ?? [];
  const recent = data?.recent.slice(0, 7) ?? [];
  const paper = data?.paper ?? [];
  const stats = data?.stats;

  // v8.4.1 N3 — manual neural-link probe: one minimal LLM call THROUGH the
  // 429 shield; success resets the shield instantly (MODEL verdicts resume).
  const [probing, setProbing] = useState(false);
  const runProbe = useCallback(async () => {
    if (probing) return;
    setProbing(true);
    try {
      const res = await fetch("/api/ai/neural-link", { method: "POST" });
      const body = (await res.json()) as { ok?: boolean; detail?: string };
      const msg = body.ok ? "neural probe OK — link restored, shield reset" : `probe: ${body.detail ?? "failed"}`;
      setNotice(msg);
      setTimeout(() => setNotice(null), body.ok ? 4000 : 6500);
      void pull();
    } catch {
      setNotice("probe failed — network error");
      setTimeout(() => setNotice(null), 6500);
    } finally {
      setProbing(false);
    }
  }, [probing, pull]);

  // v10.2 SV-TELEMETRY HUB — arm feed wiring + JSON persistence visibility.
  // Light 30s poll (served straight from the persisted snapshot file).
  const [tel, setTel] = useState<SvTelemetryDTO | null>(null);
  const [telLoaded, setTelLoaded] = useState(false);
  const [telBusy, setTelBusy] = useState(false);

  const pullTel = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/shadow-veto/telemetry", { cache: "no-store" });
      if (res.ok) setTel((await res.json()) as SvTelemetryDTO);
      else if (res.status === 503) setTel(null);
    } catch {
      /* next tick retries */
    } finally {
      setTelLoaded(true);
    }
  }, []);

  useEffect(() => {
    void pullTel();
    const id = setInterval(pullTel, 30_000);
    return () => clearInterval(id);
  }, [pullTel]);

  const runSnapshot = useCallback(async () => {
    if (telBusy) return;
    setTelBusy(true);
    try {
      const res = await fetch("/api/ai/shadow-veto/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setNotice(body.ok ? "telemetry snapshot captured → .data/shadow-veto-telemetry.json" : `snapshot failed: ${body.error ?? "unknown"}`);
      setTimeout(() => setNotice(null), body.ok ? 4000 : 6500);
      await pullTel();
      void pull();
    } catch {
      setNotice("telemetry snapshot failed — network error");
      setTimeout(() => setNotice(null), 6500);
    } finally {
      setTelBusy(false);
    }
  }, [telBusy, pullTel, pull]);

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <BrainCircuit className="h-4 w-4 text-violet-neon" aria-hidden />
          <span className="label-tech">Shadow veto // AI core phase 0 — tiered authority at the fence</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-2">
          {notice && <span className="font-terminal text-[9px] text-neon">{notice}</span>}
          <NeonBadge tone={mode === "veto" ? "violet" : mode === "shadow" ? "amber" : "muted"}>PHASE 0 · {mode.toUpperCase()}</NeonBadge>
        </div>
      </div>

      {!data ? (
        <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-violet-neon/25 font-terminal text-[10px] text-ink-3">
          {!loaded ? "connecting…" : "adjudicator warming — first fence verdicts land within ~2min"}
        </div>
      ) : (
        <div className="space-y-3">
          {/* control row */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-white/10">
              {(["off", "shadow", "veto"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => void setMode(m)}
                  disabled={busy || m === mode}
                  aria-pressed={m === mode}
                  aria-label={`set shadow-veto mode ${m}`}
                  className={`px-3 py-1.5 font-terminal text-[10px] font-bold uppercase tracking-wider transition ${m === mode ? "bg-violet-neon/15 text-violet-neon" : "text-ink-3 hover:bg-white/5 hover:text-ink"} disabled:opacity-60`}
                >
                  {m}
                </button>
              ))}
            </div>
            <span className="font-terminal text-[9px] text-ink-3">
              {cooldown > 0 ? (
                <span className="text-amber-neon">control cooldown {cooldown}s</span>
              ) : mode === "shadow" ? (
                "verdicts recorded · live flow untouched · fail-open"
              ) : mode === "veto" ? (
                "veto-only authority active · blocked trades paper-tracked · revocable"
              ) : (
                "adjudicator off"
              )}
            </span>
            <span className="ml-auto flex items-center gap-1.5 font-terminal text-[9px] tabular-nums text-ink-3" title="LLM adjudication budget (rate-limited)">
              <ShieldCheck className="h-3 w-3 text-neon" aria-hidden />
              budget {data.health.callsLastHour}/{data.config.budgetPerHour}·h
              {data.health.pending > 0 && <span className="text-amber-neon">· {data.health.pending} in flight</span>}
              {/* v8.4.1 N3 — active recovery probe button */}
              {data.llm && (data.llm.cooling || data.llm.consecutive429 > 0) && (
                <button
                  onClick={() => void runProbe()}
                  disabled={probing}
                  aria-label="probe the LLM link now"
                  title="fire one minimal LLM probe through the 429 shield — success resets the shield instantly (1 per 2min)"
                  className="rounded border border-violet-neon/40 px-1.5 py-0.5 font-bold text-violet-neon transition hover:bg-violet-neon/10 disabled:opacity-50"
                >
                  {probing ? "PROBING…" : "PROBE"}
                </button>
              )}
              {/* v8.4.1 neural-link (429 budget shield) visibility */}
              {data.llm && (
                <span
                  className={`ml-1 rounded px-1.5 py-0.5 font-bold ${data.llm.cooling ? "bg-danger-neon/15 text-danger-neon" : data.llm.consecutive429 > 0 ? "bg-amber-neon/10 text-amber-neon" : "bg-neon/10 text-neon"}`}
                  title={data.llm.cooling ? `429 budget shield active — background LLM parked ${Math.ceil(data.llm.cooldownRemainsMs / 1000)}s (operator tier protected)` : "LLM link healthy"}
                >
                  {data.llm.cooling ? `NEURAL LINK · 429 COOLDOWN ${Math.ceil(data.llm.cooldownRemainsMs / 1000)}s` : data.llm.consecutive429 > 0 ? `NEURAL LINK · RECOVERING (×${data.llm.consecutive429})` : "NEURAL LINK · OK"}
                </span>
              )}
            </span>
          </div>

          {/* stats strip */}
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
            {[
              { label: "ADJUDICATED", value: String(stats?.total ?? 0), cls: "text-ink" },
              { label: "HAIR-PASS", value: String(stats?.passSide ?? 0), cls: "text-neon" },
              { label: "FENCE-REJ", value: String(stats?.rejectSide ?? 0), cls: "text-amber-neon" },
              { label: "VETO VOICES", value: String(stats?.vetoCount ?? 0), cls: "text-magenta-neon" },
              { label: "MODEL SHARE", value: stats?.modelSharePct !== null && stats?.modelSharePct !== undefined ? `${stats.modelSharePct}%` : "—", cls: "text-cyan-neon" },
              { label: "GROUNDED", value: stats?.modelGroundedPct !== null && stats?.modelGroundedPct !== undefined ? `${stats.modelGroundedPct}%` : "—", cls: stats?.modelGroundedPct !== null && stats?.modelGroundedPct !== undefined && stats.modelGroundedPct < 100 ? "text-amber-neon" : "text-neon" },
              { label: "GATE AGREE", value: stats && stats.rejectSide ? `${Math.round((stats.gateAgreement / stats.rejectSide) * 100)}%` : "—", cls: "text-ink" },
            ].map((c) => (
              <div key={c.label} className="rounded-lg border border-white/8 bg-white/[0.02] px-2 py-1.5 text-center">
                <div className="font-terminal text-[8px] uppercase tracking-[0.14em] text-ink-3">{c.label}</div>
                <div className={`font-terminal text-sm font-bold tabular-nums ${c.cls}`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* A/B arms */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
            <div className="mb-1 flex items-center justify-between px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
              <span className="flex items-center gap-1.5">
                <Gavel className="h-3 w-3 text-magenta-neon" aria-hidden />
                A/B evidence arms · win rate / wilson-LB95 / net
              </span>
              <span>target {arms[0]?.target ?? 30} settled per arm</span>
            </div>
            <div className="divide-y divide-white/5">
              {arms.map((a) => (
                <ArmRow key={a.id} a={a} />
              ))}
            </div>
            {mode !== "veto" && (arms.find((a) => a.id === "paper-veto")?.n ?? 0) === 0 && (
              <p className="mt-1.5 border-t border-white/5 px-1 pt-1.5 font-terminal text-[9px] leading-relaxed text-ink-3" title="paper-veto only fills in VETO mode: only then a core VETO actually blocks the deploy and the blocked trade is paper-tracked. In shadow mode the trade still deploys, so the same verdicts fill the REAL·VETO arm instead.">
                paper-veto idle BY DESIGN — it fills only after auto-promotion to veto mode (arms 30/30 + LB separation). In shadow mode PASS+VETO verdicts still deploy → they feed real-veto.
              </p>
            )}
            <div className="mt-1.5 border-t border-white/5 px-1 pt-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-terminal text-[9px]">
                {data.promotion.criteria.map((c) => (
                  <span key={c.id} className={`${c.ok ? "text-neon" : "text-ink-3"}`} title={c.detail}>
                    {c.ok ? "✓" : "✗"} {c.id}
                  </span>
                ))}
                <span className={`ml-auto font-bold ${data.promotion.ready ? "text-neon" : "text-ink-3"}`}>{data.promotion.ready ? "PROMOTION READY — veto mode unlockable" : "promotion not ready"}</span>
              </div>
              <div className={`mt-0.5 font-terminal text-[9px] ${data.promotion.revocation.pressure ? "text-amber-neon" : "text-ink-3"}`} title={data.promotion.revocation.detail}>
                {data.promotion.revocation.pressure ? "⚠ revocation pressure — " : ""}
                {data.promotion.revocation.detail}
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
            {/* recent adjudications */}
            <div className="min-w-0">
              <div className="mb-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">recent adjudications · veto-only voices</div>
              {recent.length === 0 ? (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-violet-neon/20 font-terminal text-[10px] text-ink-3">
                  no fence candidates adjudicated yet — verdicts appear as candidates touch the boundary band
                </div>
              ) : (
                <div className="max-h-[168px] space-y-0.5 overflow-y-auto pr-1">
                  {recent.map((v) => (
                    <div key={v.id} className="grid grid-cols-[58px_40px_44px_46px_1fr] items-center gap-1 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]" title={`${v.label} · ${v.side === "PASS" ? "hair-thin pass" : "fence reject"} · source ${v.source}${v.audit ? ` · grounding audit ${v.audit.verdict} (cited ${v.audit.cited}, unmatched ${v.audit.unmatched.length})` : " · pre-audit instrument"}${v.outcome ? ` · settled ${v.outcome.status} ${v.outcome.pnlPercent >= 0 ? "+" : ""}${v.outcome.pnlPercent}%` : ""}`}>
                      <span className="truncate text-ink-3">{v.id}</span>
                      <span className={`truncate font-bold ${v.direction === "LONG" ? "text-neon" : "text-magenta-neon"}`}>{v.symbol.replace("USDT", "")}</span>
                      <span className={SIDE_CLS[v.side]}>{v.side === "PASS" ? "hair✓" : "fence✗"}</span>
                      <span className={`rounded border px-1 text-center text-[9px] font-bold leading-4 ${v.verdict === "VETO" ? "border-[rgba(255,77,94,0.4)] text-danger-neon" : "border-[rgba(0,255,163,0.4)] text-neon"}`}>{v.verdict}</span>
                      <span className="min-w-0 truncate text-[9px] text-ink-2" title={v.reason}>
                        {v.audit && (
                          <span className={`mr-1 font-bold ${v.audit.verdict === "VIOLATION" ? "text-danger-neon" : v.audit.verdict === "SUSPECT" ? "text-amber-neon" : "text-neon/70"}`} title={`grounding ${v.audit.verdict} — ${v.audit.cited} cited, ${v.audit.unmatched.length} unmatched`}>
                            {v.audit.verdict === "VIOLATION" ? "✗ungrounded→heuristic" : v.audit.verdict === "SUSPECT" ? "⚠" : "✓"}
                          </span>
                        )}
                        {v.confidence}% · gap {v.gap >= 0 ? "+" : ""}
                        {v.gap.toFixed(1)} · {v.reason}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* paper ledger */}
            <div className="min-w-0">
              <div className="mb-1 flex items-center justify-between font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
                <span>paper ledger · would-have-traded</span>
                <span className="tabular-nums">
                  {stats?.paperOpen ?? 0} open / {stats?.paperSettled ?? 0} settled
                </span>
              </div>
              {paper.length === 0 ? (
                <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-neon/20 font-terminal text-[10px] text-ink-3">no counterfactual positions — opens when the core disagrees with a fence reject</div>
              ) : (
                <div className="max-h-[168px] space-y-0.5 overflow-y-auto pr-1">
                  {paper.map((p) => (
                    <div key={p.id} className="flex items-center gap-1.5 px-1 py-1 font-terminal text-[10px] tabular-nums transition hover:bg-white/[0.03]" title={`${p.id} · verdict ${p.verdictId} · entry ${p.entry} · SL ${p.stop.toFixed(p.entry > 100 ? 1 : 4)} · TP3 ${p.tp3.toFixed(p.entry > 100 ? 1 : 4)} · ${p.leverage}× · ${p.closeNote ?? (p.outcome ? "" : `running (MFE ${p.maxPnlPercent >= 0 ? "+" : ""}${p.maxPnlPercent}%)`)}`}>
                      <span className="w-10 shrink-0 truncate text-ink-3">{p.id}</span>
                      <span className={`w-12 shrink-0 truncate font-bold ${p.direction === "LONG" ? "text-neon" : "text-magenta-neon"}`}>{p.symbol.replace("USDT", "")}</span>
                      <span className={`w-14 shrink-0 ${p.outcome ? (p.status === "SL" ? "text-danger-neon" : "text-neon") : "text-amber-neon"}`}>{p.outcome ? p.status : "OPEN"}</span>
                      <span className={`ml-auto w-14 shrink-0 text-right ${p.pnlPercent > 0 ? "text-neon" : p.pnlPercent < 0 ? "text-danger-neon" : "text-ink-3"}`}>{p.outcome ? `${p.pnlPercent >= 0 ? "+" : ""}${p.pnlPercent.toFixed(1)}%` : `TP ${p.reachedTp}/3`}</span>
                      <span className="w-14 shrink-0 text-right text-ink-3">{p.outcome ? usd(p.pnlUsd) : ago(p.at)}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-1 px-1 font-terminal text-[9px] leading-relaxed text-ink-3">
                Honesty contract: paper rows use <span className="text-ink-2">base geometry</span> (slAtrMult×ATR stop, base RR, tranche ladder, real fee model) — directional-edge evidence at the fence, never presented as real PnL.
                {" "}<span className={data.health.auditViolations > 0 ? "text-amber-neon" : "text-ink-2"} title="v8.2.1 grounding patch — every MODEL verdict is number-audited against its evidence bundle; violations are discarded and the heuristic speaks instead">Grounding audit: every MODEL verdict number-checked — {data.health.auditViolations} violation{data.health.auditViolations === 1 ? "" : "s"} discarded.</span>
                {" "}Records → .data/shadow-veto.jsonl ({data.health.fileKB}KB).
              </p>
            </div>
          </div>

          {/* v10.2 SV-TELEMETRY HUB — per-arm feed wiring + JSON persistence */}
          <div className="rounded-lg border border-white/8 bg-white/[0.02] p-2">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1.5 px-1 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
              <span className="flex items-center gap-1.5">
                <Activity className="h-3 w-3 text-cyan-neon" aria-hidden />
                Telemetry hub · arm feed wiring
                {tel && (
                  <span className="normal-case tracking-normal" title={new Date(tel.capturedAt).toLocaleString()}>
                    · snapshot {ago(tel.capturedAt)} ago
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1.5">
                {tel && (
                  <span className="tabular-nums normal-case tracking-normal" title={`${tel.store.file} · ${tel.store.writes} atomic writes · capture ${tel.captureMs}ms · schemaVersion ${tel.schemaVersion}`}>
                    {tel.store.file} · {tel.store.fileKB}KB · {tel.store.historySamples} samples
                  </span>
                )}
                <button
                  onClick={() => void runSnapshot()}
                  disabled={telBusy}
                  aria-label="capture telemetry snapshot now"
                  title="capture a fresh telemetry snapshot now (POST force — bypasses the 10min throttle)"
                  className="rounded border border-cyan-neon/40 px-1.5 py-0.5 font-bold text-cyan-neon transition hover:bg-cyan-neon/10 disabled:opacity-50"
                >
                  {telBusy ? "…" : "SNAPSHOT"}
                </button>
                {tel && (
                  <a
                    href="/api/ai/shadow-veto/telemetry?download=1"
                    download
                    aria-label="download telemetry JSON"
                    title="download the consolidated telemetry JSON (schemaVersion 1 — retrievable and usable)"
                    className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 font-bold text-ink-2 transition hover:bg-white/5 hover:text-ink"
                  >
                    <Download className="h-3 w-3" aria-hidden />
                    JSON
                  </a>
                )}
              </span>
            </div>

            {!tel ? (
              <div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-cyan-neon/20 font-terminal text-[10px] text-ink-3">
                {!telLoaded ? "reading telemetry store…" : "telemetry warming — first capture lands on the next engine tick or SNAPSHOT"}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {tel.arms.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center gap-1.5 rounded-md border border-white/5 bg-white/[0.02] px-1.5 py-1 font-terminal text-[10px] tabular-nums"
                      title={`${a.feedSource}\n${a.neverFed ? "never fed — " : a.starved ? `STARVED — last fed ${ago(a.lastFedAt)} ago · ` : `last fed ${ago(a.lastFedAt)} ago · `}${a.starveDetail ?? ""}`}
                    >
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${a.starved ? "bg-danger-neon" : a.neverFed ? "bg-amber-neon/70" : "bg-neon"}`} />
                      <span className="w-20 shrink-0 truncate font-bold text-ink">{a.id}</span>
                      <span className="w-10 shrink-0 text-right text-ink-2">
                        {a.n}/{a.target}
                      </span>
                      <div className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-white/5">
                        <div className={`h-full rounded-full ${a.id.startsWith("real") ? "bg-neon" : "bg-cyan-neon"} opacity-80`} style={{ width: `${a.fillPct}%` }} />
                      </div>
                      <span className={`w-16 shrink-0 text-right ${a.neverFed ? "text-amber-neon" : a.starved ? "text-danger-neon" : "text-ink-3"}`}>{a.neverFed ? "idle" : a.starved ? "STARVED" : `fed ${ago(a.lastFedAt)}`}</span>
                      <span className={`w-14 shrink-0 text-right ${a.netUsd > 0 ? "text-neon" : a.netUsd < 0 ? "text-danger-neon" : "text-ink-3"}`}>{a.n ? usd(a.netUsd) : "—"}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/5 px-1 pt-1.5 font-terminal text-[9px]">
                  {([
                    ["ADJ", tel.wiring.adjudicator],
                    ["LINK", tel.wiring.realLink],
                    ["CLOSE", tel.wiring.outcomeClosure],
                    ["SWEEP", tel.wiring.paperSweep],
                  ] as const).map(([k, w]) => (
                    <span key={k} className={w.ok ? "text-neon" : "text-danger-neon"} title={w.detail}>
                      {w.ok ? "✓" : "✗"} {k}
                    </span>
                  ))}
                  <span className={tel.wiring.llm.ok ? "text-neon" : "text-amber-neon"} title={tel.wiring.llm.detail}>
                    {tel.wiring.llm.ok ? "✓" : "~"} LLM
                  </span>
                  <span className="tabular-nums text-ink-3" title={`${tel.wiring.pipeline.unlinkedPassStale} stale unlinked PASS verdicts · ${tel.wiring.pipeline.pendingRealOutcomes} awaiting closure · ${tel.wiring.pipeline.verdicts24h} verdicts/24h · ${tel.wiring.pipeline.pendingPapers} papers open`}>
                    leak {tel.wiring.pipeline.unlinkedPassStale} · closing {tel.wiring.pipeline.pendingRealOutcomes} · v24h {tel.wiring.pipeline.verdicts24h}
                  </span>
                  {tel.alerts.length > 0 && (
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 font-bold ${tel.alerts.some((a) => a.level === "warn") ? "bg-amber-neon/10 text-amber-neon" : "bg-white/5 text-ink-3"}`}
                      title={tel.alerts.map((a) => `${a.level.toUpperCase()} · ${new Date(a.at).toISOString().slice(11, 16)}Z · ${a.text}`).join("\n")}
                    >
                      {tel.alerts.length} alert{tel.alerts.length === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </BentoCard>
  );
}
