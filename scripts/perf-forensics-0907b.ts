/**
 * PERF FORENSICS — «چرا بازدهی منفی زیادی از ردیابی سیگنالها دارد؟»
 * (operator mandate 2026-09-07 + 6 follow-up questions)
 *
 * READ-ONLY analysis. No engine changes. Evidence for:
 *  Q1 BREAKOUT veto vs stricter filter   Q2 50%TP1+BE vs full TP1 exit
 *  Q3 why no self-calibration yet        Q4 smarter TTL
 *  Q5 chop dominance                     Q6 answers only, no changes
 *
 * Run: bun scripts/perf-forensics-0907b.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const TAKER_RT = 0.001; // 0.05% × 2 sides
const FUND_8H = 0.0001;
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

const f2 = (n: number) => n.toFixed(2);
const usd = (n: number) => `${n >= 0 ? "+" : ""}$${f2(n)}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${f2(n)}%`;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]!; };

function feeUsd(notional: number, minutes: number) {
  return notional * TAKER_RT + notional * FUND_8H * (minutes / 480);
}

interface Row {
  symbol: string; serial: number; strategy: string; status: string; direction: string;
  entry: number; tp1: number; tp3: number; stop: number; rr: number; lev: number; margin: number;
  pnl: number; maxPnl: number; maxPost: number; reachedTp: number; afterlife: string | null;
  ttl: number; ext: number; heldMin: number; tags: string; confidence: number; timeframe: string;
}

async function main() {
  const all = await db.signal.findMany({ orderBy: { createdAt: "asc" } });
  const now = Date.now();
  const rows: Row[] = all.map((s) => ({
    symbol: s.symbol, serial: s.serial ?? 0, strategy: s.strategy, status: s.status, direction: s.direction,
    entry: s.entryPrice, tp1: s.tp1, tp3: s.tp3, stop: s.stopLoss, rr: s.riskReward, lev: s.leverage, margin: s.marginUsd,
    pnl: s.pnlPercent, maxPnl: s.maxPnlPercent, maxPost: s.maxPostPnlPercent, reachedTp: s.reachedTp,
    afterlife: s.afterlife, ttl: s.ttlMinutes, ext: s.ttlExtensions,
    heldMin: s.closedAt ? (s.closedAt.getTime() - s.createdAt.getTime()) / 60000 : (now - s.createdAt.getTime()) / 60000,
    tags: s.tags ?? "", confidence: s.confidence, timeframe: s.timeframe,
  }));
  const settled = rows.filter((r) => SETTLED.includes(r.status));
  const open = rows.filter((r) => !SETTLED.includes(r.status));
  const $ = (r: Row) => (r.margin * r.pnl) / 100;

  // ── 1. GLOBAL LEDGER ──────────────────────────────────────────
  console.log("══ 1. GLOBAL LEDGER ══");
  console.log(`signals total=${rows.length} settled=${settled.length} open=${open.length}`);
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log("status:", [...byStatus.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  const recordedRealized = settled.reduce((a, r) => a + $(r), 0);
  const fees = settled.reduce((a, r) => a + feeUsd(r.margin * r.lev, r.heldMin), 0);
  console.log(`recorded realized = ${usd(recordedRealized)} · est fees+swap burned = ${usd(-fees)}`);

  // ── helpers ───────────────────────────────────────────────────
  const winNet = (r: Row) => r.pnl > 0;
  const winTp = (r: Row) => r.pnl > 0 || r.reachedTp >= 1;
  function groupPrint(label: string, keyFn: (r: Row) => string, pool: Row[]) {
    const g = new Map<string, Row[]>();
    for (const r of pool) { const k = keyFn(r); if (!k) continue; (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
    console.log(`── ${label} ──`);
    const out: string[] = [];
    for (const [k, rs] of [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const n = rs.length;
      const wrN = (100 * rs.filter(winNet).length) / n;
      const wrT = (100 * rs.filter(winTp).length) / n;
      const net = rs.reduce((a, r) => a + $(r), 0);
      const exp = mean(rs.map((r) => r.pnl));
      out.push(`${k}: n=${n} WR(net)=${f2(wrN)}% WR(tp-proven)=${f2(wrT)}% Σ=${usd(net)} exp=${pct(exp)}/trade`);
    }
    console.log(out.join("\n"));
  }

  // ── 2. STRATEGY MATRIX ────────────────────────────────────────
  console.log("\n══ 2. STRATEGY MATRIX (settled) ══");
  groupPrint("strategy", (r) => r.strategy, settled);

  // ── 3. REGIME MATRIX (full history from tags) ────────────────
  console.log("\n══ 3. REGIME MATRIX (settled, from tags) ══");
  groupPrint("regime", (r) => r.tags.split(",").find((t) => t.startsWith("REGIME-")) ?? "", settled);
  const allRegime = new Map<string, number>();
  for (const r of rows) { const k = r.tags.split(",").find((t) => t.startsWith("REGIME-")) ?? "UNKNOWN"; allRegime.set(k, (allRegime.get(k) ?? 0) + 1); }
  console.log("deploy regime share (all", rows.length, "):", [...allRegime.entries()].map(([k, v]) => `${k}=${v}(${Math.round((100 * v) / rows.length)}%)`).join(" "));

  console.log("\n══ 3b. STRATEGY × REGIME (settled Σ$) ══");
  const sr = new Map<string, Row[]>();
  for (const r of settled) {
    const reg = r.tags.split(",").find((t) => t.startsWith("REGIME-")) ?? "UNKNOWN";
    const k = `${r.strategy}|${reg}`;
    (sr.get(k) ?? sr.set(k, []).get(k)!).push(r);
  }
  for (const [k, rs] of [...sr.entries()].sort((a, b) => (a[1]!.length) - (b[1]!.length)).reverse()) {
    const net = rs.reduce((a, r) => a + $(r), 0);
    console.log(`${k}: n=${rs.length} WR=${f2((100 * rs.filter(winNet).length) / rs.length)}% Σ=${usd(net)}`);
  }

  // ── 4. CROSS-CUTS ─────────────────────────────────────────────
  console.log("\n══ 4. CROSS-CUTS (settled) ══");
  groupPrint("direction", (r) => r.direction, settled);
  groupPrint("confidence", (r) => (r.confidence >= 75 ? "75+" : r.confidence >= 65 ? "65-74" : "55-64"), settled);
  groupPrint("flow", (r) => r.tags.split(",").find((t) => t.startsWith("FLOW-")) ?? "", settled);
  groupPrint("timeframe", (r) => r.timeframe, settled);

  // ── 5. ACCOUNTING DEFECT A: TP3 zeroed by trailed-stop slDist ─
  console.log("\n══ 5. DEFECT A — TP3 pnl computed from MOVED stop (slDist=0 → win zeroed) ══");
  let defectADelta = 0;
  for (const r of settled.filter((r) => r.status === "TP3")) {
    const sgn = r.direction === "LONG" ? 1 : -1;
    const tp3MoveU = ((r.tp3 - r.entry) / r.entry) * sgn * 100; // UNLEVERED %
    const trueNet = ((r.margin * r.lev * tp3MoveU) / 100 - feeUsd(r.margin * r.lev, r.heldMin)); // notional × unlevered move
    const truePct = (100 * trueNet) / r.margin;
    const delta = (r.margin * (truePct - r.pnl)) / 100;
    if (delta > 0.5) {
      defectADelta += delta;
      console.log(`NX-${String(r.serial).padStart(4, "0")} ${r.symbol} TP3 margin=$${f2(r.margin)} recorded=${pct(r.pnl)} true≈${pct(truePct)} → understated ${usd(delta)}`);
    }
  }
  console.log(`DEFECT A total understatement = ${usd(defectADelta)}`);

  // ── 5b. PER-STATUS Σ$ ────────────────────────────────────────
  console.log("\n══ 5b. SETTLED Σ$ BY STATUS ══");
  const st = new Map<string, Row[]>();
  for (const r of settled) (st.get(r.status) ?? st.set(r.status, []).get(r.status)!).push(r);
  for (const [k, rs] of [...st.entries()].sort((a, b) => a[1]!.reduce((x, r) => x + $(r), 0) - b[1]!.reduce((x, r) => x + $(r), 0))) {
    console.log(`${k}: n=${rs.length} Σ=${usd(rs.reduce((a, r) => a + $(r), 0))} avg=${usd(mean(rs.map($)))}`);
  }

  // ── 6. DEFECT B + Q2: TP1-banked gap & B-vs-C counterfactual ─
  // B (current rules): 50% out at TP1 + runner to effective stop / TP3 / expiry mark
  // C (full exit at TP1): 100% out at TP1
  console.log("\n══ 6. Q2 COUNTERFACTUAL — reachedTp>=1 settled cohort ══");
  const cohort = settled.filter((r) => r.reachedTp >= 1);
  const noTp1 = settled.filter((r) => r.reachedTp === 0);
  let sumRec = 0, sumB = 0, sumC = 0;
  const perStatus = new Map<string, { n: number; rec: number; b: number; c: number }>();
  for (const r of cohort) {
    const sgn = r.direction === "LONG" ? 1 : -1;
    const notional = r.margin * r.lev;
    const tp1MoveU = ((r.tp1 - r.entry) / r.entry) * sgn * 100;
    let runnerMoveU: number;
    if (r.status === "SL") runnerMoveU = ((r.stop - r.entry) / r.entry) * sgn * 100;
    else if (r.status === "TP3") runnerMoveU = ((r.tp3 - r.entry) / r.entry) * sgn * 100;
    else { // EXPIRED / CLOSED — derive mark move from recorded net (invert fees)
      const feePctLev = (100 * feeUsd(notional, r.heldMin)) / r.margin;
      runnerMoveU = (r.pnl + feePctLev) / r.lev;
    }
    const feeFull = feeUsd(notional, r.heldMin);
    const rec = $(r);
    const bUsd = 0.5 * notional * ((tp1MoveU + runnerMoveU) / 100) - feeFull;
    const cUsd = notional * (tp1MoveU / 100) - feeUsd(notional, Math.min(r.heldMin, 120));
    sumRec += rec; sumB += bUsd; sumC += cUsd;
    const cell = perStatus.get(r.status) ?? { n: 0, rec: 0, b: 0, c: 0 };
    cell.n++; cell.rec += rec; cell.b += bUsd; cell.c += cUsd;
    perStatus.set(r.status, cell);
  }
  console.log(`cohort n=${cohort.length} (reachedTp=0 settled: ${noTp1.length} — identical under all scenarios)`);
  for (const [k, v] of perStatus) console.log(`  ${k}: n=${v.n} recorded=${usd(v.rec)} B(50%TP1+runner)=${usd(v.b)} C(fullTP1)=${usd(v.c)}`);
  console.log(`COHORT TOTAL — recorded=${usd(sumRec)} · B=${usd(sumB)} · C=${usd(sumC)} · C−B=${usd(sumC - sumB)}`);

  // ── 7. CORRECTED REALIZED (economics under current rules) ────
  console.log("\n══ 7. CORRECTED REALIZED LEDGER ══");
  const recNoTp1 = noTp1.reduce((a, r) => a + $(r), 0);
  // B already uses true tp3 price → defect A fixed inside B
  const corrected = recNoTp1 + sumB;
  console.log(`recorded realized = ${usd(recordedRealized)}`);
  console.log(`corrected (reachedTp=0 recorded + cohort B-economics) = ${usd(corrected)} (Δ ${usd(corrected - recordedRealized)})`);
  const openUnrl = open.reduce((a, r) => a + $(r), 0);
  console.log(`open unrealized (recorded) = ${usd(openUnrl)} · equity≈ start$100 + corrected + open = $${f2(100 + corrected + openUnrl)}`);

  // ── 8. TTL FORENSICS (Q4) ─────────────────────────────────────
  console.log("\n══ 8. TTL FORENSICS ══");
  const expired = settled.filter((r) => r.status === "EXPIRED");
  console.log(`EXPIRED n=${expired.length}`);
  const af = new Map<string, number>();
  for (const r of expired) af.set(r.afterlife ?? "none", (af.get(r.afterlife ?? "none") ?? 0) + 1);
  console.log("afterlife:", [...af.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  const tpAfter = expired.filter((r) => (r.afterlife ?? "").includes("TP"));
  const resolvedAf = expired.filter((r) => r.afterlife && r.afterlife !== "TRACKING" && r.afterlife !== "FLAT");
  console.log(`would-have-hit-TP after expiry: ${tpAfter.length}/${resolvedAf.length} resolved (${resolvedAf.length ? f2((100 * tpAfter.length) / resolvedAf.length) : "0"}%)`);
  const mfePos = expired.filter((r) => r.maxPost > 0);
  console.log(`post-expiry MFE>0: ${mfePos.length}/${expired.length} avg MFE when>0 = ${pct(mean(mfePos.map((r) => r.maxPost)))} max=${pct(Math.max(0, ...expired.map((r) => r.maxPost)))}`);
  const ttlByOutcome = new Map<string, number[]>();
  for (const r of settled) { (ttlByOutcome.get(r.status) ?? ttlByOutcome.set(r.status, []).get(r.status)!).push(r.ttl); }
  for (const [k, v] of ttlByOutcome) console.log(`ttlMinutes by ${k}: avg=${f2(mean(v))} med=${f2(med(v))}`);
  groupPrint("EXPIRED ttl by strategy", (r) => (r.status === "EXPIRED" ? r.strategy : ""), expired);
  const extS = settled.filter((r) => r.ext > 0);
  const extNet = extS.reduce((a, r) => a + $(r), 0);
  console.log(`ttlExtensions>0 settled: n=${extS.length} Σ=${usd(extNet)} outcomes:`, extS.map((r) => r.status).join(","));
  const extByStatus = new Map<string, number>();
  for (const r of rows.filter((r) => r.ext > 0)) extByStatus.set(r.status, (extByStatus.get(r.status) ?? 0) + 1);
  console.log("extended signals by final status (all):", [...extByStatus.entries()].map(([k, v]) => `${k}:${v}`).join(" "));
  // SL before TP1 with MFE near TP1 (round-trips)
  const sls = settled.filter((r) => r.status === "SL");
  const rt = sls.filter((r) => r.maxPnl >= 10);
  console.log(`SL cohort n=${sls.length} · round-trips (MFE≥+10% lev): ${rt.length} (${f2((100 * rt.length) / Math.max(1, sls.length))}%) avgMFE=${pct(mean(rt.map((r) => r.maxPnl)))}`);
  const buckets: Array<[string, number, number]> = [["0-5%", 0, 5], ["5-15%", 5, 15], ["15-25%", 15, 25], ["25%+", 25, 999]];
  for (const [lbl, lo, hi] of buckets) {
    const b = sls.filter((r) => r.maxPnl >= lo && r.maxPnl < hi);
    console.log(`  SL MFE ${lbl}: n=${b.length} Σ=${usd(b.reduce((a, r) => a + $(r), 0))}`);
  }

  // ── 9. Q1 — BREAKOUT sub-cohorts (can a stricter filter save it?) ──
  console.log("\n══ 9. BREAKOUT SUB-COHORTS ══");
  groupPrint("BREAKOUT × flow", (r) => (r.strategy === "BREAKOUT" ? r.tags.split(",").find((t) => t.startsWith("FLOW-")) ?? "" : ""), settled);
  groupPrint("BREAKOUT × confidence", (r) => (r.strategy === "BREAKOUT" ? (r.confidence >= 75 ? "75+" : r.confidence >= 65 ? "65-74" : "55-64") : ""), settled);
  groupPrint("BREAKOUT × direction", (r) => (r.strategy === "BREAKOUT" ? r.direction : ""), settled);
  const boWinners = settled.filter((r) => r.strategy === "BREAKOUT" && (r.pnl > 0 || r.reachedTp >= 1));
  console.log(`BREAKOUT tp-proven winners: ${boWinners.length} →`, boWinners.map((r) => `NX-${r.serial} ${r.symbol} ${r.status} ${pct(r.pnl)}`).join(" · ") || "none");

  // ── 10. Q5 — chop × strategy severity ────────────────────────
  console.log("\n══ 10. CHOP × STRATEGY (settled) ══");
  groupPrint("in-CHOP strategy", (r) => (r.tags.includes("REGIME-CHOP") ? r.strategy : ""), settled);

  // ── 11. verdict inputs ────────────────────────────────────────
  console.log("\n══ 11. HEADLINES ══");
  const topLosers = [...settled].sort((a, b) => $(a) - $(b)).slice(0, 8);
  console.log("top losers:", topLosers.map((r) => `NX-${r.serial} ${r.symbol} ${r.strategy} ${r.status} ${usd($(r))} MFE${pct(r.maxPnl)}`).join(" · "));
  console.log(`SHORT book: n=${settled.filter((r) => r.direction === "SHORT").length} Σ=${usd(settled.filter((r) => r.direction === "SHORT").reduce((a, r) => a + $(r), 0))}`);
  console.log(`LONG book: n=${settled.filter((r) => r.direction === "LONG").length} Σ=${usd(settled.filter((r) => r.direction === "LONG").reduce((a, r) => a + $(r), 0))}`);
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
