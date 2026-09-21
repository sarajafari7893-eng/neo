"use client";

import { useEffect, useState } from "react";
import { Radar } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";
import type { FlowBoardDTO, FlowScanSymbolDTO, FlowScanTfDTO } from "@/lib/api-types";

/* ── v8.0 FLOW SCANNER card — the multi-TF board, EPOCH-2 ──
 * Self-polls /api/flows (30s). Rows = symbols sorted by |netScore|; columns =
 * the four timeframes with their HTF weights. Cell tint encodes direction and
 * conviction; SWEEP/CHoCH prints get their own chips. Zero fetched → honest
 * "warming up" state (first sweep populates the board in ~2min). */

const TFS = ["4h", "1h", "15m", "5m"] as const;
const TF_WEIGHT: Record<string, string> = { "4h": "×0.35", "1h": "×0.30", "15m": "×0.20", "5m": "×0.15" };
const NEON = "0, 255, 163";
const DANGER = "255, 77, 94";

function tint(score: number): string {
  const a = Math.min(0.22, (Math.abs(score) / 100) * 0.22 + 0.03);
  return score > 0 ? `rgba(${NEON}, ${a})` : `rgba(${DANGER}, ${a})`;
}

function structShort(s: FlowScanTfDTO["structure"]): string {
  if (s === "RANGE") return "···";
  return s.replace("SWEEP_", "SWP ").replace("BOS_", "BOS ").replace("CHOH_", "CHoCH ");
}

function TfCell({ t }: { t: FlowScanTfDTO | undefined }) {
  if (!t) {
    return <div className="flex h-11 items-center justify-center rounded-md border border-white/5 font-terminal text-[10px] text-ink-3">—</div>;
  }
  const biasText = t.bias === "LONG" ? "text-neon" : t.bias === "SHORT" ? "text-danger-neon" : "text-ink-2";
  return (
    <div
      className="flex h-11 flex-col items-center justify-center rounded-md border border-white/5 px-1 font-terminal leading-tight"
      style={{ background: tint(t.score) }}
      title={`${t.tf}: score ${t.score} · trend ${t.trend} · ${t.structure} · CVD ${t.cvdPct ?? "n/a"}% · volZ ${t.volZ ?? "n/a"}`}
    >
      <span className={`text-[11px] font-bold ${biasText}`}>{t.score > 0 ? "+" : ""}{t.score}</span>
      <span className="text-[9px] tracking-wide text-ink-3">
        {structShort(t.structure)}
        {t.sweep ? " ⌁" : ""}
      </span>
    </div>
  );
}

function SymbolRow({ r }: { r: FlowScanSymbolDTO }) {
  const netText = r.netBias === "LONG" ? "text-neon" : r.netBias === "SHORT" ? "text-danger-neon" : "text-ink-2";
  const byTf = new Map(r.tfs.map((t) => [t.tf, t]));
  return (
    <div className="grid grid-cols-[92px_64px_1fr] items-center gap-2 rounded-lg px-1 py-1 transition hover:bg-white/[0.03]">
      <div className="min-w-0">
        <div className="truncate font-terminal text-[11px] font-bold text-ink">{r.symbol.replace("USDT", "")}</div>
        <div className="font-terminal text-[9px] text-ink-3">
          {r.oiDelta1h !== null ? `OI ${r.oiDelta1h >= 0 ? "+" : ""}${r.oiDelta1h.toFixed(1)}%/1h` : "OI n/a"}
          {r.funding8h !== null ? ` · F ${r.funding8h >= 0 ? "+" : ""}${r.funding8h.toFixed(3)}%` : ""}
        </div>
      </div>
      <div className="flex flex-col items-start">
        <span className={`font-terminal text-[12px] font-bold ${netText}`}>
          {r.netScore > 0 ? "+" : ""}
          {r.netScore}
        </span>
        <span className={`font-terminal text-[9px] tracking-wider ${netText}`}>
          {r.netBias === "NEUTRAL" ? "FLAT" : `${r.netBias} ${r.alignment}/4`}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {TFS.map((tf) => (
          <TfCell key={tf} t={byTf.get(tf)} />
        ))}
      </div>
    </div>
  );
}

export default function FlowScannerCard() {
  const [board, setBoard] = useState<FlowBoardDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const res = await fetch("/api/flows", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as FlowBoardDTO;
        if (alive) setBoard(data);
      } catch {
        /* next tick retries */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    void pull();
    const id = setInterval(pull, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const rows = board?.rows.slice(0, 12) ?? [];

  return (
    <BentoCard>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Radar className="h-4 w-4 text-cyan-neon" aria-hidden />
          <span className="label-tech">Flow scanner // multi-TF board</span>
          <LiveDot />
        </div>
        <div className="flex items-center gap-2">
          <NeonBadge tone="cyan">{board?.coverage ?? 0} SYMBOLS</NeonBadge>
          <span className="hidden font-terminal text-[9px] tracking-[0.14em] text-ink-3 sm:inline">HTF CARRIES THE BIAS — 4h ×0.35 · 1h ×0.30 · 15m ×0.20 · 5m ×0.15</span>
        </div>
      </div>

      {(!loaded || rows.length === 0) && (
        <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-cyan-neon/25">
          <Radar className="h-5 w-5 animate-pulse text-cyan-neon/60" aria-hidden />
          <span className="label-tech">Scanner warming up — first sweep populates the board in ~2min</span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="grid grid-cols-[92px_64px_1fr] gap-2 px-1 pb-1.5 font-terminal text-[9px] uppercase tracking-[0.14em] text-ink-3">
            <span>symbol</span>
            <span>net board</span>
            <div className="grid grid-cols-4 gap-1.5">
              {TFS.map((tf) => (
                <span key={tf} className="text-center">
                  {tf} <span className="text-ink-3/60">{TF_WEIGHT[tf]}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="max-h-[340px] space-y-1 overflow-y-auto pr-1">
            {rows.map((r) => (
              <SymbolRow key={r.symbol} r={r} />
            ))}
          </div>
          <p className="mt-2 font-terminal text-[9px] leading-relaxed tracking-wide text-ink-3">
            BOS = break of structure (trend continuation) · CHoCH = change of character (reversal) · SWP = liquidity sweep (stop-run rejection) · ⌁ sweep print · closed bars only, no lookahead
          </p>
        </>
      )}
    </BentoCard>
  );
}
