"use client";

import { motion } from "framer-motion";
import { Wallet, Gauge, Layers, PiggyBank, TrendingUp } from "lucide-react";
import { BentoCard } from "@/components/shared/primitives";
import { usePulse } from "@/hooks/usePulse";
import { fmtUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * AccountBar — paper trading account strip:
 * BALANCE / EQUITY / UNREALIZED / EXPOSURE / FREE MARGIN + margin-usage gauge.
 */
export function AccountBar() {
  const { data } = usePulse();
  const acc = data?.stats.account;
  if (!acc) {
    return <div className="bento h-[86px] animate-pulse" aria-hidden />;
  }

  const up = acc.equity >= acc.startBalance;
  const pnlTotal = acc.equity - acc.startBalance;
  const roi = ((pnlTotal / acc.startBalance) * 100).toFixed(2);
  const marginPct = Math.min(100, Math.max(0, acc.marginUsedPct));
  const gaugeTone = marginPct > 75 ? "bg-danger-neon" : marginPct > 45 ? "bg-amber-neon" : "bg-neon";

  return (
    <BentoCard className="overflow-hidden" delay={0.05}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {/* equity — hero cell */}
        <div className="col-span-2 flex items-center gap-3 sm:col-span-3 lg:col-span-2">
          <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border", up ? "border-[rgb(var(--neon-rgb)/0.35)] bg-[rgb(var(--neon-rgb)/0.08)]" : "border-[rgba(255,77,94,0.35)] bg-[rgba(255,77,94,0.08)]")}>
            <Wallet size={17} className={up ? "text-neon" : "text-danger-neon"} aria-hidden />
          </div>
          <div className="min-w-0">
            <div className="label-tech">PAPER EQUITY {up ? "▲" : "▼"} {roi}%</div>
            <motion.div
              key={acc.equity}
              initial={{ opacity: 0.4, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn("truncate font-terminal text-xl font-extrabold tabular-nums tracking-tight", up ? "text-neon neon-text" : "text-danger-neon neon-text-danger")}
            >
              {fmtUsd(acc.equity, false)}
            </motion.div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1 label-tech"><Layers size={9} aria-hidden /> BALANCE</div>
          <div className="mt-1 truncate font-terminal text-sm font-bold tabular-nums text-ink">{fmtUsd(acc.balance, false)}</div>
          <div className="font-terminal text-[9px] tracking-[0.14em] text-ink-3">START {fmtUsd(acc.startBalance)}</div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1 label-tech"><TrendingUp size={9} aria-hidden /> UNREALIZED</div>
          <div className={cn("mt-1 truncate font-terminal text-sm font-bold tabular-nums", acc.unrealizedPnl >= 0 ? "text-neon" : "text-danger-neon")}>
            {acc.unrealizedPnl >= 0 ? "+" : ""}{fmtUsd(acc.unrealizedPnl, false)}
          </div>
          <div className="font-terminal text-[9px] tracking-[0.14em] text-ink-3">{acc.openPositions} POSITIONS</div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1 label-tech"><Gauge size={9} aria-hidden /> EXPOSURE</div>
          <div className="mt-1 truncate font-terminal text-sm font-bold tabular-nums text-violet-neon">{fmtUsd(acc.exposureUsd)}</div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/5">
            <motion.div
              className={cn("h-full rounded-full", gaugeTone)}
              initial={{ width: 0 }}
              animate={{ width: `${marginPct}%` }}
              transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1 label-tech"><PiggyBank size={9} aria-hidden /> FREE MARGIN</div>
          <div className="mt-1 truncate font-terminal text-sm font-bold tabular-nums text-cyan-neon">{fmtUsd(acc.freeMargin)}</div>
          <div className="font-terminal text-[9px] tracking-[0.14em] text-ink-3">MARGIN {marginPct}%</div>
        </div>
      </div>
    </BentoCard>
  );
}
