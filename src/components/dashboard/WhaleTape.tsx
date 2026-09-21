"use client";

// ── WHALE TAPE / SMART MONEY RADAR (v6.4.2 — FLOW-RULED) ──
// v6.4: telemetry became a first-class dashboard panel feeding deployment
// (WHALE FLOW factor vote, persisted per signal, opposition vetoes).
// v6.4.2 operator challenge: «چرا باندل نهنگ برای ۶ نماد ثابت است؟ باید طبق
// قوانین ردیابی جریانات سیستم باشد» — the fixed top-6-by-volume lens is GONE.
// The bundle now follows the engine's flow rules: a rotating tape sweep walks
// the WHOLE dynamic scan domain; symbols with live ≥$150K prints (hit ring)
// and symbols with OPEN signals get deep reads. Attention follows measured
// flow — never a hardcoded symbol list. Coverage footer proves it.

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Waves } from "lucide-react";
import { BentoCard, LiveDot, NeonBadge } from "@/components/shared/primitives";

interface WhaleRead {
  symbol: string;
  whales: { count: number; buyUsd: number; sellUsd: number; netUsd: number; largestUsd: number } | null;
  smartLs: number | null;
  book: { bidUsd: number; askUsd: number; bidPct: number } | null;
  oiUsd: number | null;
  stale: boolean;
  pin: "OPEN" | "WHALE-HIT";
  hitNetUsd?: number;
  hitAt?: number;
}

interface WhaleBundle {
  at: number;
  windowMin: number;
  minUsd: number;
  reads: WhaleRead[];
  netWhaleUsd: number;
  universe: number;
  sweptLastPass: number;
  sweepCursor: number;
  sweepSymbols: string[];
  hitSymbols: string[];
  openSymbols: string[];
}

