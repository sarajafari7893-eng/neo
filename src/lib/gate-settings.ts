// ── NEXUS//SIGNALS operator gate tunables (server-only) ──
// Persisted in EngineSetting, clamped to safe ranges, every change auditable.
// v5.1: adds UNIVERSE SIZE — how much of the USDT-M futures market the
// flow scanner tracks (the operator's answer to "scan domain too low").
// v6.3 (operator mandate: dynamic risk management): adds the RISK PROFILE
// knobs the AI governor owns — slAtrMult (stop distance in ATR multiples),
// rrScale (scales the computed R:R ladder) and regimeGuard (regime-filter
// hardening level). MIN_SCORE itself is no longer a flat constant: the
// regime ruling contributes a per-candidate threshold adjustment so the
// EFFECTIVE threshold adapts to the market the candidate lives in.

import { db } from "@/lib/db";

export interface GateSettings {
  minScore: number; // 20–60, default 35 — BASE threshold; the EFFECTIVE threshold = minScore + regime thrAdj per candidate
  flowShortlist: number; // 1–6, default 3
  flowVetoScore: number; // 4–25, default 8 (veto when flow.score ≤ −T)
  universeSize: number; // 12–64, default 40 — tracked USDT-M perps (flow-ranked, dynamic)
  ttlExtendMax: number; // 0–3, default 1 — dynamic expiry gate: max TTL extensions per signal (0 = gate off)
  ttlExtendMinutes: number; // 15–240, default 60 — minutes granted per extension
  ttlNearTpPct: number; // 0.3–5, default 1.5 — unlevered % band to next TP that qualifies for extension
  slAtrMult: number; // 0.8–2.5, default 1.5 — v6.3 stop distance = slAtrMult × ATR% (× regime slMult)
  rrScale: number; // 0.75–1.35, default 1.0 — v6.3 scales the dynamic R:R ladder (tp2/tp3 stretch)
  tp1RMult: number; // 0.3–1, default 0.55 — v12.6 TP1 MFE-SCALE RE-RANK (operator mandate 2026-10-20,
  // OP-AUDIT-TP-1020 proposal ① approved): TP1 was hard-locked at 1R while the ledger's
  // realized MFE median sits at 0.37–0.52R — the first bank lived beyond the typical
  // excursion (only 11% of expired rows ever reached ≥80% of the TP1 path) and the
  // TP-proven rate collapsed. TP1 = tp1RMult × R (R = SL distance); tp2/tp3/SL geometry
  // untouched; the decisive-filter/vol-barrier first-decision projections track the
  // SAME distance (fdMult) so the gates stay coherent with the ladder. 1.0 = legacy 1R.
  regimeGuard: number; // 0–2, default 1 — v6.3 regime-filter hardening (0 soft penalties · 1 chop veto · 2 +BTC-spillover & vol MR veto)
  maxActive: number; // 2–8, default 5 — v6.3 position capacity: max concurrent open signals
  riskPerTrade: number; // 0.5–1.5, default 1.0 — v6.3 margin sizing scale on confidence-sized margin
  beTrailPct: number; // 0–40, default 10 — v6.5 mid-ladder breakeven arm: when a live signal's NET pnl first
  // reaches +beTrailPct% (levered), the stop moves to entry (downside becomes fee-only). 0 = off.
  // Evidence (perf forensics 2026-09-07): 57% of SL trades were first in profit (avg MFE +15% levered)
  // but the old trail armed only at TP1 (+1R ≈ +25% levered) — round-trips to full −1R were the
  // single largest damage bucket (SL −$89.21 of −$114.96 gross loss).
  shortSizeMult: number; // 0.3–1, default 1 — v6.5 margin multiplier applied to SHORT deployments.
  // Evidence: SHORT book 27.8% win / −$26.65 realized vs LONG +$2.32 across all confidence tiers.
  breakoutGuard: number; // 0–2, default 0 — v6.5 BREAKOUT strategy guard: 0 normal · 1 half-size · 2 veto.
  // Evidence: BREAKOUT 49 settled, 14.3% win, −$30.98 realized — worse than the whole book's net loss.
  onsetRetestGuard: number; // 0–1, default 1 — v6.7.2 VOL-ONSET RETEST GATE (DURATION-LAB evidence: 9 real
  // fast-kills <15m were 100% chase entries into fresh eruption bursts, flow CONFIRMS 7/9 at the snapshot).
  // 1 = a deployment CHASING a hot (<90min) eruption is BLOCKED until price retraces ≥30% of the
  // impulse leg (entry on retest, not on burst). Retested entries carry the VOL-ONSET-RETEST tag.
  chaseThrAdj: number; // 0–15, default 6 — v6.7.2 LONG-CHASE ASYMMETRY surcharge: when a LONG candidate's
  // last-5-bar move is already ≥1.5×ATR (extended burst), its EFFECTIVE threshold pays +chaseThrAdj.
  // Evidence: 100% of real fast-kills were LONG chases; marginal long-chases now fail the gate. 0 = off.
  leveredRiskCap: number; // 10–100, default 25 — v6.7.2 LEVERED RISK CAP: max single-trade % swing at the
  // stop (slDist% × leverage). Evidence: NX-0185 1.79%×20=36%, NX-0138 4.10%×15=61% — two trades carried
  // the whole day's damage. Excess leverage is trimmed at deploy so the stop costs ≤ the cap.
  shortGuard: number; // 0–2, default 2 — v8.4 R1 SHORT GUARD (module-performance audit 2026-09-11):
  // SHORT book won 11.1% and burned −$9.69 of the −$9.95 total net. 0 = normal ·
  // 1 = a SHORT must ride an ALIGNED HTF flow board (netScore ≤ −40, ≥2/4 TFs) ·
  // 2 = all auto SHORT deployments vetoed until the regime evidence improves.
  beArmMovePct: number; // 0–10, default 1.5 — v8.4 R2 DEFINITIVE BREAKEVEN ARM: when the UNLEVERED
  // price move first reaches +beArmMovePct% in favor, the stop moves to entry.
  // Leverage-invariant (the v6.5 levered beTrailPct misses low-leverage spikes
  // between ticks). Audit: 8 winners (MFE ≥ +8% levered) closed negative, ≈$4.73
  // give-back. 0 = off (levered beTrailPct still applies).
  // v11.2 REPURPOSED as the WIDE-STOP CAP: the structural R-arm (below) owns the
  // primary trigger; this absolute-price ceiling still catches very wide-stop
  // trades whose 0.5R distance would exceed it.
  beArmRMult: number; // 0–1, default 0.5 — v11.2 STRUCTURAL R-ARM (operator mandate 2026-10-07
  // «هر سه مورد را کامل و مهندسی پیاده کن» — proposal ② approved verbatim): the
  // mid-ladder breakeven arm now fires on the UNLEVERED PRICE DISTANCE measured
  // in R of the trade's OWN risk geometry — movePct ≥ beArmRMult × slDistPct —
  // replacing the fixed +10% NET anchor whose premature, leverage-skewed arms
  // round-tripped 46% of the day's peak MFE back to breakeven (SENTINEL ledger
  // forensics 2026-10-07: 36 rows touched +10%, only 12 kept it; ≥15× rows kept
  // 17% vs 58% for <15×). Same structural distance for every leverage tier.
  // 0 = off (legacy NET/absolute arms still apply).
  beBankFrac: number; // 0–0.5, default 0.25 — v11.2 BE-BANK (operator mandate 2026-10-07 —
  // proposal ①): when the arm fires on an UNBANKED signal (reachedTp=0), a
  // partial tranche of the position is BANKED at the arm mark (recorded as
  // beBankedMovePct/beBankedFrac) and only the remainder rides the risk-free
  // runner. Evidence: 16 BE-class exits settled at −1.2..−1.8% (entry minus
  // fees) on 2026-10-07 alone — the arm protected capital but harvested zero.
  // The ladder's remaining weights (tp1/tp2/runner) scale by 1−frac so every
  // tranche set still sums to exactly 1 (pnlPercent stays margin-relative).
  // 0 = arm without banking (legacy v6.5 behavior).
  earlyExitGuard: number; // 0–1, default 1 — v8.4 R2/R7 EARLY TIME-EXIT master switch.
  earlyExitFrac: number; // 0.3–0.9, default 0.5 — fraction of TTL after which an unbanked trade
  // becomes eligible for the early time-exit (below).
  earlyExitR: number; // 0–1, default 0.45 — v8.4 R7: after earlyExitFrac of TTL, a trade whose NET
  // ≤ −earlyExitR × 1R closes at the mark (EXPIRED) instead of riding to −1R.
  // Audit: EXPIRED closes averaged +$2.66 vs SL −$12.61. 0 = adverse-exit off
  // (the STALLED arm |move|≤0.15R still applies when the guard is on).
  minScorePinned: number; // 0–1, default 0 — v8.4.2 OPERATOR PIN (bridge mandate 2026-09-12:
  // «آستانه ورود به سیگنال ها رو به ۲۵ کاهش بده و ثابت نگه دار» — lower the entry
  // threshold to 25 AND keep it FIXED). 1 = minScore is operator-owned: every
  // AUTOMATIC writer (governor set_min_score, AUTO-RELIEF valve, SUPERVISOR
  // quality-raise, advisor apply) is suppressed with an audited note. Only an
  // explicit operator mandate (bridge → audited script) may move or unpin it.
  decisiveFilter: number; // 0–2, default 1 — v10.6 DECISIVE-EXCURSION FILTER (operator mandate 2026-09-15:
  // «علت های ریشه‌ای را برطرف کن» — root cause #1: 62% of RAW-CAL settles expire
  // without ever touching TP1 or SL = censored rows that starve R6 attribution
  // and bleed fees). Before any auto/capture deploy: the ATR-projected price
  // TRAVEL within TTL (diffusion-scaled, discounted by the Kaufman efficiency
  // ratio so chop counts as no-travel) must reach the ladder's first decision
  // distance min(TP1dist, SLdist) — with TP1=1R both equal the stop distance,
  // so the bar is 1R in price terms. Predicted no-touch → deploy SKIPPED.
  // 0 = off · 1 = lenient (×0.85 bar) · 2 = strict (full 1R bar).
  decisiveErMin: number; // 0–1, default 0.12 — v10.6 absolute chop floor: efficiency ratio below
  // this = the tape goes nowhere regardless of ATR size (hard block, projection
  // irrelevant). 0 = projection-only.
  volBarrier: number; // 0–1, default 1 — v10.9.2 VOL-SCALED VERTICAL BARRIER (SUPERVISOR proposal,
  // operator blanket-approve 2026-09-16T09:03Z): the random strategy-band TTL has no
  // relationship to how far THIS tape can carry price — slow-tape candidates die as
  // EXPIRED-no-touch (censored rows: 44% of the post-filter cohort). Instead the TTL
  // is SOLVED from the diffusion projection: t1r = 15 × (requiredPct / (atrPct × ER))²
  // = projected time to the first decision (min(TP1dist, SLdist) = 1R), and the
  // vertical barrier = t1r × volBarrierMult (headroom for the fat right tail of touch
  // times), clamped [30m, volBarrierCapMin]. Projected touch beyond the cap or ER
  // below the chop floor → SLOW-TOUCH candidate, deploy skipped. 0 = off (random band).
  volBarrierMult: number; // 1.0–2.0, default 1.3 — barrier headroom multiplier on the projected
  // 1R touch time; ×1.3 puts the barrier past the median touch so TP1/SL — not the
  // clock — resolve the trade (post-filter cohort informative 56% → 65-75% expected).
  volBarrierCapMin: number; // 60–360, default 240 — hard barrier ceiling: a projected 1R
  // touch beyond this is a slow-touch candidate (skip — a farther barrier would just
  // manufacture the same censored rows with extra fees). Also the barrier clamp.
  volBarrierAdaptive: number; // 0–1, default 1 — v10.14 REGIME-ADAPTIVE BARRIER CAP
  // (SUPERVISOR proposal 2026-09-19T06:51Z, operator APPROVE 2026-09-19T08:56Z
  // msg 861802419 «پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده»): both
  // issuance droughts showed 100% vol-barrier blocks (t1r 724-4932m vs the
  // FIXED 240m cap) with a healthy sweep — in compression the fixed cap kills
  // exactly the setups that expand (cohort best: GUSDT BREAKOUT TP3 +95.2%, a
  // compression-expansion capture). When 1: the EFFECTIVE cap =
  // volBarrierCapMin if volPctile ≥ 30, else clamp(volBarrierCapMin ×
  // (1 + 2×(30−volPctile)/30), volBarrierCapMin, 3×volBarrierCapMin) — at the
  // default 240: 240→720m as the symbol's 30d realized-vol percentile falls
  // 30→0. volPctile from src/lib/vol-percentile.ts (rank vs own 30d history,
  // 30min cache, FAIL-OPEN null → fixed cap). 0 = fixed cap (legacy behavior).
  // The knob itself is never modified — the relaxation is computed per deploy.
  // Residual rejects keep feeding the BARRIER-CAP-NEAR-MISS paper queue with
  // volPctile/capUsed metadata so the widening pays for itself with evidence.
  researchShadow: number; // 0–1, default 1 — v8.4 R5 RESEARCH-SHADOW: journal the research-aligned
  // ladder (slAtr 1.2 · rrScale 1.15 · no BE-trail) alongside every deployment and
  // settle it against the live ladder via a 1m-candle replay (db/research-shadow/).
  dislocationGate: number; // 0–1, default 1 — v10.15 DISLOCATION-GATE (SUPERVISOR proposal 2026-09-19T10:54Z,
  // operator APPROVE «تایید پیشنهادهای سوپروایزر کامل و مهندسی انجام بده» 2026-09-19T11:36Z msg 861802422):
  // cross-exchange venue-dislocation admission gate. Evidence (SUPERVISOR audit): persistent
  // venue dislocation on the big-loss symbols (GUSDT 338-366bps sustained, STRK 27-36, AR 14-24,
  // HYPERLIQUID recurring outlier) — dislocation = adverse selection, and CHASE-ADJ is
  // order-level only with no venue-consistency check. Reuses the existing 4-venue consensus
  // telemetry (marketAsset.maxDevBps, refreshed every tick). decision on the ROLLING-5-SCAN
  // median (robust to single-tick spikes). 0 = off · 1 = on: median ≥ dislocationSkipBps →
  // candidate skipped (gate-blocked, journaled); median ≥ dislocationWarnBps → admitted at
  // HALF margin, tagged DISLOCATION-HALF. Operator-forced deploys bypass (explicit human
  // override, audited). Zero-infra: no new feeds, no new DB writes.
  dislocationWarnBps: number; // 20–200, default 50 — v10.15 median-spread floor for HALF-size admission (bps)
  dislocationSkipBps: number; // 50–500, default 150 — v10.15 median-spread floor for outright skip (bps)
  probeDeploys: number; // 0–1, default 1 — v8.4.1 G4 RECOVERY PROBE DEPLOY: when the learned gate
  // is closed (G1 rolling-window WR below floor) and the deploy drought ≥2h, ONE
  // bounded probe deploy per 2h window may pass the LEARNED gate (all other
  // guards — strategy, R1 SHORT-GUARD, flow, shadow-veto — still apply) at HALF
  // margin, tagged G4-PROBE: recharges the rolling window with fresh
  // R-protected settles so the gate can reopen on new evidence. 0 = off.
}

