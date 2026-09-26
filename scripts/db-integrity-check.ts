/**
 * NEXUS//SIGNALS — automated database integrity verifier
 * LIVE-HARDENING Phase 3 / consumed by Phase 11 drill + Phase 12 test suite.
 *
 * READ-ONLY. Never writes. Machine-readable JSON on stdout:
 *   { ok: boolean, db: string, checks: [{ name, status: PASS|FAIL, detail }] }
 * Exit code 0 if all checks pass, 1 otherwise.
 *
 * Usage: bun scripts/db-integrity-check.ts [path-to-sqlite]
 * (default: db/custom.db; a COPY is used during disaster drills)
 */

import { Database } from "bun:sqlite";

const dbPath = process.argv[2] ?? "db/custom.db";

interface Check {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
}

const checks: Check[] = [];
const db = new Database(dbPath, { readonly: true });
db.run("PRAGMA busy_timeout = 5000");

function add(name: string, ok: boolean, detail: string): void {
  checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
}

try {
  // 1) SQLite engine integrity
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  add("sqlite_integrity", integrity.integrity_check === "ok", `integrity_check=${integrity.integrity_check}`);

  // 2) Foreign-key consistency
  const fk = db.query("PRAGMA foreign_key_check").all() as unknown[];
  add("foreign_keys", fk.length === 0, `${fk.length} violations`);

  // 3) Serial uniqueness (NX-xxxx identity invariant)
  const dup = db
    .query("SELECT COUNT(*) c FROM (SELECT serial FROM Signal WHERE serial > 0 GROUP BY serial HAVING COUNT(*) > 1)")
    .get() as { c: number };
  add("serial_uniqueness", dup.c === 0, `${dup.c} duplicate serial groups`);

  // 4) Orphan audit events (SignalEvent referencing a parent Signal that does
  //    not exist). signalId = NULL rows are LEGITIMATE system-level journal
  //    entries (ENGINE events etc.) — they are not orphans. (v1 of this checker
  //    mis-counted 71k NULL rows as orphans; fixed 2026-09-26 after root-cause.)
  const orphans = db
    .query(
      "SELECT COUNT(*) c FROM SignalEvent e WHERE e.signalId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM Signal s WHERE s.id = e.signalId)",
    )
    .get() as { c: number };
  const sysEvents = db.query("SELECT COUNT(*) c FROM SignalEvent WHERE signalId IS NULL").get() as { c: number };
  add(
    "orphan_signal_events",
    orphans.c === 0,
    `${orphans.c} orphaned (parented-but-missing) · ${sysEvents.c} legitimate system-level events`,
  );

  // 5) Dirty-ledger hygiene (qualityFlag rows must be excluded downstream — they exist by design; we only report)
  const dirty = db.query("SELECT COUNT(*) c FROM Signal WHERE qualityFlag IS NOT NULL").get() as { c: number };
  add("ledger_quality_flags", true, `${dirty.c} rows flagged (excluded from headline analytics by doctrine)`);

  // 6) Active-state sanity: ACTIVE signals must not be already closed
  const contradiction = db
    .query("SELECT COUNT(*) c FROM Signal WHERE status = 'ACTIVE' AND closedAt IS NOT NULL")
    .get() as { c: number };
  add("active_state_consistency", contradiction.c === 0, `${contradiction.c} contradictory rows`);

  // 7) Migration ledger present (baseline recorded)
  const mig = db
    .query("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'")
    .get() as { c: number };
  add("migration_ledger_present", mig.c === 1, mig.c === 1 ? "_prisma_migrations exists" : "missing — db push era");

  // 8) WAL mode (concurrency hygiene)
  const jm = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  add("journal_mode_wal", jm.journal_mode.toLowerCase() === "wal", `journal_mode=${jm.journal_mode}`);
} finally {
  db.close();
}

const ok = checks.every((c) => c.status === "PASS");
console.log(JSON.stringify({ ok, db: dbPath, checkedAt: new Date().toISOString(), checks }, null, 2));
process.exit(ok ? 0 : 1);
