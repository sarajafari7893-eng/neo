/**
 * VERIFY-CALIBRATION-CLAIM (rebuilt 2026-09-07 after sandbox rollback).
 * Cross-checks the governor/calibration claim chain:
 *  1. EngineSetting calibration weights — present? ACTIVE or WARMUP?
 *  2. Recompute per-factor WR from ALL settled signals (deployer-agnostic)
 *     and compare with the stored weights.
 *  3. Learned-gate thresholds (settled ≥ 8, WR ≥ 25%) — restate honestly.
 * Run: bun scripts/verify-calibration-claim.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const SETTLED = ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"];

interface StoredWeights { [factor: string]: number }

async function main() {
  const rows = await db.engineSetting.findMany();
  const calib = rows.find((r) => r.key.includes("calibration") || r.key.includes("weight"));
  console.log("── ENGINE SETTINGS ──");
  for (const r of rows) console.log(`${r.key.padEnd(28)} = ${r.value.slice(0, 120)}`);

  const settled = await db.signal.findMany({
    where: { status: { in: SETTLED } },
    select: { factorsJson: true, pnlPercent: true, tags: true, serial: true },
  });
  console.log(`\n── SETTLED OUTCOMES: n=${settled.length} ──`);

  const perFactor = new Map<string, { n: number; wins: number }>();
  for (const s of settled) {
    if (!s.factorsJson) continue;
    let votes: Array<{ factor: string; vote: number }> = [];
    try { votes = JSON.parse(s.factorsJson) as Array<{ factor: string; vote: number }>; } catch { continue; }
    const win = s.pnlPercent > 0;
    for (const v of votes) {
      const key = `${v.factor}|${v.vote > 0 ? "bull" : v.vote < 0 ? "bear" : "zero"}`;
      const cur = perFactor.get(key) ?? { n: 0, wins: 0 };
      cur.n++;
      if (win) cur.wins++;
      perFactor.set(key, cur);
    }
  }

  console.log("\nFACTOR|SIDE        n   WR     (calibration eligible at n≥10 per factor, ACTIVE at ≥30 settled overall)");
  const sorted = [...perFactor.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [key, st] of sorted) {
    const wr = st.n ? ((st.wins / st.n) * 100).toFixed(1) : "--";
    console.log(`${key.padEnd(18)} ${String(st.n).padStart(3)}  ${wr.padStart(5)}%`);
  }

  if (calib) {
    try {
      const stored = JSON.parse(calib.value) as StoredWeights | { weights: StoredWeights };
      console.log("\n── STORED CALIBRATION WEIGHTS ──");
      console.log(JSON.stringify(stored, null, 1).slice(0, 800));
    } catch {
      console.log("\nstored calibration value is not JSON weights (raw above)");
    }
  } else {
    console.log("\nno calibration weight setting found — calibrator in WARMUP (expected < 30 settled)");
  }

  const wins = settled.filter((s) => s.pnlPercent > 0).length;
  const wr = settled.length ? (wins / settled.length) * 100 : 0;
  console.log(`\n── LEARNED GATE RESTATED ──`);
  console.log(`settled ${settled.length} (need ≥8) · realized WR ${wr.toFixed(1)}% (need ≥25%) · auto-deploy ${settled.length >= 8 && wr >= 25 ? "ALLOWED" : "SUPPRESSED"}`);
  console.log(`vol-onset tagged settled: ${settled.filter((s) => s.tags.split(",").map((t) => t.trim()).includes("VOL-ONSET")).length}`);
  process.exit(0);
}

void main();
export {};
