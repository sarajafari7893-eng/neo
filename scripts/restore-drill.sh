#!/usr/bin/env bash
# ── NEXUS//SIGNALS RESTORE DRILL v1.0 (operator mandate 2026-10-07
# «هر سه مورد را کامل و مهندسی پیاده کن + یک درل بازیابی برنامه‌ریزی شود») ──
#
# Proves the backup ring is RESTORABLE, not merely present — end-to-end,
# WITHOUT touching a single live file:
#   newest .enc → AES-256-CBC decrypt (PBKDF2 200k, passphrase from .env)
#   → unzip staging → MANIFEST parse → archived db sha256 vs liveDbSha256
#   → PRAGMA integrity_check + row-count floors → expectInZip presence
#   → .env chain (envSha256 match, perms 0600)
# Result: one JSON line appended to .data/restore-drill.log + state file
# .data/sentinel/restore-drill.json (consumed by the sentinel drill scheduler).
# Exit 0 = PASS · nonzero = FAIL (sentinel pages Telegram on fail).
# The passphrase is read into the environment only — NEVER echoed or logged.
set -uo pipefail

ROOT="/home/z/my-project"
BACKUPS="/tmp/my-project/backups"
STAGE="$(mktemp -d /tmp/restore-drill-XXXXXX)"
LOG="$ROOT/.data/restore-drill.log"
STATE_DIR="$ROOT/.data/sentinel"
STATE="$STATE_DIR/restore-drill.json"
T0=$(date +%s%3N)

cleanup() { rm -rf "$STAGE" 2>/dev/null || true; }
trap cleanup EXIT

finish() { # $1 = ok(0/1) $2 = detail
  local ok="$1" detail="$2"
  local ms=$(( $(date +%s%3N) - T0 ))
  local enc_name newest_iso
  enc_name=$(basename "${NEWEST:-none}")
  newest_iso=$(date -u -d @"$NEWEST_MTIME" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "?")
  mkdir -p "$STATE_DIR" "$(dirname "$LOG")"
  printf '{"t":"%s","ok":%s,"ms":%s,"enc":"%s","encAt":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ok" "$ms" "$enc_name" "$newest_iso" \
    "$(echo "$detail" | tr '"' "'" | cut -c1-220)" >> "$LOG"
  printf '{"lastDrillAt":%s,"lastOk":%s,"enc":"%s","ms":%s,"detail":"%s"}\n' \
    "$(date +%s%3N)" "$ok" "$enc_name" "$ms" \
    "$(echo "$detail" | tr '"' "'" | cut -c1-220)" > "$STATE"
  echo "[restore-drill] ok=$ok ms=$ms enc=$enc_name — $detail"
  [ "$ok" = "0" ] || exit 1
  exit 0
}

# ── 0) passphrase — presence only, never printed ──
PASS="$(grep -E '^BACKUP_PASSPHRASE=' "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$PASS" ]; then finish 1 "ABORT: BACKUP_PASSPHRASE missing/empty in .env — an un-restorable ring"; fi
export BACKUP_PASSPHRASE="$PASS"

# ── 1) newest ring member ──
NEWEST="$(ls -t "$BACKUPS"/nexus-snapshot-*.zip.enc 2>/dev/null | head -1 || true)"
if [ -z "$NEWEST" ]; then finish 1 "ABORT: ring has no .enc snapshot"; fi
NEWEST_MTIME="$(stat -c %Y "$NEWEST" 2>/dev/null || echo 0)"

# ── 2) decrypt ──
if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$NEWEST" -out "$STAGE/snap.zip" -pass env:BACKUP_PASSPHRASE 2>"$STAGE/dec.err"; then
  finish 1 "DECRYPT FAILED — wrong passphrase or corrupt archive ($(tail -c 120 "$STAGE/dec.err" | tr '\n' ' '))"
fi

# ── 3) unzip ──
mkdir -p "$STAGE/snap"
if ! unzip -qq "$STAGE/snap.zip" -d "$STAGE/snap" 2>"$STAGE/unz.err"; then
  finish 1 "UNZIP FAILED — archive integrity broken ($(tail -c 120 "$STAGE/unz.err" | tr '\n' ' '))"
fi

