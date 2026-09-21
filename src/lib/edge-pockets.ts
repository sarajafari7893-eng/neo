// ── NEXUS//SIGNALS EDGE-POCKET MEMORY (server-only, v6.4.1 → v10.16) ──
// Operator question #3: «نمیتونی از سیگنال‌های ارسال‌شده بک‌تست بگیری تا
// ستاپ‌هایی با expectancy بالا رو پیدا کنی؟»
//
// The miner (scripts/mine-expectancy.ts — also re-run by the auto-learner's
// neighborhood) slices the settled-signal history along five measured
// dimensions and persists the significant pockets into EngineSetting
// "edge.pockets". The deployment gate then reads them:
//   · POSITIVE pocket match → +8 score bonus (exp ≥ +8 earns +10) — the setup
//     rides a statistically proven edge instead of dying at the flat threshold
//   · NEGATIVE pocket match (exp ≤ −2%)  → +6 threshold surcharge, and
//     exp ≤ −6% pockets skip the candidate outright (trap avoidance)
// Nothing here invents data: pockets come only from realized NET outcomes; a
// stale/absent memory degrades to "no pockets" (neutral behavior).
//
// v10.16 MULTIPLE-COMPARISONS GUARD (audit 4-f) — POSITIVE pockets only.
// The miner evaluates HUNDREDS of cells (symbol×strategy, strategy×regime,
// strategy×timeframe, confidence bands, hour buckets) against the same ledger;
// at a per-cell false-positive rate that is NOT alpha-corrected, a floor of
// n=6 with exp ≥ +2% guarantees a steady supply of lucky cells, and every one
// of them LOWERS the effective entry threshold by +8..10 score — direct
// capital exposure to selection noise. A positive pocket now qualifies for
// the bonus only if its expectancy is statistically distinguishable from
// zero at the one-sided 95% level: LB = mean − 1.645 × sd/√n > 0.
// DATA LIMIT (checked in mine-expectancy.ts): the persisted EdgePocket carries
// ONLY aggregates {n, wr, exp, netUsd, pf} — no per-trade series, no variance,
// no sd — so LB is NOT computable from what is stored. Conservative proxy per
// audit spec: require n ≥ 20 (raised from the mined floor of 6) AND mean ≥ +4%
// (a 2σ-ish margin for this ledger's observed |pnl%| scale, erring toward
// skipping marginal cells). When the miner starts persisting sd (or the
// trade-level series), replace the proxy with the true LB — see pocketMatch().
// Staleness expiry: the pocket book is only as fresh as its last miner run
// (pockets.at); a book older than 14 days has never been re-validated against
// the current regime → positive bonuses are SKIPPED (marked in notes; the
// pure reader cannot write back a per-pocket stale flag — EdgePocket has no
// timestamp). Negative-pocket rules (surcharge / SKIP) are UNCHANGED: they
// only tighten the gate, so false positives there are conservative, and the
// audit scope explicitly protects that behavior.

export interface EdgePocket {
  key: string; // human-readable pocket identity, e.g. "SOLUSDT+AI-SWING"
  kind: "symbol+strategy" | "strategy+regime" | "strategy+timeframe" | "confidence-band" | "hour-bucket";
  n: number;
  wr: number; // TP-proven win rate %
  exp: number; // NET expectancy %/trade
  netUsd: number; // realized Σ$
  pf: number; // profit factor (gains/losses, 99 cap)
}

export interface EdgePockets {
  at: string; // ISO — when the miner last ran
  samples: number; // settled signals mined
  positive: EdgePocket[];
  negative: EdgePocket[];
}

const KEY = "edge.pockets";
let memCache: { at: number; data: EdgePockets | null } | null = null;
const MEM_TTL = 10 * 60_000;

