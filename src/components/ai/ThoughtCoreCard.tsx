"use client";

import { useCallback, useEffect, useState } from "react";
import { Brain, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { BentoCard, NeonBadge } from "@/components/shared/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ── v6.7.4 THOUGHT-CORE — operator switch for the AI reasoning mode ──
   ON  = judgment channels (analyst chat · card brief · governor) reason
         step-by-step before answering; deep-learn stays thought.
   OFF = everything back to fast mode. Symbol-scan is fast either way
         (bulk structural scans, latency-sensitive by contract). */

interface AiSettingsResponse {
  ai: { thoughtMode: number };
  describe: string;
  channels: Record<string, boolean>;
}

const CHANNEL_LABELS: ReadonlyArray<[keyof AiSettingsResponse["channels"], string, string]> = [
  ["analyst-chat", "ANALYST CHAT", "depth pays on operator Q&A"],
  ["card-brief", "CARD BRIEF", "HOLD/CLOSE adjudication"],
  ["governor", "GOVERNOR", "strategy decisions"],
  ["deep-learn", "DEEP-LEARN", "always THOUGHT"],
  ["symbol-scan", "SYMBOL SCAN", "always FAST"],
];

export default function ThoughtCoreCard() {
  const [data, setData] = useState<AiSettingsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/settings", { cache: "no-store" });
      if (!res.ok) throw new Error(`settings ${res.status}`);
      setData((await res.json()) as AiSettingsResponse);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (!data || busy) return;
    const next = data.ai.thoughtMode === 1 ? 0 : 1;
    setBusy(true);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thoughtMode: next }),
      });
      if (!res.ok) throw new Error(`toggle ${res.status}`);
      setData((await res.json()) as AiSettingsResponse);
      toast.success(next === 1 ? "THOUGHT-CORE engaged — the AI now reasons before answering." : "THOUGHT-CORE off — fast mode restored.");
    } catch {
      toast.error("Toggle failed — AI settings unreachable.");
    } finally {
      setBusy(false);
    }
  }, [busy, data]);

  const on = data?.ai.thoughtMode === 1;

  return (
    <BentoCard tone="violet" className="p-4 sm:p-4" data-testid="thought-core-card">
      <div className="flex flex-wrap items-center gap-3">
        <div
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-md border transition-colors",
            on
              ? "border-[rgba(178,107,255,0.45)] bg-[rgba(178,107,255,0.14)] text-violet-neon"
              : "border-white/10 bg-white/[0.03] text-ink-3"
          )}
          aria-hidden
        >
          <Brain className="size-4.5" />
        </div>

        <div className="min-w-[10rem]">
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.18em] text-ink">THOUGHT CORE</h3>
          <p className="label-tech mt-0.5">AI reasoning mode — step-by-step deliberation before every judgment</p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {data && (
            <NeonBadge tone={on ? "violet" : "muted"} glow={on} className="px-2.5 py-1">
              {on ? "THOUGHT MODE: ON" : "THOUGHT MODE: OFF"}
            </NeonBadge>
          )}
          {loadError && <NeonBadge tone="amber">SETTINGS UNREACHABLE</NeonBadge>}
          <Button
            type="button"
            onClick={() => void toggle()}
            disabled={busy || !data}
            aria-label={on ? "Disable thought mode" : "Enable thought mode"}
            aria-pressed={on}
            className={cn(
              "h-11 border font-terminal text-[11px] font-bold uppercase tracking-[0.16em]",
              "focus-visible:ring-violet-neon/60",
              on
                ? "border-white/15 bg-white/[0.04] text-ink-2 hover:bg-white/[0.09]"
                : "border-[rgba(178,107,255,0.45)] bg-[rgba(178,107,255,0.16)] text-violet-neon hover:bg-[rgba(178,107,255,0.3)]"
            )}
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Zap className="size-4" aria-hidden />}
            {busy ? "APPLYING…" : on ? "REVERT TO FAST" : "ENGAGE THOUGHT"}
          </Button>
        </div>
      </div>

      {/* per-channel plan */}
      <div className="mt-3 flex flex-wrap gap-2">
        {CHANNEL_LABELS.map(([ch, label, note]) => {
          const thought = data ? (data.ai.thoughtMode === 1 && data.channels[ch]) : ch === "deep-learn";
          return (
            <span
              key={ch}
              title={note}
              className={cn(
                "inline-flex min-h-8 items-center gap-1.5 rounded border px-2.5 font-terminal text-[10px] font-bold uppercase tracking-[0.12em]",
                thought
                  ? "border-[rgba(178,107,255,0.4)] bg-[rgba(178,107,255,0.1)] text-violet-neon"
                  : "border-white/10 bg-white/[0.03] text-ink-3"
              )}
            >
              <Brain className={cn("size-3", !thought && "opacity-40")} aria-hidden />
              {label} · {thought ? "THOUGHT" : "FAST"}
            </span>
          );
        })}
      </div>

      {data && <p className="label-tech mt-2.5">{data.describe}</p>}
    </BentoCard>
  );
}
