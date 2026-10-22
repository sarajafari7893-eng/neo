/**
 * NEXUS//SIGNALS — MANIFEST PATCH HELPER (v1.0, SENTINEL-20260921-R2)
 *
 * WHY THIS EXISTS: backup.sh previously ran this logic as an inline `bun -e "…"`
 * with 2>/dev/null. Under some spawn contexts (sentinel-spawned runs 2026-09-21
 * 10:06–10:18) that inline eval failed SILENTLY, so snapshots shipped an
 * UNPATCHED MANIFEST (live-db fingerprint, no env/pass keys) and the
 * restore-drill content check could never pass. A file-based helper is
 * environment-independent (same class as calibration-snapshot.ts, which works
 * in every context), and the caller now hard-verifies its effect.
 *
 * Usage:
 *   bun scripts/manifest-patch.ts <manifestPath> <archivedFingerprint> \
 *        <stagedDbPath> <envSha256> <envBytes> <passphraseSha8>
 *
 * Prints "MANIFEST-PATCH-OK" on success; exits 1 with a stderr message on any
 * failure. Secrets: takes fingerprints/sha only — NEVER a passphrase value.
 */
import { readFileSync, statSync, writeFileSync } from "fs";

function die(msg: string): never {
  console.error(`MANIFEST-PATCH-FAILED: ${msg}`);
  process.exit(1);
}

const [, , manifestPath, archFp, stagedDbPath, envSha, envBytesRaw, passSha8] = process.argv;

if (!manifestPath || !archFp || !stagedDbPath || !envSha || !envBytesRaw || !passSha8) {
  die("usage: manifest-patch.ts <manifestPath> <archFp> <stagedDbPath> <envSha256> <envBytes> <passSha8>");
}
if (!/^[0-9a-f]{64}$/.test(archFp)) die(`archFp not a sha256 hex-64: "${archFp.slice(0, 16)}…"`);
if (!/^[0-9a-f]{64}$/.test(envSha)) die(`envSha not a sha256 hex-64`);
if (!/^[0-9a-f]{8}$/.test(passSha8)) die(`passSha8 not a sha8 fingerprint`);

let manifest: Record<string, unknown>;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
} catch (e) {
  die(`manifest unreadable at ${manifestPath}: ${(e as Error).message}`);
}

try {
  manifest["contentFingerprint"] = archFp; // fingerprint of the ARCHIVED (VACUUM) copy — what the drill verifies
  manifest["archivedDbBytes"] = statSync(stagedDbPath).size;
  manifest["envSha256"] = envSha; // sha of the .env that rides THIS snapshot (rotation-audit trail)
  manifest["envBytes"] = Number(envBytesRaw);
  manifest["envPerm"] = "0600";
  manifest["passphraseSha8"] = passSha8; // links the artifact to its decrypting passphrase (never the value)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
} catch (e) {
  die(`manifest write failed: ${(e as Error).message}`);
}

// readback — the caller also verifies, but the helper fails loudly on its own
try {
  const back = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (back["contentFingerprint"] !== archFp || back["passphraseSha8"] !== passSha8) {
    die("readback mismatch after write");
  }
  console.log("MANIFEST-PATCH-OK");
} catch (e) {
  die(`readback failed: ${(e as Error).message}`);
}
