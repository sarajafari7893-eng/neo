"use client";

import { useMemo } from "react";
import { motion } from "framer-motion";
import { Eye, Star, X } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge, SectionHeader, Sparkline } from "@/components/shared/primitives";
import type { MarketAssetDTO } from "@/lib/api-types";
import { fmtCompact, fmtPct, fmtPrice } from "@/lib/format";
import { useUi } from "@/store/ui";
import { useAlerts } from "@/store/alerts";
import { cn } from "@/lib/utils";

function ChangeBadge({ change, big = false }: { change: number; big?: boolean }) {
  const up = change >= 0;
  return (
    <NeonBadge tone={up ? "neon" : "danger"} glow={big} className={big ? "px-2.5 py-1 text-[11px]" : undefined}>
      {up ? "▲" : "▼"} {fmtPct(change)}
    </NeonBadge>
  );
}

function AnimatedPrice({ price, className }: { price: number; className?: string }) {
  return (
    <motion.span
      key={price}
      initial={{ opacity: 0.35, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className={cn("inline-block font-terminal font-bold tabular-nums text-ink", className)}
    >
      {fmtPrice(price)}
    </motion.span>
  );
}

/* ── watchlist star toggle (shared by hero + rows) ── */
function StarToggle({ symbol, className }: { symbol: string; className?: string }) {
  const watchlist = useAlerts((s) => s.watchlist);
  const toggleWatch = useAlerts((s) => s.toggleWatch);
  const watched = watchlist.includes(symbol);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggleWatch(symbol);
      }}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60",
        watched
          ? "border-[rgba(255,179,71,0.5)] bg-[rgba(255,179,71,0.12)] text-amber-neon shadow-[0_0_12px_-3px_rgba(255,179,71,0.8)]"
          : "border-white/10 bg-white/[0.03] text-ink-3 hover:border-[rgba(255,179,71,0.4)] hover:text-amber-neon",
        className
      )}
    >
      <Star size={13} strokeWidth={2.4} className={cn(watched && "fill-current")} />
    </button>
  );
}

