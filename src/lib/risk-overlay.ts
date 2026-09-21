// ── FlowRadar Neo v8.1 PORTFOLIO RISK OVERLAY (P2, server-only) ──────────
// Operator mandate 2026-09-08: «طبق نظر مهندسی P1 و P2 رو کامل اجرا کن».
// The PORTFOLIO-STRUCTURAL layer: correlated same-direction clusters, one-way
// exposure and drawdown throttle — pure math over the open ledger + the shared
// 15m kline cache (vol-forecast.ts). No new REST surface.
//
// Contract consumed by engine.ts deploy path + /api/risk:
//   getRiskState(symbol?, direction?) →
//     { state: RiskState, candidateJoinsBlocked?: boolean }
//
// Policy (hard-coded per design — not governor knobs):
//   · same-direction correlated cluster ≥35% of equity → BLOCK a candidate
//     joining it (auto path); operator-forced deploys are never refused, the
//     engine half-sizes them with the RISK-CLUSTER tag.
//   · drawdown ≥3% → size ×0.75 · ≥7% → ×0.5 (hard-bounded backstop).
//   · verdict: OK · THROTTLE (sizeMult<1) · BLOCK (standing same-dir cluster ≥35%).
//
// Correlation: Pearson ρ over the last 96 closed 15m returns (aligned series,
// no lookahead). Cluster = union-merge of pairs with |ρ| ≥ 0.65.

import { db } from "@/lib/db";
import { getKlines15m } from "./vol-forecast";
import { ACCOUNT_START_USD } from "./accounting";

export interface RiskCluster {
  symbols: string[];
  direction: "LONG" | "SHORT" | "MIXED";
  marginUsd: number;
  corr: number;
  equityPct: number;
}

export interface RiskState {
  at: number;
  equity: number;
  peakEquity: number;
  drawdownPct: number;
  exposureUsd: number;
  openCount: number;
  clusters: RiskCluster[];
  worstClusterPct: number;
  sizeMult: number;
  verdict: "OK" | "THROTTLE" | "BLOCK";
  reasons: string[];
}

const CLUSTER_RHO = 0.65; // pairwise ρ for union-merge clustering
const JOIN_RHO = 0.7; // ρ for counting a position into the candidate's cluster
const BLOCK_PCT = 35; // same-direction correlated cluster cap, % of equity
const DD_THROTTLE_PCT = 3; // drawdown that starts throttling
const DD_HEAVY_PCT = 7; // drawdown that halving sizes
// audit fix 2026-09-08: was hardcoded 100 — now imports the canonical seed so a
// future balance reseed can never desync the risk overlay's drawdown baseline
const START_BALANCE = ACCOUNT_START_USD;

// ── Pearson ρ over aligned closed-bar returns ──
function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 24) return null;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// per-process return-series cache (aligned with the k15 cache TTL)
const retsCache = new Map<string, { at: number; rets: number[] }>();

async function returns15m(symbol: string): Promise<number[] | null> {
  const hit = retsCache.get(symbol);
  if (hit && Date.now() - hit.at < 120_000) return hit.rets;
  const candles = await getKlines15m(symbol);
  if (!candles || candles.length < 30) return null;
  const closed = candles.slice(0, -1);
  const rets: number[] = [];
  for (let i = 1; i < closed.length; i++) {
    const p0 = closed[i - 1]!.close;
    const p1 = closed[i]!.close;
    if (p0 > 0 && p1 > 0) rets.push((p1 - p0) / p0);
  }
  retsCache.set(symbol, { at: Date.now(), rets });
  if (retsCache.size > 64) {
    const oldest = [...retsCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) retsCache.delete(oldest[0]);
  }
  return rets;
}

interface OpenPos {
  symbol: string;
  direction: string;
  marginUsd: number;
}

async function ledgerCurve(): Promise<{ equity: number; peak: number; exposureUsd: number; openCount: number }> {
  const settled = await db.signal.findMany({ where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } }, select: { pnlPercent: true, marginUsd: true, closedAt: true } });
  const open = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { pnlPercent: true, marginUsd: true } });
  let realized = 0;
  const curve: number[] = [START_BALANCE];
  const byTime = settled.sort((a, b) => (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0));
  for (const s of byTime) {
    realized += (s.marginUsd * s.pnlPercent) / 100;
    curve.push(START_BALANCE + realized);
  }
  const unrealized = open.reduce((a, s) => a + (s.marginUsd * s.pnlPercent) / 100, 0);
  const equity = START_BALANCE + realized + unrealized;
  const peak = Math.max(...curve, equity);
  return { equity, peak, exposureUsd: open.reduce((a, s) => a + s.marginUsd, 0), openCount: open.length };
}

function sizeMultFor(drawdownPct: number): number {
  if (drawdownPct >= DD_HEAVY_PCT) return 0.5;
  if (drawdownPct >= DD_THROTTLE_PCT) return 0.75;
  return 1;
}