export async function loadEdgePockets(): Promise<EdgePockets | null> {
  if (memCache && Date.now() - memCache.at < MEM_TTL) return memCache.data;
  try {
    const { db } = await import("./db");
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    const data = row ? (JSON.parse(row.value) as EdgePockets) : null;
    memCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

/** Invalidate the in-memory cache (miner calls this after persisting). */
export function invalidateEdgePocketCache(): void {
  memCache = null;
}

export interface PocketContext {
  symbol: string;
  strategy: string;
  regimeTag: string; // "CHOP" | "TREND-UP" | "TREND-DOWN" | "VOLATILE" | ""
  timeframe: string;
  confidence: number;
  createdAt: Date;
}

function confBand(c: number): string {
  return c >= 85 ? "85+" : c >= 75 ? "75-84" : c >= 65 ? "65-74" : "55-64";
}
function hourBucket(d: Date): string {
  return `${Math.floor(d.getUTCHours() / 4) * 4}-${Math.floor(d.getUTCHours() / 4) * 4 + 3}Z`;
}

export interface PocketMatch {
  bonus: number; // +score for positive-pocket match
  thrSurcharge: number; // +threshold for negative-pocket match
  skip: boolean; // exp ≤ −6 ⇒ trap, deploy-skip
  notes: string[]; // human-readable evidence for the analysis text
}

// ── v10.16 positive-pocket qualification constants ──
const POCKET_MIN_N = 20; // raised from the mined floor of 6 — thin cells are noise, not edge
const POCKET_MIN_EXP = 4; // %/trade — conservative stand-in for the uncomputable 95% LB
const POCKET_STALE_MS = 14 * 24 * 3600_000; // book older than this → bonuses skipped

/**
 * v10.16 — POSITIVE-pocket qualification test (multiple-comparisons guard).
 * Intended statistic: one-sided 95% lower confidence bound of expectancy,
 * LB = mean − 1.645 × sd/√n > 0. The persisted EdgePocket stores only the mean
 * (exp) and n — mine-expectancy.ts persists no variance and no trade-level
 * series — so the bound cannot be computed at read time. Until the miner
 * persists sd (or the series), the conservative proxy below applies: the cell
 * must clear a higher n AND a higher mean than the old n≥6/exp≥+2 rule. Every
 * rejected cell simply loses the +8..10 bonus (neutral gate), never gains one.
 */
function positivePocketQualifies(p: EdgePocket): boolean {
  return p.n >= POCKET_MIN_N && p.exp >= POCKET_MIN_EXP; // proxy for LB > 0 — see comment
}

/** Match a candidate against the persisted pockets — pure, no I/O. */
export function pocketMatch(pockets: EdgePockets | null, ctx: PocketContext): PocketMatch {
  const none: PocketMatch = { bonus: 0, thrSurcharge: 0, skip: false, notes: [] };
  if (!pockets || (!pockets.positive.length && !pockets.negative.length)) return none;
  let bonus = 0;
  let surcharge = 0;
  let skip = false;
  const notes: string[] = [];

  const find = (list: EdgePocket[], k: string) => list.find((p) => p.key === k);

  // strongest evidence first — symbol+strategy beats generic buckets
  const posSym = find(pockets.positive, `${ctx.symbol}+${ctx.strategy}`);
  const posRegime = ctx.regimeTag ? find(pockets.positive, `${ctx.strategy}+${ctx.regimeTag}`) : undefined;
  const posTf = find(pockets.positive, `${ctx.strategy}+${ctx.timeframe}`);
  const pos = posSym ?? posRegime ?? posTf;
  // v10.16 — a matched positive pocket only counts if it survives the
  // multiple-comparisons guard AND the book is fresh (mined within 14 days).
  const bookAtMs = Date.parse(pockets.at);
  const bookStale = !Number.isFinite(bookAtMs) || Date.now() - bookAtMs > POCKET_STALE_MS;
  if (pos) {
    if (bookStale) {
      notes.push(`EDGE POCKET skipped (STALE) — ${pos.key}: pocket book last mined ${pockets.at.slice(0, 10)} (> 14d) — no score bonus until the expectancy miner re-validates it`);
    } else if (!positivePocketQualifies(pos)) {
      notes.push(`EDGE POCKET skipped (GUARD) — ${pos.key}: exp ${pos.exp >= 0 ? "+" : ""}${pos.exp.toFixed(1)}%/trade over n=${pos.n} fails the v10.16 floor (n≥${POCKET_MIN_N} AND exp ≥ +${POCKET_MIN_EXP}% — no sd persisted, so the 95% LB is not computable; hundreds of mined cells make thin margins false-positive prone) — no score bonus`);
    } else {
      bonus = Math.max(bonus, pos.exp >= 8 ? 10 : 8);
      notes.push(`EDGE POCKET +${bonus} — ${pos.key}: exp ${pos.exp >= 0 ? "+" : ""}${pos.exp.toFixed(1)}%/trade over n=${pos.n} (PF ${pos.pf.toFixed(2)}, Σ$${pos.netUsd >= 0 ? "+" : ""}${pos.netUsd.toFixed(2)})`);
    }
  }

  const negSym = find(pockets.negative, `${ctx.symbol}+${ctx.strategy}`);
  const negRegime = ctx.regimeTag ? find(pockets.negative, `${ctx.strategy}+${ctx.regimeTag}`) : undefined;
  const neg = negSym ?? negRegime;
  if (neg) {
    surcharge = Math.max(surcharge, 6);
    if (neg.exp <= -6) skip = true;
    notes.push(`TRAP POCKET — ${neg.key}: exp ${neg.exp.toFixed(1)}%/trade over n=${neg.n} (PF ${neg.pf.toFixed(2)}) → threshold ${skip ? "SKIP" : "+6"}`);
  }
  return { bonus, thrSurcharge: surcharge, skip, notes };
}

/** Governor grounding: compact pocket lines so the LLM tunes around proven edges. */
export function edgePocketGovernorLines(pockets: EdgePockets | null): string[] {
  if (!pockets) return ["9. EDGE POCKETS: memory empty — run the expectancy miner (scripts/mine-expectancy.ts) once enough signals settle"];
  const fmt = (p: EdgePocket) => `${p.key} n=${p.n} exp ${p.exp >= 0 ? "+" : ""}${p.exp.toFixed(1)}% $${p.netUsd >= 0 ? "+" : ""}${p.netUsd.toFixed(2)}`;
  const lines = [
    `9. EDGE POCKETS (mined ${pockets.at.slice(0, 16)}Z from ${pockets.samples} settled — v10.16: positive matches need n≥20 + exp≥+4% and a book fresher than 14d, then earn +8..10 score; negative pay +6 threshold or SKIP):`,
    `   PROVEN EDGES: ${pockets.positive.length ? pockets.positive.slice(0, 5).map(fmt).join(" · ") : "none ≥ +2%/trade yet"}`,
    `   TRAPS: ${pockets.negative.length ? pockets.negative.slice(0, 5).map(fmt).join(" · ") : "none ≤ −2%/trade yet"}`,
  ];
  return lines;
}
