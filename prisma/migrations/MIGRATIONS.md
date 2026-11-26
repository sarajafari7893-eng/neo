# DATABASE MIGRATION STRATEGY (LIVE-HARDENING phase 3)

## Context
The production DB (`db/custom.db`, SQLite) was originally created and evolved
via `prisma db push` — a drift-prone, migration-less path. This baseline closes
that gap **without touching the live database** (no destructive commands were
run; the live schema is left exactly as-is).

## Baseline
- `0000_baseline/migration.sql` — generated with
  `bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
  from the CURRENT accepted schema. It is the recorded, reviewable DDL of the
  system as of deployment commit (see LIVE-READINESS.md for the commit hash).

## Policy going forward
1. **Every schema change** is made in `prisma/schema.prisma`, then captured as a
   NEW migration folder via
   `bunx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel <changed> --script`
   (or `prisma migrate dev --create-only` in a COPY of the DB), reviewed, then
   applied with `prisma migrate deploy`.
2. `db push` is allowed ONLY in the disposable sandbox dev loop; it must never
   be the mechanism for a change that has not been captured in `migrations/`.
3. **Destructive schema sync in production is forbidden** (spec: no destructive
   DB commands). Column drops / type changes require a reviewed migration with
   an explicit data-preservation note.
4. Integrity is verified automatically by `.zscripts/hardening-verify.ts`
   (`db_integrity` check: `PRAGMA integrity_check`, `foreign_key_check`,
   duplicate-serial scan, orphan-ScanEvent scan, open-row protective-exit scan
   via `reconcilePaperOpen`). Results feed `/api/readiness` (gate:
   `database_integrity`).

## Database-level invariants in place (accepted schema)
- `Signal.serial` — `@unique` (concurrency backstop for the NX-0001 serial
  race; the engine additionally retries once on P2002 with a fresh MAX).
- `MarketAsset.symbol` — `@unique`.
- Vol-cause + vol-forecast stores — composite `@@unique` on natural keys
  (`symbol,ts,source` / `symbol,tf`) so concurrent workers upsert instead of
  duplicating rows.