// v6.3: minScore floor lowered 20→12 — measured pathology: the LLM governor
// requested 15 for 20+ consecutive cycles while the clamp silently pinned the
// knob at 20 (the operator-visible "MIN_SCORE is constant" behavior). The
// floor is a clamp, not policy — the evidence gate + hysteresis remain the
// real anti-noise protection.
const CLAMPS: Record<keyof GateSettings, [number, number, number]> = {
  minScore: [12, 60, 35],
  minScorePinned: [0, 1, 0],
  flowShortlist: [1, 6, 3],
  flowVetoScore: [4, 25, 8],
  universeSize: [12, 64, 40],
  ttlExtendMax: [0, 3, 1],
  ttlExtendMinutes: [15, 240, 60],
  ttlNearTpPct: [0.3, 5, 1.5],
  slAtrMult: [0.8, 2.5, 1.5],
  rrScale: [0.75, 1.35, 1.0],
  tp1RMult: [0.3, 1, 0.55],
  regimeGuard: [0, 2, 1],
  maxActive: [2, 8, 5],
  riskPerTrade: [0.5, 1.5, 1.0],
  beTrailPct: [0, 40, 10],
  shortSizeMult: [0.3, 1, 1.0],
  breakoutGuard: [0, 2, 0],
  onsetRetestGuard: [0, 1, 1],
  chaseThrAdj: [0, 15, 6],
  leveredRiskCap: [10, 100, 25],
  shortGuard: [0, 2, 2],
  beArmMovePct: [0, 10, 1.5],
  beArmRMult: [0, 1, 0.5],
  beBankFrac: [0, 0.5, 0.25],
  earlyExitGuard: [0, 1, 1],
  earlyExitFrac: [0.3, 0.9, 0.5],
  earlyExitR: [0, 1, 0.45],
  decisiveFilter: [0, 2, 1],
  decisiveErMin: [0, 1, 0.12],
  volBarrier: [0, 1, 1],
  volBarrierMult: [1.0, 2.0, 1.3],
  volBarrierCapMin: [60, 360, 240],
  volBarrierAdaptive: [0, 1, 1],
  researchShadow: [0, 1, 1],
  dislocationGate: [0, 1, 1],
  dislocationWarnBps: [20, 200, 50],
  dislocationSkipBps: [50, 500, 150],
  probeDeploys: [0, 1, 1],
};

