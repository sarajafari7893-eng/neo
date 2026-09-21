/**
 * mine-expectancy.ts — EDGE-POCKET MINER (operator question #3)
 * «از سیگنال‌های ارسال‌شده تا الان بک‌تست بگیر تا ستاپ‌های expectancy بالا رو پیدا کنی»
 *
 * Slices the settled-signal history along five measured dimensions, ranks the
 * pockets by realized NET expectancy, persists the significant ones into
 * EngineSetting "edge.pockets" (the deployment gate reads them: positive →
 * +8..10 score bonus, negative → +6 threshold surcharge / SKIP at ≤ −6%), and
 * prints the full report. Read-only against signals; the only write is the
 * pocket memory. Safe to re-run any time — also invoked by the auto-learner.
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const db = new PrismaClient();

interface EdgePocket {
  key: string;
  kind: string;
  n: number;
  wr: number;
  exp: number;
  netUsd: number;
  pf: number;
}

interface Row {
  symbol: string;
  strategy: string;
  timeframe: string;
  confidence: number;
  regime: string;
  hourBucket: string;
  netPct: number; // fee-net pnlPercent
  netUsd: number;
  tp: boolean; // TP-proven
}

const REGIMES = ["CHOP", "TREND-UP", "TREND-DOWN", "VOLATILE"];

function regimeOf(tags: string): string {
  // v6.4.3 FIX: history stores prefixed tags (REGIME-CHOP / REGIME-TREND-UP /
  // REGIME-TREND-DOWN) — the old bare-name matcher never matched, so the
  // strategy+regime mining dimension was silently empty. REGIME-UNKNOWN is
  // excluded (no information).
  const t = (tags || "").split(",").map((x) => x.trim().toUpperCase());
  const raw = t.find((x) => x.startsWith("REGIME-"));
  if (!raw) return "";
  const regime = raw.replace(/^REGIME-/, "");
  return REGIMES.includes(regime) ? regime : "";
}

function bucketify(rows: Row[], keyFn: (r: Row) => string | null, kind: string, minN: number): EdgePocket[] {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    const arr = map.get(k) ?? [];
    arr.push(r);
    map.set(k, arr);
  }
  const out: EdgePocket[] = [];
  for (const [key, arr] of map) {
    if (arr.length < minN) continue;
    const n = arr.length;
    const exp = arr.reduce((a, r) => a + r.netPct, 0) / n;
    const netUsd = arr.reduce((a, r) => a + r.netUsd, 0);
    const gains = arr.filter((r) => r.netUsd > 0).reduce((a, r) => a + r.netUsd, 0);
    const losses = Math.abs(arr.filter((r) => r.netUsd < 0).reduce((a, r) => a + r.netUsd, 0));
    const wr = (100 * arr.filter((r) => r.tp).length) / n;
    out.push({ key, kind, n, wr, exp, netUsd, pf: losses > 0 ? Math.min(99, gains / losses) : 99 });
  }
  return out;
}

async function main() {
  const settled = await db.signal.findMany({
    where: { status: { in: ["TP1", "TP2", "TP3", "SL", "EXPIRED", "CLOSED"] } },
    select: { symbol: true, strategy: true, timeframe: true, confidence: true, tags: true, createdAt: true, pnlPercent: true, marginUsd: true, feeUsd: true, reachedTp: true },
  });

  const rows: Row[] = settled.map((s) => {
    const margin = Math.max(1, s.marginUsd);
    const feePct = ((s.feeUsd || 0) / margin) * 100;
    const netPct = (s.pnlPercent || 0) - feePct;
    const h = Math.floor(s.createdAt.getUTCHours() / 4) * 4;
    return {
      symbol: s.symbol,
      strategy: s.strategy,
      timeframe: s.timeframe,
      confidence: s.confidence,
      regime: regimeOf(s.tags),
      hourBucket: `${h}-${h + 3}Z`,
      netPct,
      netUsd: (netPct / 100) * margin,
      tp: s.reachedTp >= 1,
    };
  });

  console.log(`MINING ${rows.length} settled signals → 5 dimensions`);

  const all: EdgePocket[] = [
    ...bucketify(rows, (r) => `${r.symbol}+${r.strategy}`, "symbol+strategy", 6),
    ...bucketify(rows, (r) => (r.regime ? `${r.strategy}+${r.regime}` : null), "strategy+regime", 6),
    ...bucketify(rows, (r) => `${r.strategy}+${r.timeframe}`, "strategy+timeframe", 6),
    ...bucketify(rows, (r) => (r.confidence >= 85 ? "85+" : r.confidence >= 75 ? "75-84" : r.confidence >= 65 ? "65-74" : "55-64"), "confidence-band", 8),
    ...bucketify(rows, (r) => r.hourBucket, "hour-bucket", 8),
  ];

  const positive = all
    .filter((p) => p.exp >= 2)
    .sort((a, b) => b.exp * Math.sqrt(b.n) - a.exp * Math.sqrt(a.n))
    .slice(0, 10);
  const negative = all
    .filter((p) => p.exp <= -2)
    .sort((a, b) => a.exp * Math.sqrt(a.n) - b.exp * Math.sqrt(b.n))
    .slice(0, 10);

  console.log("\n══ PROVEN EDGES (exp ≥ +2%/trade) ══");
  for (const p of positive) console.log(`  ${p.key.padEnd(26)} n=${String(p.n).padStart(3)} WR ${p.wr.toFixed(0).padStart(3)}%  exp ${p.exp >= 0 ? "+" : ""}${p.exp.toFixed(2)}%/trade  Σ$${p.netUsd.toFixed(2)}  PF ${p.pf.toFixed(2)}  [${p.kind}]`);
  if (!positive.length) console.log("  (none yet)");
  console.log("\n══ TRAPS (exp ≤ −2%/trade) ══");
  for (const p of negative) console.log(`  ${p.key.padEnd(26)} n=${String(p.n).padStart(3)} WR ${p.wr.toFixed(0).padStart(3)}%  exp ${p.exp.toFixed(2)}%/trade  Σ$${p.netUsd.toFixed(2)}  PF ${p.pf.toFixed(2)}  [${p.kind}]`);
  if (!negative.length) console.log("  (none)");

  const payload = JSON.stringify({ at: new Date().toISOString(), samples: rows.length, positive, negative });
  await db.engineSetting.upsert({ where: { key: "edge.pockets" }, create: { key: "edge.pockets", value: payload }, update: { value: payload } });

  // protocol artifact for the engineer bridge log
  const respPath = path.join(process.cwd(), "sandbox-inbox", "engineer-responses.jsonl");
  try {
    const line = JSON.stringify({ id: `RES-${Date.now().toString(36)}`, at: new Date().toISOString(), title: "Expectancy miner run — edge pockets persisted", status: "DONE", note: `${rows.length} settled mined · ${positive.length} positive / ${negative.length} negative pockets ≥/≤ ±2%/trade persisted to edge.pockets (gate: +8..10 bonus / +6 surcharge / SKIP ≤ −6%)` }) + "\n";
    fs.appendFileSync(respPath, line);
  } catch {/* best-effort */}

  console.log(`\nPERSISTED edge.pockets (${positive.length}+ / ${negative.length}−) — engine gate + governor now read them`);
}

main()
  .catch((e) => {
    console.error("MINER ERROR", e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