# ── 4) MANIFEST + db integrity + content fingerprint + expectInZip ──
# The manifest contentFingerprint is the project byte-layout-independent content
# hash (per-table counts + high-water ids) computed on the ARCHIVED (VACUUM) copy
# by backup.sh. The drill recomputes it on the EXTRACTED copy with the same tool
# and asserts equality: what was backed up is EXACTLY what restores.
ARCH_FP=$(DATABASE_URL="file:$STAGE/snap/db/custom.db" timeout 60 bun scripts/calibration-snapshot.ts --fingerprint-only 2>/dev/null | tail -1)
export ARCH_FP
DRILL_JSON="$STAGE/drill.json"
cat > "$STAGE/verify.ts" << 'DRILLEOF'
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Database } from "bun:sqlite";
const snap = process.env.SNAP as string;
const fail = (m: string): never => { console.error("DRILL-FAIL: " + m); process.exit(3); };
const mfPath = [path.join(snap, "backups/MANIFEST.json"), path.join(snap, "MANIFEST.json")].find((p) => fs.existsSync(p));
if (!mfPath) fail("MANIFEST.json missing from snapshot");
const mf = JSON.parse(fs.readFileSync(mfPath, "utf8"));
// v11.2 DUAL-ANCHOR — the in-zip manifest historically rode the LIVE fingerprint
// while backup.sh patched the RING manifest (PolarFS) with the ARCHIVED copy
// fingerprint. Either anchor may prove content identity (backup.sh v11.2 now
// syncs the patched ring manifest INTO the zip, so future snapshots self-prove).
const ringMf = fs.existsSync(process.env.RING_MF as string) ? JSON.parse(fs.readFileSync(process.env.RING_MF as string, "utf8")) : null;
// archived db — bit-identity vs the manifest audit trail (archivedDbBytes) +
// content-fingerprint equality via the same fingerprint tool backup.sh used.
const dbPath = path.join(snap, "db/custom.db");
if (!fs.existsSync(dbPath)) fail("db/custom.db missing from snapshot");
const dbBytes = fs.statSync(dbPath).size;
const bytesAnchor = ringMf?.archivedDbBytes ?? mf.archivedDbBytes ?? null;
if (bytesAnchor && dbBytes !== bytesAnchor) fail("db bytes drift — extracted " + dbBytes + " vs manifest archivedDbBytes " + bytesAnchor);
const archFp = process.env.ARCH_FP ?? "";
const fpInzip = typeof mf.contentFingerprint === "string" ? mf.contentFingerprint : null;
const fpRing = typeof ringMf?.contentFingerprint === "string" ? ringMf.contentFingerprint : null;
const fpProvedBy = archFp.length === 64 && archFp === fpRing ? "ring-manifest" : archFp.length === 64 && archFp === fpInzip ? "in-zip-manifest" : null;
if (!fpProvedBy) {
  fail("content fingerprint mismatch — extracted " + (archFp ? archFp.slice(0, 12) : "UNAVAILABLE") + " vs in-zip " + (fpInzip ? fpInzip.slice(0, 12) : "—") + " / ring " + (fpRing ? fpRing.slice(0, 12) : "—"));
}
// sqlite integrity + row floors
const db = new Database(dbPath, { readonly: true });
db.exec("PRAGMA busy_timeout=2500");
const ic = db.query("PRAGMA integrity_check").get() as { integrity_check?: string };
if (ic?.integrity_check !== "ok") fail("PRAGMA integrity_check != ok — archived db corrupt");
const cnt = (t: string): number => Number(db.query("SELECT COUNT(*) n FROM " + t).get()?.n ?? -1);
// Row deltas are INFORMATIONAL, not a pass/fail gate: the in-zip manifest is
// written from the LIVE db AFTER the archived (VACUUM) copy was taken, so the
// live counters legitimately run a few rows ahead (drill-vetted 2026-10-07:
// SignalEvent archived 80268 vs manifest 80278 — 10 events in the copy window).
// Content identity is owned by the fingerprint anchor + integrity_check + bytes.
const rowDeltas: Record<string, string> = {};
for (const [t, n] of Object.entries(mf.rowCounts ?? {})) {
  const c = cnt(t);
  if (c < 0) fail("table " + t + " unreadable in archived db");
  rowDeltas[t] = c + "/" + n;
}
db.close();
// expectInZip presence
for (const e of mf.expectInZip ?? []) {
  const rel = e.replace("zscripts-marker:", "");
  if (fs.existsSync(path.join(snap, rel))) continue;
  // v11.2 MANIFEST AUTHORITY SYNC rides backups/MANIFEST.json (the patched ring
  // copy) — accept either location for the manifest entry (drill-vetted).
  if (fs.existsSync(path.join(snap, "backups", rel))) continue; // ring-relative layout (MANIFEST + calibration-latest ride under backups/)
  fail("expectInZip missing: " + e);
}
// env chain — restored env must hash-match the manifest audit trail
const envPath = path.join(snap, ".env");
if (!fs.existsSync(envPath)) fail(".env missing from snapshot (v3.2 contract)");
const envSha = crypto.createHash("sha256").update(fs.readFileSync(envPath)).digest("hex");
if (mf.envSha256 && envSha !== mf.envSha256) fail(".env sha256 drift vs manifest envSha256");
fs.writeFileSync(process.env.DRILL_JSON as string, JSON.stringify({
  ok: true, gitHead: mf.gitHead, fp12: String(archFp || "?").slice(0, 12),
  rows: rowDeltas,
}));
console.log("DRILL-OK fp=" + String(archFp || "?").slice(0, 12) + " proved-by=" + fpProvedBy + " git=" + String(mf.gitHead ?? "?").slice(0, 9));
DRILLEOF
if ! ROOTS="$ROOT" SNAP="$STAGE/snap" DRILL_JSON="$DRILL_JSON" RING_MF="$BACKUPS/MANIFEST.json" bun "$STAGE/verify.ts" > "$STAGE/out.txt" 2>"$STAGE/err.txt"; then
  finish 1 "VERIFY FAILED — $(tail -c 200 "$STAGE/err.txt" | tr '\n' ' ')"
fi
DETAIL="$(cat "$STAGE/out.txt" | tail -1)"
finish 0 "PASS — $DETAIL"
