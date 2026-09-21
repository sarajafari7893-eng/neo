"use client";

/**
 * SensorBusDormantStrip — v10.18 PHASE-1 CONSOLIDATION (operator option A,
 * 2026-09-24). Replaces the SMART-MONEY flow matrix / VOL-ONSET radar /
 * VOL-CAUSE forensics desk with an honest dormancy notice: the modules are
 * NOT deleted — their components stay in the codebase and the gate-critical
 * inputs they share (vol-forecast, flow gating, klines, liq stream) remain
 * live inside the engine. Restore = flip `sensorBusDormant` to false in
 * src/config/engine-flags.json and re-render this section (the strip hides
 * itself automatically when the flag is off).
 */
import { Radar, Waves, Activity, Archive, RotateCcw } from "lucide-react";
import { BentoCard, LiveDot } from "@/components/shared/primitives";
import { engineFlags } from "@/lib/engine-flags";

const DORMANT_MODULES = [
  { icon: Activity, name: "SMART-MONEY FLOW MATRIX", note: "display + /api/flow/matrix polling suspended" },
  { icon: Radar, name: "VOL-ONSET RADAR", note: "display card suspended · onset gate input stays live" },
  { icon: Waves, name: "VOL-CAUSE FORENSICS", note: "display + heartbeat capture suspended" },
] as const;

export default function SensorBusDormantStrip() {
  if (!engineFlags().sensorBusDormant) return null; // flag off → sensors render again upstream
  return (
    <BentoCard className="mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Archive className="h-4 w-4 text-amber-neon" aria-hidden />
          <span className="label-tech">Sensor bus // dormant — archived, not deleted</span>
          <LiveDot tone="amber" />
        </div>
        <span className="font-terminal text-[10px] tracking-[0.14em] text-ink-3">v10.18 · PHASE-1 CONSOLIDATION</span>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {DORMANT_MODULES.map((m) => (
          <div key={m.name} className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <div className="flex items-center gap-2">
              <m.icon className="h-3.5 w-3.5 shrink-0 text-amber-neon/80" aria-hidden />
              <p className="font-terminal text-[10px] tracking-[0.14em] text-ink-2">{m.name}</p>
            </div>
            <p className="mt-1.5 text-[11px] leading-snug text-ink-3">{m.note}</p>
          </div>
        ))}
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-3">
        <RotateCcw className="mt-0.5 h-3 w-3 shrink-0 text-amber-neon/70" aria-hidden />
        <span>
          دو-مرکزی سپر شده: MARKET MATRIX (کشف) → PUMP/DUMP RADAR (تشخیص اصلی، مهارشده) → deploy از دروازه گیت‌ها. بازگردانی
          سنسورها فقط با یک فلگ:{" "}
          <code className="rounded bg-white/5 px-1 font-terminal text-[10px]">engine-flags.sensorBusDormant → false</code>
        </span>
      </p>
    </BentoCard>
  );
}