const KEY = "gate";

let cache: { at: number; value: GateSettings } | null = null;
const CACHE_TTL = 15_000;

function clampAll(raw: Partial<GateSettings>): GateSettings {
  return {
    minScore: Math.min(CLAMPS.minScore[1], Math.max(CLAMPS.minScore[0], raw.minScore ?? CLAMPS.minScore[2])),
    minScorePinned: Math.min(CLAMPS.minScorePinned[1], Math.max(CLAMPS.minScorePinned[0], Math.round(raw.minScorePinned ?? CLAMPS.minScorePinned[2]))),
    flowShortlist: Math.min(CLAMPS.flowShortlist[1], Math.max(CLAMPS.flowShortlist[0], raw.flowShortlist ?? CLAMPS.flowShortlist[2])),
    flowVetoScore: Math.min(CLAMPS.flowVetoScore[1], Math.max(CLAMPS.flowVetoScore[0], raw.flowVetoScore ?? CLAMPS.flowVetoScore[2])),
    universeSize: Math.min(CLAMPS.universeSize[1], Math.max(CLAMPS.universeSize[0], Math.round(raw.universeSize ?? CLAMPS.universeSize[2]))),
    ttlExtendMax: Math.min(CLAMPS.ttlExtendMax[1], Math.max(CLAMPS.ttlExtendMax[0], Math.round(raw.ttlExtendMax ?? CLAMPS.ttlExtendMax[2]))),
    ttlExtendMinutes: Math.min(CLAMPS.ttlExtendMinutes[1], Math.max(CLAMPS.ttlExtendMinutes[0], Math.round(raw.ttlExtendMinutes ?? CLAMPS.ttlExtendMinutes[2]))),
    ttlNearTpPct: Math.min(CLAMPS.ttlNearTpPct[1], Math.max(CLAMPS.ttlNearTpPct[0], raw.ttlNearTpPct ?? CLAMPS.ttlNearTpPct[2])),
    slAtrMult: Math.min(CLAMPS.slAtrMult[1], Math.max(CLAMPS.slAtrMult[0], raw.slAtrMult ?? CLAMPS.slAtrMult[2])),
    rrScale: Math.min(CLAMPS.rrScale[1], Math.max(CLAMPS.rrScale[0], raw.rrScale ?? CLAMPS.rrScale[2])),
    tp1RMult: Math.min(CLAMPS.tp1RMult[1], Math.max(CLAMPS.tp1RMult[0], raw.tp1RMult ?? CLAMPS.tp1RMult[2])),
    regimeGuard: Math.min(CLAMPS.regimeGuard[1], Math.max(CLAMPS.regimeGuard[0], Math.round(raw.regimeGuard ?? CLAMPS.regimeGuard[2]))),
    maxActive: Math.min(CLAMPS.maxActive[1], Math.max(CLAMPS.maxActive[0], Math.round(raw.maxActive ?? CLAMPS.maxActive[2]))),
    riskPerTrade: Math.min(CLAMPS.riskPerTrade[1], Math.max(CLAMPS.riskPerTrade[0], raw.riskPerTrade ?? CLAMPS.riskPerTrade[2])),
    beTrailPct: Math.min(CLAMPS.beTrailPct[1], Math.max(CLAMPS.beTrailPct[0], raw.beTrailPct ?? CLAMPS.beTrailPct[2])),
    shortSizeMult: Math.min(CLAMPS.shortSizeMult[1], Math.max(CLAMPS.shortSizeMult[0], raw.shortSizeMult ?? CLAMPS.shortSizeMult[2])),
    breakoutGuard: Math.min(CLAMPS.breakoutGuard[1], Math.max(CLAMPS.breakoutGuard[0], Math.round(raw.breakoutGuard ?? CLAMPS.breakoutGuard[2]))),
    onsetRetestGuard: Math.min(CLAMPS.onsetRetestGuard[1], Math.max(CLAMPS.onsetRetestGuard[0], Math.round(raw.onsetRetestGuard ?? CLAMPS.onsetRetestGuard[2]))),
    chaseThrAdj: Math.min(CLAMPS.chaseThrAdj[1], Math.max(CLAMPS.chaseThrAdj[0], raw.chaseThrAdj ?? CLAMPS.chaseThrAdj[2])),
    leveredRiskCap: Math.min(CLAMPS.leveredRiskCap[1], Math.max(CLAMPS.leveredRiskCap[0], raw.leveredRiskCap ?? CLAMPS.leveredRiskCap[2])),
    shortGuard: Math.min(CLAMPS.shortGuard[1], Math.max(CLAMPS.shortGuard[0], Math.round(raw.shortGuard ?? CLAMPS.shortGuard[2]))),
    beArmMovePct: Math.min(CLAMPS.beArmMovePct[1], Math.max(CLAMPS.beArmMovePct[0], raw.beArmMovePct ?? CLAMPS.beArmMovePct[2])),
    beArmRMult: Math.min(CLAMPS.beArmRMult[1], Math.max(CLAMPS.beArmRMult[0], raw.beArmRMult ?? CLAMPS.beArmRMult[2])),
    beBankFrac: Math.min(CLAMPS.beBankFrac[1], Math.max(CLAMPS.beBankFrac[0], raw.beBankFrac ?? CLAMPS.beBankFrac[2])),
    earlyExitGuard: Math.min(CLAMPS.earlyExitGuard[1], Math.max(CLAMPS.earlyExitGuard[0], Math.round(raw.earlyExitGuard ?? CLAMPS.earlyExitGuard[2]))),
    earlyExitFrac: Math.min(CLAMPS.earlyExitFrac[1], Math.max(CLAMPS.earlyExitFrac[0], raw.earlyExitFrac ?? CLAMPS.earlyExitFrac[2])),
    earlyExitR: Math.min(CLAMPS.earlyExitR[1], Math.max(CLAMPS.earlyExitR[0], raw.earlyExitR ?? CLAMPS.earlyExitR[2])),
    decisiveFilter: Math.min(CLAMPS.decisiveFilter[1], Math.max(CLAMPS.decisiveFilter[0], Math.round(raw.decisiveFilter ?? CLAMPS.decisiveFilter[2]))),
    decisiveErMin: Math.min(CLAMPS.decisiveErMin[1], Math.max(CLAMPS.decisiveErMin[0], raw.decisiveErMin ?? CLAMPS.decisiveErMin[2])),
    volBarrier: Math.min(CLAMPS.volBarrier[1], Math.max(CLAMPS.volBarrier[0], Math.round(raw.volBarrier ?? CLAMPS.volBarrier[2]))),
    volBarrierMult: Math.min(CLAMPS.volBarrierMult[1], Math.max(CLAMPS.volBarrierMult[0], raw.volBarrierMult ?? CLAMPS.volBarrierMult[2])),
    volBarrierCapMin: Math.min(CLAMPS.volBarrierCapMin[1], Math.max(CLAMPS.volBarrierCapMin[0], Math.round(raw.volBarrierCapMin ?? CLAMPS.volBarrierCapMin[2]))),
    volBarrierAdaptive: Math.min(CLAMPS.volBarrierAdaptive[1], Math.max(CLAMPS.volBarrierAdaptive[0], Math.round(raw.volBarrierAdaptive ?? CLAMPS.volBarrierAdaptive[2]))),
    researchShadow: Math.min(CLAMPS.researchShadow[1], Math.max(CLAMPS.researchShadow[0], Math.round(raw.researchShadow ?? CLAMPS.researchShadow[2]))),
    dislocationGate: Math.min(CLAMPS.dislocationGate[1], Math.max(CLAMPS.dislocationGate[0], Math.round(raw.dislocationGate ?? CLAMPS.dislocationGate[2]))),
    dislocationWarnBps: Math.min(CLAMPS.dislocationWarnBps[1], Math.max(CLAMPS.dislocationWarnBps[0], raw.dislocationWarnBps ?? CLAMPS.dislocationWarnBps[2])),
    dislocationSkipBps: Math.min(CLAMPS.dislocationSkipBps[1], Math.max(CLAMPS.dislocationSkipBps[0], raw.dislocationSkipBps ?? CLAMPS.dislocationSkipBps[2])),
    probeDeploys: Math.min(CLAMPS.probeDeploys[1], Math.max(CLAMPS.probeDeploys[0], Math.round(raw.probeDeploys ?? CLAMPS.probeDeploys[2]))),
  };
}

