"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { AlarmClock, Hourglass } from "lucide-react";
import { usePulse } from "@/hooks/usePulse";
import { useAlerts } from "@/store/alerts";
import { playTtlUrgency, playTtlWarning } from "@/lib/sounds";
import { ttlRemainingMs } from "@/lib/format";

/**
 * TtlSentinel — headless bridge that watches open positions and escalates
 * through TWO TTL tiers:
 *
 *   ⏳ WARN   @ T-5min  → calm amber toast + soft double-ping (heads-up)
 *   🚨 CRIT   @ T-60s   → hot amber toast + triple urgency blip
 *
 * Each tier fires once per signal id (tracked per-tier); entries reset when
 * the signal resolves or leaves the open window, so redeploys re-arm.
 * Mounted once in the app shell — renders nothing.
 */

const OPEN_STATUSES = new Set(["ACTIVE", "TP1", "TP2"]);

/** tier thresholds (ms before expiry) */
const WARN_MS = 5 * 60_000;
const CRIT_MS = 60_000;

/** shared glass toast shell — tier supplies color + copy */
function TtlToast({
  tier,
  symbol,
  secs,
  onDismiss,
}: {
  tier: "warn" | "crit";
  symbol: string;
  secs: number;
  onDismiss: () => void;
}) {
  const c = tier === "crit" ? "#ffb347" : "#e8c468";
  const crit = tier === "crit";
  return (
    <button
      type="button"
      aria-label={`TTL ${tier === "crit" ? "critical" : "warning"}: ${symbol} expires in ${secs >= 90 ? `${Math.round(secs / 60)} minutes` : `${secs} seconds`}`}
      onClick={onDismiss}
      className="pointer-events-auto flex w-[min(92vw,380px)] cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-left backdrop-blur-xl shadow-[0_8px_32px_-8px_rgba(0,0,0,0.85)] transition-transform hover:scale-[1.015]"
      style={{
        borderColor: crit ? "rgba(255,179,71,0.6)" : "rgba(232,196,104,0.42)",
        background: crit
          ? "linear-gradient(135deg, rgba(255,179,71,0.12), rgba(7,11,14,0.96) 55%)"
          : "linear-gradient(135deg, rgba(232,196,104,0.07), rgba(7,11,14,0.96) 55%)",
      }}
    >
      <span
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${crit ? "anim-pulse-dot" : ""}`}
        style={{ borderColor: crit ? "rgba(255,179,71,0.6)" : "rgba(232,196,104,0.4)", color: c, background: crit ? "rgba(255,179,71,0.10)" : "rgba(232,196,104,0.06)" }}
      >
        {crit ? <AlarmClock size={14} /> : <Hourglass size={13} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className="font-terminal text-[10px] font-bold uppercase tracking-[0.2em]"
            style={{ color: c }}
          >
            {crit ? "TTL CRITICAL — FINAL 60S" : "TTL WARNING — 5M TO EXPIRY"}
          </span>
          <span className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-terminal text-[9px] font-bold tracking-[0.14em] text-ink">
            {symbol}
          </span>
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-ink-2">
          {crit
            ? `Expires in ${secs}s — plan your exit now.`
            : `${Math.round(secs / 60)}m until expiry — tighten stops or take profit early.`}
        </span>
      </span>
      <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c }} />
    </button>
  );
}

export function TtlSentinel() {
  const { data } = usePulse(3000);
  /** per-tier fired map: signalId → expiresAt the tier fired for. An expiry-gate
   *  TTL extension moves expiresAt forward — the map re-arms automatically (v6.1). */
  const firedWarnRef = useRef<Map<string, string>>(new Map());
  const firedCritRef = useRef<Map<string, string>>(new Map());
  /** clock guard: TTL math is meaningless before the first client tick */
  const bootedRef = useRef(false);

  useEffect(() => {
    if (!data?.signals?.length) return;
    const now = Date.now();
    if (!bootedRef.current) {
      // first load — arm sentinels for anything already inside a threshold
      // WITHOUT firing (no toast storm on mount/refresh)
      for (const s of data.signals) {
        if (!OPEN_STATUSES.has(s.status) || s.closedAt) continue;
        const remaining = ttlRemainingMs(s.expiresAt, now);
        if (remaining <= CRIT_MS) firedCritRef.current.set(s.id, s.expiresAt);
        if (remaining <= WARN_MS) firedWarnRef.current.set(s.id, s.expiresAt);
      }
      bootedRef.current = true;
      return;
    }

    const open = data.signals.filter((s) => OPEN_STATUSES.has(s.status) && !s.closedAt);
    const openIds = new Set(open.map((s) => s.id));
    // prune resolved ids so a redeployed symbol re-arms cleanly
    for (const id of firedWarnRef.current.keys()) if (!openIds.has(id.split("|")[0]!)) firedWarnRef.current.delete(id);
    for (const id of firedCritRef.current.keys()) if (!openIds.has(id.split("|")[0]!)) firedCritRef.current.delete(id);

    const state = useAlerts.getState();
    const soundAllowed = state.soundEnabled && !state.alertsMuted;
    const toastAllowed = !state.alertsMuted;
    const warnEnabled = state.ttlWarnEnabled;

    for (const s of open) {
      const remaining = ttlRemainingMs(s.expiresAt, now);
      if (remaining <= 0 || remaining > WARN_MS) continue;

      /* ── CRIT tier: final 60s ───────────────────────────── */
      const critKey = `${s.id}|${s.expiresAt}`;
      if (remaining <= CRIT_MS && firedCritRef.current.get(critKey) !== s.expiresAt) {
        firedCritRef.current.set(critKey, s.expiresAt);
        if (soundAllowed) playTtlUrgency();
        if (!toastAllowed) continue;
        const secs = Math.max(1, Math.round(remaining / 1000));
        toast.custom(
          () => <TtlToast tier="crit" symbol={s.symbol} secs={secs} onDismiss={() => toast.dismiss()} />,
          { duration: 5200 }
        );
        continue;
      }

      /* ── WARN tier: T-5min heads-up ─────────────────────── */
      if (remaining > CRIT_MS && firedWarnRef.current.get(critKey) !== s.expiresAt) {
        firedWarnRef.current.set(critKey, s.expiresAt);
        if (!warnEnabled) continue;
        if (soundAllowed) playTtlWarning();
        if (!toastAllowed) continue;
        const secs = Math.max(61, Math.round(remaining / 1000));
        toast.custom(
          () => <TtlToast tier="warn" symbol={s.symbol} secs={secs} onDismiss={() => toast.dismiss()} />,
          { duration: 4600 }
        );
      }
    }
  }, [data]);

  return null;
}
