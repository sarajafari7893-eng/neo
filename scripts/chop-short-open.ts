/**
 * CHOP-SHORT-OPEN — operator order trace 1a193604acd890f9:
 *   «آیا REGIME-CHOP کامل وتو می‌شود؟ فقط شورت را برایش باز بگذار»
 *
 * Engineering answer (journal-proven, last 400 REGIME blocks):
 *   · 385 LONG / 15 SHORT blocked — the 15 SHORTs were all AI-SCALP (v11.6
 *     cell-flip family, WR 19.6% — paused book-wide by EQ-97 anyway).
 *   · regime.ts L1 semantics ALREADY admit AI-SWING / MEAN-REVERT SHORTs
 *     through the EQ-100 tax ladder (CHOP SHORT +$1171.84 all-time) — but
 *     those survivors are then killed downstream by R1 SHORT-GUARD
 *     (shortGuard=1 HTF-ALIGN; 246 blocks today, 12/40min live).
 *   · Therefore the ONLY legal move that "opens SHORT in CHOP" without
 *     touching engine.ts (FLAT-10) or regime.ts evidence-ladders is the
 *     gate-settings DB knob: shortGuard 1 → 0.
 *
 * Mechanism: data-layer write to EngineSetting "gate" — the exact channel
 * the AI governor itself uses (putGateSettings semantics: full merged JSON,
 * clamped; engine re-reads within its 15s CACHE_TTL). REVERSIBLE: restore
 * shortGuard=1 with the same script (record keeps before/after).
 *
 * KEPT (evidence-led, NOT opened — honesty doctrine):
 *   · CHOP LONG hard-veto (EQ-100 ledger LONG −$959.39 all-time)
 *   · BREAKOUT/MOMENTUM/AI-SCALP chop hard-veto (0/9 −$2.58; scalp 19.6% WR)
 *   · AI-SCALP book pause (EQ-97, operator)
 *   · DECISIVE-EXCURSION filter (v10.6, live outcome evidence 75/113 no-touch)
 *   · minScore=17 [PINNED], regimeGuard=1, decisiveFilter=1 untouched
 *
 * Usage: bun scripts/chop-short-open.ts [--apply | --restore]
 *   (no flag = dry-run preview)
 */
import { Database } from "bun:sqlite";

const mode = process.argv[2] ?? "";
const APPLY = mode === "--apply";
const RESTORE = mode === "--restore";
const DB_PATH = "db/custom.db";
const KEY = "gate";
const TARGET = RESTORE ? 1 : 0;

interface GateRow { key: string; value: string; updatedAt: number }
interface SignalEventRow {
  id: string; signalId: string | null; type: string; symbol: string | null;
  message: string; level: string; createdAt: string;
}

const db = new Database(DB_PATH, APPLY ? undefined : { readonly: true });
db.exec("PRAGMA busy_timeout = 5000;");

const row = db.query(`SELECT key, value, updatedAt FROM EngineSetting WHERE key = ?`).get(KEY) as GateRow | null;
if (!row) {
  console.error("FATAL: EngineSetting gate row missing — abort (never bootstrap silently).");
  process.exit(1);
}
const gate = JSON.parse(row.value) as Record<string, number>;
const before = gate.shortGuard;
console.log(`[CHOP-SHORT-OPEN] current shortGuard = ${before} (1=HTF-ALIGN, 0=OFF)`);
if (before === TARGET && APPLY) {
  console.log(`shortGuard already = ${TARGET} — nothing to do.`);
  process.exit(0);
}
if (before !== 1 && !RESTORE && APPLY) {
  console.error(`FATAL: expected shortGuard=1 before opening (found ${before}) — refusing to act on unknown state.`);
  process.exit(1);
}

// preview of downstream effect
const changed = { shortGuard: TARGET };
console.log(`[preview] merged write shortGuard: ${before} → ${TARGET} (all other ${Object.keys(gate).length - 1} keys byte-preserved)`);

if (!APPLY) {
  console.log("DRY-RUN — rerun with --apply (or --restore to pin back shortGuard=1).");
  process.exit(0);
}

// apply: full merged JSON write (putGateSettings semantics) + audit trail
gate.shortGuard = TARGET;
const nextValue = JSON.stringify(gate);
const now = Date.now();

const tx = db.transaction(() => {
  db.query(`UPDATE EngineSetting SET value = ?, updatedAt = ? WHERE key = ?`).run(nextValue, now, KEY);

  const msg = RESTORE
    ? `CHOP-SHORT-OPEN RESTORE: shortGuard ${before} → 1 (HTF-ALIGN) — operator-scoped window closed, R1 guard back to doctrine`
    : `CHOP-SHORT-OPEN: shortGuard ${before} → 0 (OFF) — operator order trace 1a193604acd890f9 «فقط شورت را برایش باز بگذار»: R1 SHORT-GUARD un-vetoes the EQ-100 CHOP SHORT tax-ladder cohort (AI-SWING/MEAN-REVERT SHORT, CHOP SHORT +$1171.84 all-time). KEPT: CHOP LONG veto · BREAKOUT/MOMENTUM/AI-SCALP chop veto · DECISIVE · minScore 17 [PINNED] · regimeGuard L1. Reversible: bun scripts/chop-short-open.ts --restore`;
  db.query(
    `INSERT INTO SignalEvent (id, signalId, type, symbol, message, level, createdAt)
     VALUES (?, NULL, 'SYSTEM', NULL, ?, 'ai', ?)`
  ).run(crypto.randomUUID(), msg, new Date().toISOString());

  const audit = {
    at: new Date().toISOString(),
    action: RESTORE ? "CHOP-SHORT-OPEN-RESTORE" : "CHOP-SHORT-OPEN",
    trace: "1a193604acd890f9",
    before, after: TARGET,
    mechanism: "EngineSetting gate.shortGuard (data-layer knob, engine CACHE_TTL 15s)",
    keptVetoes: ["REGIME-CHOP LONG (EQ-100)", "BREAKOUT/MOMENTUM chop", "AI-SCALP chop cell-flip + book pause (EQ-97)", "DECISIVE v10.6", "STALE-* physical", "minScore 17 PINNED"],
    reversible: "bun scripts/chop-short-open.ts --restore",
  };
  db.query(
    `INSERT INTO EngineSetting (key, value, updatedAt) VALUES ('short-guard.open', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
  ).run(JSON.stringify(audit), now);
});
tx();

// verify
const afterRow = db.query(`SELECT value FROM EngineSetting WHERE key = ?`).get(KEY) as GateRow;
const after = JSON.parse(afterRow.value).shortGuard;
const auditRow = db.query(`SELECT value FROM EngineSetting WHERE key = 'short-guard.open'`).get() as GateRow | null;
const evCount = db.query(`SELECT COUNT(*) AS c FROM SignalEvent WHERE message LIKE 'CHOP-SHORT-OPEN%'`).get() as { c: number };
console.log(`[verify] shortGuard now = ${after} (expect ${TARGET})`);
console.log(`[verify] audit record 'short-guard.open' = ${auditRow ? "OK" : "MISSING"}`);
console.log(`[verify] SignalEvent journal rows = ${evCount.c}`);
console.log(`[verify] engine picks it up within 15s (getGateSettings CACHE_TTL) — watch .data/gate-journal.jsonl for SHORT-GUARD blocks → 0 and describeGate "SHORT-GUARD OFF"`);
if (after !== TARGET) { console.error("VERIFY FAILED"); process.exit(1); }
db.close();
console.log("APPLIED ✓");
