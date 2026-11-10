// wr-cohorts-1110.mjs — FAPI-DEG vs CLEAN-COHORT WR COMPARISON (trace
// 1a1ba99d0cb24dd9 «توصیه‌های پیشنهادی را کامل و مهندسی اجرا کن» + performance
// mandate 2026-11-10). Runnable anytime: `bun run .data/wr-cohorts-1110.mjs`.
// Reports per-cohort WR with Wilson 95% LB/UB, net & avg per row, and tracks
// the POST-MANDATE FAPI-DEG counter (the v14.5 protected stand-down promises
// ZERO new degraded rows — any count > 0 is a regression alarm).
import { Database } from "bun:sqlite";

const db = new Database("db/custom.db", { readonly: true });
const MANDATE_MS = Date.parse("2026-11-10T21:55:00Z"); // v14.5 deploy moment

function wilsonLB(w, n) { if (n <= 0) return null; const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), s = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n); return Math.max(0, ((c - s) / d) * 100); }
function wilsonUB(w, n) { if (n <= 0) return null; const z = 1.96, p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), s = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n); return Math.min(100, ((c + s) / d) * 100); }

const rows = db.prepare(`
  SELECT serial, symbol, direction, strategy, status, reachedTp, pnlPercent, marginUsd,
         feeUsd, swapUsd, tags, qualityFlag, createdAt, closedAt
  FROM Signal WHERE closedAt IS NOT NULL AND status NOT IN ('ACTIVE','VOID')
`).all();
const rawNet = (r) => ((r.pnlPercent ?? 0) / 100) * (r.marginUsd ?? 0) - (r.feeUsd ?? 0) - (r.swapUsd ?? 0);
const clean = rows.filter((r) => !r.qualityFlag);
const has = (r, t) => (r.tags ?? "").includes(t);

const cohorts = {
  "FAPI-DEG (degraded tape)": clean.filter((r) => has(r, "FAPI-DEG")),
  "RAW-CAL clean": clean.filter((r) => has(r, "RAW-CAL") && !has(r, "FAPI-DEG")),
  "plain auto (no RAW-CAL)": clean.filter((r) => !has(r, "RAW-CAL") && !has(r, "PUMP") && !has(r, "FAPI-DEG")),
  "PUMP radar lineage": clean.filter((r) => has(r, "PUMP")),
};

const f2 = (x) => Number(x ?? 0).toFixed(2);
console.log("== FAPI-DEG vs CLEAN-COHORT WR COMPARISON (settled, clean ledger) ==");
console.log("cohort".padEnd(28), "n".padStart(5), "WR(tp-proven)".padStart(15), "WR-LB95".padStart(8), "WR-UB95".padStart(8), "netRaw".padStart(10), "avg/row".padStart(8));
for (const [name, arr] of Object.entries(cohorts)) {
  const w = arr.filter((r) => r.reachedTp >= 1).length;
  const n = arr.length;
  const net = arr.reduce((a, r) => a + rawNet(r), 0);
  const lb = wilsonLB(w, n), ub = wilsonUB(w, n);
  const wrStr = n ? ((w / n) * 100).toFixed(1) + "%" : "—";
  console.log(name.padEnd(28), String(n).padStart(5), wrStr.padStart(15),
    lb === null ? "—".padStart(8) : lb.toFixed(1).padStart(8),
    ub === null ? "—".padStart(8) : ub.toFixed(1).padStart(8),
    f2(net).padStart(10), (n ? f2(net / n) : "—").padStart(8));
}

const sep = cohorts["FAPI-DEG (degraded tape)"];
const ref = cohorts["RAW-CAL clean"];
if (sep.length && ref.length) {
  const sepW = sep.filter((r) => r.reachedTp >= 1).length, refW = ref.filter((r) => r.reachedTp >= 1).length;
  const sepUB = wilsonUB(sepW, sep.length), refWR = (refW / ref.length) * 100;
  const sepAvg = sep.reduce((a, r) => a + rawNet(r), 0) / sep.length;
  const refAvg = ref.reduce((a, r) => a + rawNet(r), 0) / ref.length;
  console.log("\nVERDICT: sepWR-UB95=" + sepUB.toFixed(1) + "% vs cleanWR=" + refWR.toFixed(1) + "% → " + (sepUB < refWR ? "WR separation PROVEN (UB95 < clean WR)" : "WR separation NOT proven yet") +
    " · avg/row: sep=" + f2(sepAvg) + " vs clean=" + f2(refAvg) + " → " + (sepAvg < 0 && sepAvg < refAvg ? "negative-expectancy cohort CONFIRMED" : "no negative edge proven"));
}

// post-mandate regression tracker
const post = clean.filter((r) => has(r, "FAPI-DEG") && Number(r.createdAt) >= MANDATE_MS);
console.log("\nPOST-MANDATE FAPI-DEG rows (v14.5 stand-down promises ZERO):", post.length, post.length ? "⚠ REGRESSION — inspect raw-cal gate" : "✓ clean");
db.close();
