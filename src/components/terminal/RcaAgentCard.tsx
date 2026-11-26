"use client";

// ── Task 81 RCA-AGENT CARD (operator question «آیا نیاز به یک ایجنت برای
// ریشه‌یابی و فیکس (LIVE و راستی‌آزمایی‌شده) لازم است؟») ─────────────────────
// The answer rendered live: YES — this card IS the agent's cockpit. It polls
// /api/rca (GET), auto-runs the full mission suite when the latest report is
// from a previous Tehran day or older than 6h, and can trigger a run on
// demand (POST). Every finding carries hard evidence and is VERIFIED only
// when reproduced from ≥2 independent sources; the safe-fix class (journal
// rotation, report pruning) is applied AND re-verified inside the run.

import { useCallback, useEffect, useState } from "react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { RcaReport } from "@/lib/rca-agent";

const VERDICT_STYLE: Record<RcaReport["verdict"], { chip: string; label: string }> = {
  HEALTHY: { chip: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "HEALTHY" },
  WATCH: { chip: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "WATCH" },
  "ACTION-NEEDED": { chip: "bg-rose-500/15 text-rose-300 border-rose-500/30", label: "ACTION NEEDED" },
};

const SEV_STYLE: Record<string, string> = {
  P0: "bg-rose-600/20 text-rose-200 border-rose-600/40",
  P1: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  P2: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
};

