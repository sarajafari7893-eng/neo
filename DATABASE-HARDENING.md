# DATABASE-HARDENING.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 3 deliverable
**Written:** 2026-09-26 (Tehran) · **Method:** live read-only inspection (`PRAGMA`, `prisma migrate diff`), migration baseline applied non-destructively, automated verifier created and executed.

---

## 1. Schema & drift

- `prisma/schema.prisma` — 11 models (Signal, AdvisorProposal, SignalEvent, AgentThought, MarketAsset, EngineSetting, PricePoint, FlowScan, VolCauseEvent, FuturesSnapshot, PumpTrack); 4 `@unique` constraints.
- **Drift check (`prisma migrate diff --from-url --to-schema-datamodel`): EMPTY** — schema code and physical SQLite are identical. Re-verified after migration baseline.
- Production db: `db/custom.db`, WAL mode, 719 signals, 71,672 signal events (71,102 of them legitimate `signalId=NULL` system-journal rows — see §5 checker note).

## 2. Migration strategy — ESTABLISHED (was: none)

**Before:** schema changes went through `prisma db push` (diff-and-sync, destructive-capable) — no history, no review, no rollback path. The task explicitly forbids dependence on push.

**Now (non-destructive baseline procedure, executed):**
1. `prisma/migrations/20260926000000_init/migration.sql` — full schema baseline generated via `prisma migrate diff --from-empty --to-schema-datamodel --script` (298 lines).
2. `prisma/migrations/migration_lock.toml` — `provider = "sqlite"`.
3. Baseline registered as **already-applied** (no SQL executed against production): `INSERT INTO _prisma_migrations …` with sha256 checksum (direct, `busy_timeout=8000`, because `prisma migrate resolve` hit `database is locked` under live WAL traffic). Verified: `prisma migrate status` → **"Database schema is up to date!"**.
4. **Doctrine change:** from now on, schema changes are authored as forward-only migration SQL (`prisma migrate deploy`-compatible). `db push` is banned for production. Any drift re-introduced by push will be detected by the drift diff + integrity checker.

## 3. Identity & concurrency invariants (verified pre-existing + tested)

- `Signal.serial Int @unique` — DB-level uniqueness (v10.16 audit fix) verified present in schema **and** in the physical DB.
- Engine serial generation: module-scoped mutex + `UNIQUE(serial)` backstop + P2002 retry on fresh `MAX(serial)` (engine.ts ~line 31, 275–284).
- **Measured:** 719 signals → **0 duplicate serial groups** (live query).
- Concurrency test under load: see TEST-REPORT.md (serial-race test inserts N concurrent rows against a scratch SQLite copy with the same UNIQUE constraint — DB backstop proven).

## 4. Automated integrity verification — `scripts/db-integrity-check.ts`

Read-only verifier, machine-readable JSON, exit-code semantics (0 = all PASS), used by disaster drill (Phase 11) and test suite (Phase 12). Live run (2026-09-26): **8/8 PASS** —

| Check | Result | Detail |
|---|---|---|
| sqlite_integrity | PASS | `integrity_check=ok` |
| foreign_keys | PASS | 0 violations |
| serial_uniqueness | PASS | 0 duplicate groups |
| orphan_signal_events | PASS | 0 orphans · 71,102 legitimate system-level events |
| ledger_quality_flags | PASS | 0 flagged rows |
| active_state_consistency | PASS | 0 contradictory (ACTIVE+closedAt) rows |
| migration_ledger_present | PASS | `_prisma_migrations` exists |
| journal_mode_wal | PASS | WAL |

**Checker honesty note:** the checker's v1 mis-counted 71,030 `signalId=NULL` rows as orphans (NULL-comparison bug in my own SQL). Root-caused within the session: NULL `signalId` = legitimate engine-level journal entries; only `signalId IS NOT NULL AND parent missing` is an orphan (actual count: 0). The fix is documented here because audit tooling bugs are themselves audit findings.

## 5. Critical state transitions & transactionality — Finding D2 (open, designed)

- **Fact:** zero `$transaction` usage across `src/lib` — signal settlement writes (`signal.update` + `fireEvent(signalEvent.create)`) are multi-statement, non-transactional. Crash mid-sequence can leave a settled signal without its audit event (or vice versa).
- **Scope decision (change_control: no mass rewrite of a live engine):** settlement spans ≥8 update sites across `engine.ts` / `aftermath.ts`. Blanket-wrapping them mid-session is regression risk without a test harness around settlement. **Remediation design D2** (next engine-focused session, tests-first): introduce `settleSignalTx(id, patch, event)` in `src/lib/db-tx.ts` wrapping `db.$transaction([update, event.create])`, migrate the 8 sites one-by-one with settlement snapshot tests on a scratch DB. **Impact today is audit-trail completeness, not fund risk** (no real orders exist — ARCHITECTURE-MAP §3).
- Compensating detection in place: `active_state_consistency` + `orphan_signal_events` checks would surface resulting inconsistencies.

## 6. Reconciliation checks (recovery consistency)

- Integrity checker (§4) = the automated reconciliation baseline; disaster drill (Phase 11) additionally runs it against a restored **copy** of the latest backup before any service start.
- Orphan/invariant checks defined for: audit events (done), serial identity (done), state contradictions (done). Exchange-side reconciliation is N/A structurally until an exchange order path exists (EXECUTION-STATE-MACHINE.md defines the `RECONCILING` entry criterion for when one does).

## Phase-3 acceptance self-check (task §3)

- [x] Prisma schema + actual SQLite inspected (drift = zero)
- [x] Migration strategy introduced; push-dependence removed for production (§2)
- [x] DB-level uniqueness on critical identifiers (serial) — verified live
- [x] Concurrent duplicate serials — impossible at DB level + P2002 retry; tested in Phase 12
- [x] Automated integrity verification (checker, 8/8 PASS)
- [~] Transactional state transitions — designed (D2), scheduled; honestly NOT implemented today

**Phase 3 status: DONE with one honestly-open item (D2).**
