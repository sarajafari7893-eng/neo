// Task 79 — one-off FILL LEDGER backfill (missing-data doctrine ②).
// Radar-linked history is fully reconstructable: PumpTrack.anchorPrice (the
// detection instant ref) + PumpTrack.detectedAt. Scan-path history is NOT
// (scanPrice wasn't persisted per-signal) — left for forward collection.
// Idempotent: INSERT OR IGNORE on the unique signalId. Read-only on Signal/
// PumpTrack; writes ONLY to the new FillLedger table.
import { Database } from "bun:sqlite";

const db = new Database("/home/z/my-project/db/custom.db");
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");

const rows = db
  .query(
    `SELECT s.id, s.symbol, s.engine, s.direction, s.entryPrice, s.createdAt,
            p.anchorPrice, p.detectedAt
       FROM Signal s JOIN PumpTrack p ON p.signalId = s.id
      WHERE p.anchorPrice IS NOT NULL AND p.anchorPrice > 0`,
  )
  .all() as Array<{
  id: string; symbol: string; engine: string; direction: string; entryPrice: number;
  createdAt: number; anchorPrice: number; detectedAt: number | null;
}>;

// SANE-CAP: pre-v9.3.1 routing-bug era minted cards on a DIFFERENT symbol than
// the track (VTHO track → AAVE card, documented 2026-09-13) — those pairs
// produce nonsense cross-price drift. Anything beyond 500bps (5%) adverse or
// favorable is structurally impossible inside the 0.6-1.5% chase caps → drop.
const SANE_CAP_BPS = 500;
let garbage = 0;

let inserted = 0, skipped = 0;
const ins = db.query(
  `INSERT OR IGNORE INTO FillLedger
     (id, signalId, symbol, engine, direction, refPrice, entryPrice, slipBps, detectedAt, latencyMs, refSource, createdAt)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
);
for (const r of rows) {
  const isLong = r.direction !== "SHORT";
  const slipBps = ((r.entryPrice - r.anchorPrice) / r.anchorPrice) * 10_000 * (isLong ? 1 : -1);
  if (Math.abs(slipBps) > SANE_CAP_BPS) {
    garbage++;
    continue;
  }
  const latencyMs = r.detectedAt ? Math.max(0, r.createdAt - r.detectedAt) : null;
  const res = ins.run(
    "fl-" + r.id.slice(0, 8) + "-" + Math.random().toString(36).slice(2, 8),
    r.id, r.symbol, r.engine, r.direction, r.anchorPrice, r.entryPrice,
    Number(slipBps.toFixed(2)), r.detectedAt, latencyMs, "radar-anchor", r.createdAt,
  );
  if (res.changes > 0) inserted++;
  else skipped++;
}

// summary stats for the report
const stats = db
  .query(`SELECT COUNT(*) n, ROUND(AVG(slipBps),2) avgSlip, ROUND(MIN(slipBps),2) minSlip, ROUND(MAX(slipBps),2) maxSlip,
                 SUM(CASE WHEN slipBps > 0 THEN 1 ELSE 0 END) adverse,
                 ROUND(AVG(latencyMs),0) avgLatencyMs
            FROM FillLedger`)
  .get();
console.log(`backfill: scanned=${rows.length} inserted=${inserted} skipped(existing)=${skipped} garbage(>500bps, routing-bug era)=${garbage}`);
console.log(`FillLedger totals:`, stats);