function ageFa(ms: number | null): string {
  if (ms === null) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} دقیقه پیش`;
  return `${Math.round(m / 60)} ساعت پیش`;
}

export default function RcaAgentCard() {
  const [report, setReport] = useState<RcaReport | null>(null);
  const [stale, setStale] = useState(false);
  const [ageMs, setAgeMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pull = useCallback(async () => {
    try {
      const res = await fetch("/api/rca", { cache: "no-store" });
      if (res.ok) {
        const j = (await res.json()) as { report: RcaReport | null; stale: boolean; ageMs: number | null; running: boolean };
        setReport(j.report);
        setStale(j.stale);
        setAgeMs(j.ageMs);
        setRunning(j.running);
        setErr(null);
        return j;
      }
      setErr(`HTTP ${res.status}`);
    } catch {
      setErr("network");
    }
    return null;
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/rca", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run" }) });
      if (res.ok) {
        const j = (await res.json()) as { report: RcaReport };
        setReport(j.report);
        setStale(false);
        setAgeMs(0);
        setErr(null);
      } else {
        setErr(`HTTP ${res.status}`);
      }
    } catch {
      setErr("network");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      // GET self-heals: a stale report triggers a fresh run server-side
      // (same pattern as the pulse's self-driving reports). The POST button
      // stays for explicit operator-triggered runs (key/session-gated).
      const j = await pull();
      if (cancelled) return;
      if (j?.running) setTimeout(() => void pull(), 4000);
    };
    void boot();
    const id = setInterval(() => void pull(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pull]);

  const vd = report ? VERDICT_STYLE[report.verdict] : null;
  const p0 = report?.findings.filter((f) => f.sev === "P0") ?? [];
  const p1 = report?.findings.filter((f) => f.sev === "P1") ?? [];
  const p2 = report?.findings.filter((f) => f.sev === "P2") ?? [];

  return (
    <BentoCard className="lg:col-span-7">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="label-tech">RCA agent // ایجنت ریشه‌یابی و فیکس (زنده)</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-2">
          {vd && <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${vd.chip}`}>{vd.label}</span>}
          <button
            onClick={() => void run()}
            disabled={running}
            className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold text-violet-200 transition hover:bg-violet-500/20 disabled:opacity-50"
          >
            {running ? "در حال اجرا…" : "اجرای مأموریت"}
          </button>
        </div>
      </div>

      {err && <div className="mb-2 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300">{err}</div>}

      <p className="mb-2.5 text-[11px] leading-relaxed text-zinc-400">
        بله — ایجنت لازم بود و اکنون زنده است: پنج مأموریت (کالبدشکافی PnL · ممیزی گیت · ریل‌های بانکرول · خط داده · سنتینل)، هر یافته با سند سخت (تعداد ردیف/ژورنال/فایل) و تنها با بازتولید از ≥۲ منبع مستقل «VERIFIED» می‌شود؛ کلاس امنِ فیکس (چرخش ژورنال/هرس گزارش) خودکار اجرا و بلافاصله راستی‌آزمایی می‌شود — فیکس‌های کدی فقط «پیشنهاد» می‌مانند (ناظر، دامنهٔ معاملاتی را دست نمی‌زند).
      </p>

      {report ? (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
            <span>
              آخرین اجرا: <b className="text-zinc-300">{ageFa(ageMs)}</b> · {report.dayKey} · {(report.durationMs / 1000).toFixed(1)}s
            </span>
            {stale && <span className="text-amber-300">گزارش کهنه است — اجرای خودکار…</span>}
          </div>

          <div className="mb-2 grid grid-cols-3 gap-2 text-center">
            {[
              { k: "P0 راستی‌آزمایی‌شده", v: String(p0.length), tone: p0.length ? "text-rose-300" : "text-emerald-300" },
              { k: "P1", v: String(p1.length), tone: p1.length ? "text-amber-300" : "text-zinc-100" },
              { k: "P2 / اطلاعاتی", v: String(p2.length), tone: "text-zinc-300" },
            ].map((x) => (
              <div key={x.k} className="rounded bg-white/[0.03] px-1 py-1.5">
                <div className={`text-[13px] font-bold ${x.tone}`}>{x.v}</div>
                <div className="text-[9px] uppercase tracking-wide text-zinc-500">{x.k}</div>
              </div>
            ))}
          </div>

          {report.missions.pnl && (
            <div className="mb-2 rounded border border-white/5 bg-black/30 px-2 py-1.5 text-[10px] leading-relaxed text-zinc-400">
              کالبدشکافی امروز: {report.missions.pnl.settledToday} ستل · خام <b className={report.missions.pnl.rawNet < 0 ? "text-rose-300" : "text-emerald-300"}>{report.missions.pnl.rawNet >= 0 ? "+" : "−"}${Math.abs(report.missions.pnl.rawNet).toFixed(2)}</b> · مبنای 1000{" "}
              <b className={report.missions.pnl.basisNet < 0 ? "text-rose-300" : "text-emerald-300"}>{report.missions.pnl.basisNet >= 0 ? "+" : "−"}${Math.abs(report.missions.pnl.basisNet).toFixed(2)}</b>
              {report.missions.pnl.feeDragPct !== null ? <> · فیس‌درگ {report.missions.pnl.feeDragPct}٪</> : null}
              {report.missions.pnl.postGate.basisNet !== null ? (
                <>
                  {" "}
                  · پنجرهٔ پس از گیت: {report.missions.pnl.postGate.deploys} دیپلوی،{" "}
                  <b className={(report.missions.pnl.postGate.basisNet ?? 0) < 0 ? "text-amber-300" : "text-emerald-300"}>{report.missions.pnl.postGate.basisNet! >= 0 ? "+" : "−"}${Math.abs(report.missions.pnl.postGate.basisNet ?? 0).toFixed(2)}</b> مبنایی
                </>
              ) : null}
            </div>
          )}

          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
            {report.findings.length === 0 && <div className="rounded border border-emerald-500/20 bg-emerald-500/[0.06] px-2 py-1.5 text-[10px] text-emerald-300">هیچ یافتهٔ راستی‌آزمایی‌شده‌ای در این اجرا — سیستم پاک گزارش شد.</div>}
            {report.findings.map((f) => (
              <div key={f.id} className="rounded border border-white/5 bg-white/[0.02] px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className={`rounded border px-1 py-0.5 text-[9px] font-bold ${SEV_STYLE[f.sev]}`}>{f.sev}</span>
                  <span className="text-[9px] uppercase tracking-wide text-zinc-500">{f.mission}</span>
                  <span className={`rounded border px-1 py-0.5 text-[9px] ${f.status === "VERIFIED" ? "border-emerald-500/30 text-emerald-300" : "border-zinc-500/30 text-zinc-400"}`}>{f.status}</span>
                  {f.fix?.kind === "AUTO" && f.fix.verified && <span className="rounded border border-violet-500/30 text-[9px] text-violet-300">FIX VERIFIED</span>}
                </div>
                <div className="mt-1 text-[11px] font-bold text-zinc-100">{f.title}</div>
                <div className="mt-0.5 text-[10px] leading-relaxed text-zinc-500">{f.evidence}</div>
                {f.fix && <div className="mt-0.5 text-[9px] text-zinc-500">{f.fix.kind === "AUTO" ? "فیکس خودکار:" : "پیشنهاد:"} {f.fix.action}</div>}
              </div>
            ))}
          </div>

          {report.fixes.length > 0 && (
            <div className="mt-2 text-[9px] text-zinc-500">
              فیکس‌های اجراشده در این چرخه: {report.fixes.map((x) => `${x.action}${x.verified ? " ✓" : " ✗"}`).join(" · ")}
            </div>
          )}
        </>
      ) : (
        <div className="rounded border border-white/5 bg-black/30 px-2 py-3 text-center text-[10px] text-zinc-500">{running ? "اولین مأموریت در حال اجراست…" : "هنوز گزارشی نیست — دکمهٔ اجرای مأموریت را بزن"}</div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <NeonBadge tone="muted">evidence-first · dual-source</NeonBadge>
        <NeonBadge tone="violet">auto-run if stale &gt; 6h</NeonBadge>
      </div>
    </BentoCard>
  );
}