export async function getGateSettings(): Promise<GateSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    const value = row ? clampAll(JSON.parse(row.value) as Partial<GateSettings>) : clampAll({});
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return clampAll({});
  }
}

export async function putGateSettings(next: Partial<GateSettings>): Promise<GateSettings> {
  // merge against CURRENT stored values — a partial update must never reset
  // untouched keys back to defaults (governor applies decisions one at a time)
  const cur = await getGateSettings();
  const value = clampAll({ ...cur, ...next });
  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
  cache = { at: Date.now(), value };
  return value;
}

export function describeGate(g: GateSettings): string {
  const ttlGate = g.ttlExtendMax > 0 ? `+${g.ttlExtendMinutes}m ×≤${g.ttlExtendMax} @${g.ttlNearTpPct}%` : "OFF";
  const beTrail = g.beArmRMult > 0 ? `R×${g.beArmRMult.toFixed(2)}${g.beTrailPct > 0 ? `+${g.beTrailPct}%NET` : ""}+${g.beArmMovePct}%px` : g.beTrailPct > 0 ? `+${g.beTrailPct}%NET` : "OFF";
  const beBank = g.beBankFrac > 0 ? `BANK ${Math.round(g.beBankFrac * 100)}%` : "NO-BANK";
  const boGuard = g.breakoutGuard === 0 ? "OFF" : g.breakoutGuard === 1 ? "HALF-SIZE" : "VETO";
  const sg = g.shortGuard === 0 ? "OFF" : g.shortGuard === 1 ? "HTF-ALIGN" : "VETO";
  const early = g.earlyExitGuard ? `${Math.round(g.earlyExitFrac * 100)}%TTL@${g.earlyExitR.toFixed(2)}R` : "OFF";
  const dec = g.decisiveFilter === 0 ? "OFF" : g.decisiveFilter === 1 ? "ON×0.85" : "STRICT";
  const vb = g.volBarrier ? `ON×${g.volBarrierMult.toFixed(2)}@≤${g.volBarrierCapMin}m${g.volBarrierAdaptive ? `-ADAPTIVE(→${3 * g.volBarrierCapMin}m@p0)` : ""}` : "OFF";
  return `MIN_SCORE ${g.minScore}${g.minScorePinned ? " [PINNED]" : ""}(+dynamic thrAdj) · DECISIVE ${dec}@ER≥${g.decisiveErMin.toFixed(2)} · VOL-BARRIER ${vb} · FLOW-SHORTLIST ${g.flowShortlist} · FLOW-VETO ≤−${g.flowVetoScore} · UNIVERSE ${g.universeSize} · TTL-GATE ${ttlGate} · SL ${g.slAtrMult}×ATR · RR×${g.rrScale.toFixed(2)} · TP1 ${g.tp1RMult.toFixed(2)}R · REGIME-GUARD L${g.regimeGuard} · CAP ${g.maxActive} · RISK ×${g.riskPerTrade.toFixed(2)} · BE-TRAIL ${beTrail}·${beBank} · SHORT-GUARD ${sg} · EARLY-EXIT ${early} · R-SHADOW ${g.researchShadow ? "ON" : "OFF"} · G4-PROBE ${g.probeDeploys ? "ON@2h×0.5" : "OFF"} · SHORT-SIZE ×${g.shortSizeMult.toFixed(2)} · BREAKOUT-GUARD ${boGuard} · ONSET-RETEST ${g.onsetRetestGuard ? "ON@30%·CHASE+FADE" : "OFF"} · CHASE-ADJ +${g.chaseThrAdj} · RISK-CAP ${g.leveredRiskCap}% · DISLOCATION-GATE ${g.dislocationGate ? `ON@${g.dislocationWarnBps}/${g.dislocationSkipBps}bps` : "OFF"}`;
}

/** v6.3: the clamp table is part of the governor's grounding — the LLM must
 * see the legal range for every knob it controls, otherwise it burns cycles
 * requesting values the core silently rejects (the MIN_SCORE-constant bug). */
export function describeClamps(): string {
  return Object.entries(CLAMPS)
    .map(([k, [lo, hi, def]]) => `${k}[${lo}..${hi}]=${def}`)
    .join(" ");
}

export function gateClamps(): Record<keyof GateSettings, [number, number, number]> {
  return CLAMPS;
}
