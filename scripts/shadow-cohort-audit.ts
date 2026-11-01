// SHADOW-COHORT-AUDIT (readonly) — trace 1a196a30609a86ed
// سؤال اپراتور: «آیا Shadow-veto را به حالت Shadow برگردانیم بهتر است؟»
// کوهورت KEEP vs VETO از .data/shadow-veto.jsonl — فقط‌خواندنی، بدون هیچ نوشتنی.
const FILE = "/home/z/my-project/.data/shadow-veto.jsonl";
const txt = await Bun.file(FILE).text();
const lines = txt.trim().split("\n");

type Agg = { n: number; w: number; pnl: number; recentN: number; recentW: number; recentPnl: number };
const mk = (): Agg => ({ n: 0, w: 0, pnl: 0, recentN: 0, recentW: 0, recentPnl: 0 });
const agg: Record<string, Agg> = { KEEP: mk(), VETO: mk() };
let settled = 0, noPnl = 0;
const RECENT_MS = 7 * 24 * 3600 * 1000;
const cutoff = Date.now() - RECENT_MS;

for (const l of lines) {
  let j: any; try { j = JSON.parse(l); } catch { continue; }
  const v = j.v ?? j;
  if (!v || typeof v !== "object" || !v.verdict || !v.outcome) continue;
  const o = v.outcome;
  const pnl = typeof o.pnlUsd === "number" ? o.pnlUsd : typeof o.pnlUsdt === "number" ? o.pnlUsdt : typeof o.pnl === "number" ? o.pnl : null;
  if (pnl === null) { noPnl++; continue; }
  const key = v.verdict === "VETO" ? "VETO" : "KEEP";
  const a = agg[key];
  const at = typeof v.at === "number" ? v.at : typeof v.at === "string" ? Number(v.at) : 0;
  settled++;
  a.n++; if (pnl > 0) a.w++; a.pnl += pnl;
  if (at >= cutoff) { a.recentN++; if (pnl > 0) a.recentW++; a.recentPnl += pnl; }
}

const out = (k: string) => {
  const a = agg[k];
  return {
    settledN: a.n,
    winRatePct: a.n ? +(100 * a.w / a.n).toFixed(1) : null,
    totalPnl: +a.pnl.toFixed(2),
    avgPnl: a.n ? +(a.pnl / a.n).toFixed(3) : null,
    recent7dN: a.recentN,
    recent7dWinRatePct: a.recentN ? +(100 * a.recentW / a.recentN).toFixed(1) : null,
    recent7dPnl: +a.recentPnl.toFixed(2),
  };
};
console.log(JSON.stringify({
  file: FILE, lines: lines.length, settledWithPnl: settled, settledNoNumericPnl: noPnl,
  KEEP: out("KEEP"), VETO: out("VETO"),
  delta: { pnlKeepMinusVeto: +(agg.KEEP.pnl - agg.VETO.pnl).toFixed(2) },
}, null, 1));