export default function MarketMovers({ market }: { market: MarketAssetDTO[] }) {
  const setSpotlightSymbol = useUi((s) => s.setSpotlightSymbol);
  const watchlist = useAlerts((s) => s.watchlist);
  const removeWatch = useAlerts((s) => s.removeWatch);

  const movers = useMemo(
    () => [...market].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h)).slice(0, 4),
    [market]
  );

  /* watched assets resolved against the live market feed */
  const watched = useMemo(() => {
    const bySym = new Map(market.map((m) => [m.symbol, m] as const));
    return watchlist.map((s) => bySym.get(s)).filter((m): m is MarketAssetDTO => Boolean(m));
  }, [market, watchlist]);

  function open(sym: string) {
    setSpotlightSymbol(sym);
  }

  if (movers.length === 0) {
    return (
      <section aria-label="Market matrix">
        <SectionHeader index="02" title="MARKET MATRIX" subtitle="Top volatility — sorted by |Δ24h|" />
        <div className="label-tech rounded-xl border border-dashed border-neon/25 p-8 text-center">MARKET FEED OFFLINE</div>
      </section>
    );
  }

  const [hero, ...rest] = movers;
  const heroUp = hero.change24h >= 0;

  return (
    <section aria-label="Market matrix">
      <SectionHeader
        index="02"
        title="MARKET MATRIX"
        subtitle="Top volatility — sorted by |Δ24h| · tap a row for the spotlight · star assets to watch"
        right={
          watchlist.length > 0 ? (
            <NeonBadge tone="amber" className="h-7 px-2.5 text-[11px]">
              <Star size={10} className="fill-current" aria-hidden />
              {watchlist.length} WATCHED
            </NeonBadge>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* #1 mover — wide violet watch card */}
        <BentoCard tone="violet" corners className="relative overflow-hidden lg:col-span-5">
          <div aria-hidden className="grid-bg-fine pointer-events-none absolute inset-0 rounded-[inherit] opacity-30 [mask-image:radial-gradient(circle_at_70%_20%,black_10%,transparent_70%)]" />
          <div className="relative flex h-full flex-col">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-terminal text-xs font-bold text-violet-neon">#1</span>
                <span className="label-tech">Top mover</span>
              </div>
              <div className="flex items-center gap-1.5">
                <NeonBadge tone="violet" glow>
                  <Eye className="h-3 w-3" aria-hidden /> AI watching
                </NeonBadge>
                <StarToggle symbol={hero.symbol} />
              </div>
            </div>

            <button
              type="button"
              onClick={() => open(hero.symbol)}
              aria-label={`Open ${hero.symbol} spotlight`}
              className="mt-4 flex flex-1 flex-col items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-neon/70"
            >
              <div className="flex w-full flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-terminal text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">{hero.symbol}</div>
                  <div className="label-tech mt-0.5 truncate">{hero.name}</div>
                </div>
                <div className="text-right">
                  <AnimatedPrice price={hero.price} className="text-2xl sm:text-3xl" />
                  <div className="mt-1 flex justify-end">
                    <ChangeBadge change={hero.change24h} big />
                  </div>
                </div>
              </div>

              <Sparkline
                data={hero.sparkline}
                width={240}
                height={64}
                tone={heroUp ? "violet" : "danger"}
                strokeWidth={2}
                className="h-16 w-full"
              />

              <div className="flex w-full items-center justify-between border-t border-white/5 pt-3">
                <div>
                  <div className="label-tech">Vol 24h</div>
                  <div className="font-terminal text-sm font-bold text-ink-2">{fmtCompact(hero.volume24h)}</div>
                </div>
                <div className="text-right">
                  <div className="label-tech">24h range</div>
                  <div className="font-terminal text-xs font-bold text-ink-2">
                    {fmtPrice(hero.low24h)} – {fmtPrice(hero.high24h)}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </BentoCard>

        {/* runners-up list */}
        <BentoCard delay={0.08} className="lg:col-span-7">
          <ul className="flex h-full flex-col divide-y divide-white/5">
            {rest.map((a, i) => {
              const up = a.change24h >= 0;
              return (
                <li key={a.symbol} className="flex flex-1 items-center">
                  <button
                    type="button"
                    onClick={() => open(a.symbol)}
                    aria-label={`Open ${a.symbol} spotlight`}
                    className="flex w-full min-h-14 items-center gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
                  >
                    <span className="w-7 shrink-0 font-terminal text-xs font-bold text-ink-3">#{i + 2}</span>
                    <span className="w-20 shrink-0 sm:w-24">
                      <span className="block truncate font-terminal text-sm font-bold text-foreground">{a.symbol}</span>
                      <span className="block truncate text-[10px] text-ink-3">{a.name}</span>
                    </span>
                    <span className="hidden min-w-16 flex-1 text-right font-terminal text-sm font-bold tabular-nums text-ink-2 sm:block md:flex-none md:text-left">
                      <AnimatedPrice price={a.price} className="text-sm" />
                    </span>
                    <span className="shrink-0">
                      <ChangeBadge change={a.change24h} />
                    </span>
                    <Sparkline
                      data={a.sparkline}
                      width={100}
                      height={32}
                      tone={up ? "neon" : "danger"}
                      className="ml-auto hidden shrink-0 md:block"
                    />
                    <span className="ml-auto hidden w-16 shrink-0 text-right font-terminal text-xs tabular-nums text-ink-3 md:ml-4 md:block">
                      {fmtCompact(a.volume24h)}
                    </span>
                  </button>
                  <StarToggle symbol={a.symbol} className="ml-1" />
                </li>
              );
            })}
          </ul>
        </BentoCard>
      </div>

      {/* ── watchlist strip ── */}
      {watched.length > 0 && (
        <div className="mt-4" aria-label="Watchlist">
          <div className="glass-soft flex items-center gap-2 overflow-x-auto rounded-xl p-2.5">
            <span className="label-tech hidden shrink-0 items-center gap-1 pl-1 pr-1 text-amber-neon sm:flex">
              <Star size={10} className="fill-current" aria-hidden />
              WATCHLIST
            </span>
            {watched.map((a) => {
              const up = a.change24h >= 0;
              return (
                <div
                  key={a.symbol}
                  className="group relative flex shrink-0 items-center gap-2.5 rounded-lg border border-[rgba(255,179,71,0.22)] bg-[rgba(255,179,71,0.04)] py-1.5 pl-2.5 pr-8 transition-colors hover:border-[rgba(255,179,71,0.45)]"
                >
                  <button
                    type="button"
                    onClick={() => open(a.symbol)}
                    aria-label={`Open watchlist asset ${a.symbol} spotlight`}
                    className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
                  >
                    <span className="font-terminal text-xs font-bold text-foreground">{a.symbol}</span>
                    <AnimatedPrice price={a.price} className="text-xs" />
                    <span className={cn("font-terminal text-[10px] font-bold tabular-nums", up ? "text-neon" : "text-danger-neon")}>
                      {fmtPct(a.change24h)}
                    </span>
                    <Sparkline
                      data={a.sparkline}
                      width={72}
                      height={20}
                      tone={up ? "neon" : "danger"}
                      fill={false}
                      className="hidden sm:block"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeWatch(a.symbol)}
                    aria-label={`Remove ${a.symbol} from watchlist`}
                    className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-ink-3 transition-colors hover:text-danger-neon focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon/60"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