/** Union-merge clusters over the open book (pairs |ρ| ≥ 0.65). */
async function buildClusters(open: OpenPos[], equity: number): Promise<RiskCluster[]> {
  if (open.length < 2) return [];
  const uniqSymbols = [...new Set(open.map((s) => s.symbol))];
  const dirOf = new Map(open.map((s) => [s.symbol, s.direction] as const));
  const rets = new Map<string, number[] | null>();
  for (const sym of uniqSymbols) rets.set(sym, await returns15m(sym));

  // union-find over symbol indices
  const idx = new Map(uniqSymbols.map((s, i) => [s, i] as const));
  const parent = uniqSymbols.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  const pairRho = new Map<string, number>();
  for (let i = 0; i < uniqSymbols.length; i++) {
    for (let j = i + 1; j < uniqSymbols.length; j++) {
      const ra = rets.get(uniqSymbols[i]!);
      const rb = rets.get(uniqSymbols[j]!);
      if (!ra || !rb) continue;
      const rho = pearson(ra, rb);
      if (rho === null) continue;
      pairRho.set(`${i}|${j}`, rho);
      if (Math.abs(rho) >= CLUSTER_RHO) union(i, j);
    }
  }

  const groups = new Map<number, string[]>();
  for (const s of uniqSymbols) {
    const root = find(idx.get(s)!);
    const g = groups.get(root) ?? [];
    g.push(s);
    groups.set(root, g);
  }

  const out: RiskCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const rhos: number[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = idx.get(members[i]!)!;
        const b = idx.get(members[j]!)!;
        const r = pairRho.get(`${a}|${b}`) ?? pairRho.get(`${b}|${a}`);
        if (r !== undefined) rhos.push(Math.abs(r));
      }
    }
    const dirs = members.map((s) => dirOf.get(s) ?? "");
    const direction = dirs.every((d) => d === "LONG") ? "LONG" : dirs.every((d) => d === "SHORT") ? "SHORT" : "MIXED";
    const marginUsd = open.filter((s) => members.includes(s.symbol)).reduce((a, s) => a + s.marginUsd, 0);
    out.push({
      symbols: members,
      direction,
      marginUsd: Number(marginUsd.toFixed(2)),
      corr: rhos.length ? Number((rhos.reduce((a, b) => a + b, 0) / rhos.length).toFixed(2)) : 0,
      equityPct: equity > 0 ? Number(((marginUsd / equity) * 100).toFixed(1)) : 0,
    });
  }
  out.sort((a, b) => b.equityPct - a.equityPct);
  return out;
}

/**
 * Risk state for the standing book (API) and, when symbol+direction are given,
 * a verdict on whether a NEW candidate would join an over-cap correlated cluster.
 */
export async function getRiskState(symbol?: string, direction?: "LONG" | "SHORT"): Promise<{ state: RiskState; candidateJoinsBlocked?: boolean }> {
  const open = await db.signal.findMany({ where: { status: { in: ["ACTIVE", "TP1", "TP2"] } }, select: { symbol: true, direction: true, marginUsd: true } });
  const { equity, peak, exposureUsd, openCount } = await ledgerCurve();
  const drawdownPct = peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0;
  const sizeMult = sizeMultFor(drawdownPct);
  const clusters = await buildClusters(open as OpenPos[], equity);
  const sameDirClusters = clusters.filter((c) => c.direction === "LONG" || c.direction === "SHORT");
  const worstClusterPct = sameDirClusters.length ? Math.max(...sameDirClusters.map((c) => c.equityPct)) : clusters.length ? Math.max(...clusters.map((c) => c.equityPct)) : 0;

  const reasons: string[] = [];
  for (const c of clusters.slice(0, 3)) {
    reasons.push(`correlated cluster ${c.symbols.join("+")} (${c.direction}, ρ̄ ${c.corr.toFixed(2)}) holds ${c.equityPct}% of equity`);
  }
  if (drawdownPct >= DD_THROTTLE_PCT) reasons.push(`drawdown ${drawdownPct.toFixed(1)}% from peak → sizing ×${sizeMult}`);

  let verdict: RiskState["verdict"] = "OK";
  if (sameDirClusters.some((c) => c.equityPct >= BLOCK_PCT)) verdict = "BLOCK";
  else if (sizeMult < 1) verdict = "THROTTLE";
  if (reasons.length === 0) reasons.push("book clean — no correlated clusters, drawdown inside bands");

  const state: RiskState = {
    at: Date.now(),
    equity: Number(equity.toFixed(2)),
    peakEquity: Number(peak.toFixed(2)),
    drawdownPct: Number(drawdownPct.toFixed(1)),
    exposureUsd: Number(exposureUsd.toFixed(2)),
    openCount,
    clusters: clusters.slice(0, 6),
    worstClusterPct: Number(worstClusterPct.toFixed(1)),
    sizeMult,
    verdict,
    reasons,
  };

  if (!symbol || !direction) return { state };

  // candidate join test — same-direction correlated share the candidate adds to
  const candRets = open.length > 0 ? await returns15m(symbol) : null;
  let joinShare = 0;
  if (candRets) {
    for (const pos of open as OpenPos[]) {
      if (pos.symbol === symbol || pos.direction !== direction) continue;
      const posRets = await returns15m(pos.symbol);
      if (!posRets) continue;
      const rho = pearson(candRets, posRets);
      if (rho !== null && Math.abs(rho) >= JOIN_RHO) joinShare += pos.marginUsd;
    }
  }
  const joinPct = equity > 0 ? (joinShare / equity) * 100 : 0;
  const candidateJoinsBlocked = joinPct >= BLOCK_PCT;
  return { state, candidateJoinsBlocked };
}
