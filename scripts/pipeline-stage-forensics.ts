// ── PIPELINE STAGE FORENSICS (trace 1a18f1e500a55ab5 — «چرا هنوز سیگنال نیست») ──
// Stage-by-stage attribution of the last N minutes of engine journal activity:
// how many candidates scored, how far from the score gate, which gate killed
// the survivors. Plus engine-input data freshness proof.
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const db = new PrismaClient();
const WINDOW_MIN = Number(process.argv[2] ?? 90);

async function main() {
  const now = Date.now();
  const cut = now - WINDOW_MIN * 60_000;

  // ── ① journal parse (gate-journal.jsonl) ──
  const lines = readFileSync(".data/gate-journal.jsonl", "utf8").split("\n");
  const samples: Array<{ at: number; symbol: string; strategy: string; score: number; effMin: number; gap: number; band: string }> = [];
  const blocks: Array<{ at: number; symbol: string; reason: string }> = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      const v = r.v ?? r;
      const at = v.at ?? 0;
      if (!at || at < cut) continue;
      if (r.k === "s") samples.push({ at, symbol: v.symbol, strategy: v.strategy, score: v.score, effMin: v.effMin, gap: v.gap, band: v.band });
      else if (r.k === "b") blocks.push({ at, symbol: v.symbol, reason: v.reason ?? "" });
    } catch { /* skip */ }
  }
  console.log(`== WINDOW: last ${WINDOW_MIN}min ==`);
  console.log(`score-gate samples: ${samples.length} | hard blocks: ${blocks.length}`);

  // best |score| vs effMin — how far is the closest candidate?
  const byBest = [...samples].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 8);
  console.log("\n-- TOP |score| candidates (score vs effMin, gap<0 = short of gate) --");
  for (const s of byBest) console.log(`${new Date(s.at).toISOString().slice(11, 19)} ${s.symbol.padEnd(14)} ${s.strategy.padEnd(12)} score=${String(s.score).padStart(5)} effMin=${String(s.effMin).padStart(3)} gap=${String(s.gap).padStart(5)} ${s.band}`);
  const bestGap = Math.max(...samples.map((s) => s.gap));
  const passCount = samples.filter((s) => s.band === "PASS").length;
  const boundary = samples.filter((s) => s.band === "BOUNDARY").length;
  console.log(`\nbest gap = ${bestGap} | PASS=${passCount} BOUNDARY=${boundary} REJECT=${samples.length - passCount - boundary}`);
  // what if minScore were 12? recompute: effMin' = effMin - 17 + 12
  const passAt12 = samples.filter((s) => Math.abs(s.score) >= s.effMin - 5).length;
  const passAt8 = samples.filter((s) => Math.abs(s.score) >= s.effMin - 9).length;
  console.log(`would-pass at minScore=12: ${passAt12}/${samples.length} | at minScore=8: ${passAt8}/${samples.length}`);

  // block attribution by gate family
  const fam: Record<string, number> = {};
  for (const b of blocks) {
    const g = b.reason.startsWith("CHOP") ? "REGIME-CHOP"
      : b.reason.startsWith("SHORT-GUARD") ? "SHORT-GUARD"
      : b.reason.startsWith("STALE") ? "STALE-ANCHOR"
      : b.reason.startsWith("TREND") ? "REGIME-TREND"
      : b.reason.startsWith("VOLATILE") ? "REGIME-VOLATILE"
      : b.reason.split(" ")[0]!.slice(0, 22);
    fam[g] = (fam[g] ?? 0) + 1;
  }
  console.log("\n-- blocks by gate family --");
  for (const [g, c] of Object.entries(fam).sort((a, b) => b[1] - a[1])) console.log(`  ${g.padEnd(24)} ${c}`);
  // chop strength split (long vs short)
  const chopLong = blocks.filter((b) => b.reason.startsWith("CHOP") && b.reason.includes("LONG vetoed")).length;
  const chopFam = blocks.filter((b) => b.reason.startsWith("CHOP") && (b.reason.includes("breakout/momentum") || b.reason.includes("scalp"))).length;
  console.log(`  (chop-LONG-veto=${chopLong}, chop-BR/MOM/SCALP=${chopFam})`);

  // ── ② engine input freshness ──
  const fut = JSON.parse(readFileSync(".data/futws-quotes.json", "utf8")) as Record<string, { t?: number }>;
  const ages = Object.values(fut).map((r) => now - (r.t ?? 0)).filter((a) => a >= 0);
  const stale = ages.filter((a) => a > 30_000).length;
  console.log(`\n== ENGINE INPUT: futws quotes = ${ages.length} symbols, stale(>30s) = ${stale}, maxAge = ${(Math.max(...ages) / 1000).toFixed(0)}s`);
  const spot = JSON.parse(readFileSync(".data/spotws-quotes.json", "utf8")) as Record<string, { t?: number }>;
  const sages = Object.values(spot).map((r) => now - (r.t ?? 0)).filter((a) => a >= 0);
  console.log(`spotws quotes = ${sages.length} rows, stale(>30s) = ${sages.filter((a) => a > 30_000).length}, maxAge = ${(Math.max(...sages) / 1000).toFixed(0)}s`);

  // ── ③ recent signals + kline evidence (candidates scored ⇒ candles reached the engine) ──
  const recent = await db.signal.findMany({ orderBy: { createdAt: "desc" }, take: 3, select: { serial: true, symbol: true, createdAt: true } });
  console.log("\nlast signal:", recent[0] ? `NX-${recent[0]!.serial} ${recent[0]!.symbol} @ ${recent[0]!.createdAt.toISOString()}` : "none");
  console.log(`candidates WERE scored & regime-classified in window ⇒ 80-candle live feed reached the engine: ${samples.length + blocks.length > 0 ? "YES (proven by journal activity)" : "no activity"}`);
}

main()
  .catch((e) => { console.error("FORENSICS FAILED:", e); process.exit(1); })
  .finally(() => db.$disconnect());