function usd(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

function sortKey(r: WhaleRead): number {
  const net = Math.abs(r.whales?.netUsd ?? 0);
  const ls = Math.abs((r.smartLs ?? 1) - 1);
  return net + ls * 100_000;
}

export default function WhaleTape() {
  const { data, isLoading } = useQuery<{ ts: number; bundle: WhaleBundle | null }>({
    queryKey: ["whales"],
    queryFn: async () => {
      const res = await fetch("/api/market/whales");
      if (!res.ok) throw new Error("whale tape unreachable");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const bundle = data?.bundle ?? null;
  const reads = bundle ? [...bundle.reads].sort((a, b) => sortKey(b) - sortKey(a)) : [];
  const degraded = !isLoading && (!bundle || (bundle.universe === 0 && reads.length === 0));
  const netTape = bundle?.netWhaleUsd ?? 0;
  const hits = bundle?.hitSymbols ?? [];
  const swept = bundle?.sweptLastPass ?? 0;
  const universe = bundle?.universe ?? 0;

  return (
    <BentoCard className="p-4 sm:p-6" corners ariaLabel="Whale tape and smart money telemetry">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Waves className="size-4 text-cyan-neon" aria-hidden />
          <h3 className="font-terminal text-sm font-bold uppercase tracking-[0.16em] text-foreground">
            Whale Tape <span className="text-ink-3">{"//"}</span> <span className="text-cyan-neon">Smart Money Radar</span>
          </h3>
          <LiveDot tone="neon" />
        </div>
        <NeonBadge tone="cyan">FLOW-RULED · ≥$150K PRINTS · 15M</NeonBadge>
      </div>
      <p className="mb-3 font-terminal text-[11px] leading-relaxed text-ink-3">
        rotating sweep walks the whole scan domain — any symbol with live whale prints gets pinned + deep-read
        (smart L/S · book · OI); OPEN-signal symbols always pinned. feeds the deploy gate (WHALE FLOW factor,
        opposition ≤−5 vetoes) + the analyst. no fixed symbol list.
      </p>

      {/* coverage strip — proves the flow-ruled lens is walking the domain */}
      {!isLoading && bundle && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <NeonBadge tone="violet">UNIVERSE {universe}</NeonBadge>
          <NeonBadge tone="cyan">SWEEP {swept}/PASS · ROT {bundle.sweepCursor}</NeonBadge>
          <NeonBadge tone={hits.length ? "neon" : "muted"}>HITS {hits.length}</NeonBadge>
          <NeonBadge tone="amber">OPEN PINS {bundle.openSymbols.length}</NeonBadge>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="bento h-9 animate-pulse" />
          ))}
        </div>
      ) : degraded ? (
        <div className="bento flex min-h-24 items-center justify-center p-4 text-center font-terminal text-xs text-ink-3">
          whale tape unreachable — telemetry degraded (measured, not invented)
        </div>
      ) : (
        <>
          {/* desktop table */}
          <div className="max-h-96 overflow-y-auto hidden md:block">
            <table className="w-full font-terminal text-xs">
              <thead>
                <tr className="border-b border-white/10 text-left text-[10px] uppercase tracking-wider text-ink-3">
                  <th className="py-2 pr-2 font-medium">Symbol</th>
                  <th className="py-2 pr-2 text-right font-medium">Whale Net 15m</th>
                  <th className="py-2 pr-2 text-right font-medium">Largest</th>
                  <th className="py-2 pr-2 font-medium">Smart L/S</th>
                  <th className="py-2 pr-2 font-medium">Book Bid%</th>
                  <th className="py-2 text-right font-medium">OI</th>
                </tr>
              </thead>
              <tbody>
                {reads.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-ink-3">
                      no pins this pass — sweep rotating ({swept > 0 ? `${swept} probed` : "starting"}), hits pin automatically when ≥$150K prints appear
                    </td>
                  </tr>
                ) : null}
                {reads.map((r, i) => {
                  const net = r.whales?.netUsd ?? null;
                  const ls = r.smartLs;
                  const bid = r.book?.bidPct ?? null;
                  return (
                    <motion.tr
                      key={r.symbol}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.25 }}
                      className="border-b border-white/5 hover:bg-white/[0.03]"
                    >
                      <td className="py-2 pr-2 font-bold text-foreground">
                        {r.symbol.replace("USDT", "")}
                        <NeonBadge tone={r.pin === "OPEN" ? "amber" : "neon"} className="ml-1.5 !px-1 !py-0 !text-[9px]">
                          {r.pin === "OPEN" ? "OPEN" : "HIT"}
                        </NeonBadge>
                        {r.stale && <NeonBadge tone="muted" className="ml-1 !px-1 !py-0 !text-[9px]">STALE</NeonBadge>}
                      </td>
                      <td className={`py-2 pr-2 text-right font-bold ${net === null ? "text-ink-3" : net > 0 ? "text-neon" : net < 0 ? "text-danger-neon" : "text-ink-3"}`}>
                        {net === null ? "—" : `${net > 0 ? "▲ +" : net < 0 ? "▼ −" : ""}${usd(net).replace("−", "")}`}
                      </td>
                      <td className="py-2 pr-2 text-right text-ink-2">{r.whales?.largestUsd ? usd(r.whales.largestUsd) : "—"}</td>
                      <td className="py-2 pr-2">
                        {ls === null ? (
                          <span className="text-ink-3">—</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <div className="h-1 w-14 overflow-hidden rounded-full bg-white/10" aria-hidden>
                              <div
                                className={`h-full rounded-full ${ls > 1.02 ? "bg-neon" : ls < 0.98 ? "bg-danger-neon" : "bg-white/30"}`}
                                style={{ width: `${Math.min(100, Math.max(4, ((ls - 0.5) / 2) * 100))}%` }}
                              />
                            </div>
                            <span className={ls > 1.02 ? "text-neon" : ls < 0.98 ? "text-danger-neon" : "text-ink-2"}>{ls.toFixed(2)}</span>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {bid === null ? (
                          <span className="text-ink-3">—</span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <div className="flex h-1 w-14 overflow-hidden rounded-full" aria-hidden>
                              <div className="h-full bg-neon" style={{ width: `${bid}%` }} />
                              <div className="h-full bg-danger-neon" style={{ width: `${100 - bid}%` }} />
                            </div>
                            <span className="text-ink-2">{bid.toFixed(0)}%</span>
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-right text-ink-2">{r.oiUsd !== null ? usd(r.oiUsd) : "—"}</td>
                    </motion.tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* mobile stacked cards */}
          <div className="space-y-2 md:hidden">
            {reads.length === 0 && (
              <div className="bento p-3 text-center font-terminal text-[10px] text-ink-3">
                no pins this pass — sweep rotating, hits pin automatically on ≥$150K prints
              </div>
            )}
            {reads.map((r, i) => {
              const net = r.whales?.netUsd ?? null;
              const ls = r.smartLs;
              const bid = r.book?.bidPct ?? null;
              return (
                <motion.div
                  key={r.symbol}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04, duration: 0.25 }}
                  className="bento p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-terminal text-xs font-bold text-foreground">
                      {r.symbol.replace("USDT", "")}
                      <NeonBadge tone={r.pin === "OPEN" ? "amber" : "neon"} className="ml-1.5 !px-1 !py-0 !text-[9px]">
                        {r.pin === "OPEN" ? "OPEN" : "HIT"}
                      </NeonBadge>
                      {r.stale && <NeonBadge tone="muted" className="ml-1 !px-1 !py-0 !text-[9px]">STALE</NeonBadge>}
                    </span>
                    <span className={`font-terminal text-xs font-bold ${net === null ? "text-ink-3" : net > 0 ? "text-neon" : net < 0 ? "text-danger-neon" : "text-ink-3"}`}>
                      {net === null ? "—" : `${net > 0 ? "▲ +" : net < 0 ? "▼ −" : ""}${usd(net).replace("−", "")}`}
                    </span>
                  </div>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 font-terminal text-[10px] text-ink-3">
                    <span>L/S {ls === null ? "—" : ls.toFixed(2)}</span>
                    <span>BID {bid === null ? "—" : `${bid.toFixed(0)}%`}</span>
                    <span className="text-right">OI {r.oiUsd !== null ? usd(r.oiUsd) : "—"}</span>
                  </div>
                </motion.div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-2.5">
            <span className={`font-terminal text-[11px] font-bold ${netTape >= 0 ? "text-neon" : "text-danger-neon"}`}>
              NET TAPE {netTape >= 0 ? "+" : "−"}{usd(netTape).replace("−", "")} {netTape >= 0 ? "BUY" : "SELL"} pressure
            </span>
            <span className="font-terminal text-[10px] text-ink-3">
              {reads.length} deep pins · window {bundle?.windowMin ?? 15}m{hits.length ? ` · hits: ${hits.slice(0, 3).map((h) => h.replace("USDT", "")).join(", ")}${hits.length > 3 ? "…" : ""}` : ""}
            </span>
          </div>
        </>
      )}
    </BentoCard>
  );
}
