"use client";

import { useState } from "react";
import { usePulse, useNow, useMounted } from "@/hooks/usePulse";
import { fmtClockLocal, localTzLabel } from "@/lib/format";
import { LiveDot } from "@/components/shared/primitives";
import { LogoMark } from "@/components/brand/Logo";
import { BRAND_TERMINAL, APP_ENGINE_LINE } from "@/lib/brand";
import { Archive, Loader2, Check } from "lucide-react";
import { toast } from "sonner";

export function Footer() {
  const { data } = usePulse(15000);
  const now = useNow(1000);
  const mounted = useMounted();
  const ts = data?.ts ?? now;
  const [snap, setSnap] = useState<{ running: boolean; file: string | null }>({ running: false, file: null });

  const runBackup = async () => {
    if (snap.running) return;
    setSnap({ running: true, file: null });
    try {
      const res = await fetch("/api/backup", { method: "POST" });
      if (!res.ok) throw new Error(`backup ${res.status}`);
      const json = (await res.json()) as { log: string; manifest?: { file: string; sizeHuman: string; snapshots: number } };
      setSnap({ running: false, file: json.manifest?.file ?? "snapshot" });
      toast.success(`SNAPSHOT saved — ${json.manifest?.file ?? "zip"} (${json.manifest?.sizeHuman ?? "?"}) · ${json.manifest?.snapshots ?? "?"} retained`);
      setTimeout(() => setSnap({ running: false, file: null }), 8000);
    } catch {
      setSnap({ running: false, file: null });
      toast.error("Snapshot failed — check dev.log");
    }
  };

  return (
    <footer className="mt-auto w-full border-t border-[rgb(var(--neon-rgb)/0.12)] bg-[rgba(5,8,10,0.85)] backdrop-blur-xl pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
          {/* brand */}
          <div className="flex items-center gap-3">
            <LogoMark size={26} />
            <div className="leading-none">
              <div className="font-terminal text-xs font-bold tracking-[0.18em]">
                {BRAND_TERMINAL.head}<span className="text-neon">{BRAND_TERMINAL.sep}</span>{BRAND_TERMINAL.tail}
              </div>
              <div className="label-tech mt-1">LIVE BINANCE USDT-M · RESEARCH TERMINAL</div>
            </div>
          </div>

          {/* meta */}
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-terminal text-[10px] tracking-[0.12em] text-ink-3">
            <span className="flex items-center gap-1.5">
              <LiveDot />
              FEED <span className="text-ink-2">{fmtClockLocal(ts)}</span> <span className="text-ink-3/70">{mounted ? localTzLabel() : ""}</span>
            </span>
            <span>
              LATENCY <span className="text-neon">{data?.feed?.latencyMs != null ? `${data.feed.latencyMs}MS` : "--"}</span>
            </span>
            <span className="hidden sm:inline">
              DOMAIN <span className="text-ink-2">{data?.feed?.universe ? `${data.feed.universe.tracked}/${data.feed.universe.poolTotal || "~"} PERPS` : "--"}</span>
            </span>
            <span className="hidden sm:inline">
              SOURCE <span className="text-ink-2">BINANCE MULTI-PLANE</span>
            </span>
            <span className="hidden sm:inline">
              ENGINE <span className="text-violet-neon">{APP_ENGINE_LINE}</span>
            </span>
            <button
              type="button"
              onClick={() => void runBackup()}
              disabled={snap.running}
              title="Zip the full project state (source + schema + DB + worklog) into backups/ — sandbox-rollback safety net"
              className="flex min-h-9 items-center gap-1.5 rounded border border-[rgba(255,179,71,0.35)] px-2.5 py-1 font-terminal text-[9px] font-bold uppercase tracking-[0.14em] text-amber-neon transition-colors hover:bg-[rgba(255,179,71,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-neon/60 disabled:opacity-50"
            >
              {snap.running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : snap.file ? <Check className="size-3" aria-hidden /> : <Archive className="size-3" aria-hidden />}
              {snap.running ? "ZIPPING…" : snap.file ? "SAVED" : "SNAPSHOT"}
            </button>
          </div>

          {/* disclaimer */}
          <p className="max-w-xs text-center font-terminal text-[9px] leading-relaxed text-ink-3 md:text-right">
            NOT FINANCIAL ADVICE. MARKET DATA VIA BINANCE PUBLIC APIS (MULTI-PLANE LADDERS) · PAPER TRADING ONLY.
          </p>
        </div>
      </div>
    </footer>
  );
}
