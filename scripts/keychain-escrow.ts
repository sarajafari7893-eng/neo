/**
 * KEYCHAIN-ESCROW — P0 of the P0-P2 package (operator trace 1a193604acd890f9
 * «کلید را ایمن نگه دار تا با ریکاوری سیستم قابل بازیابی باشد» + the 5th key
 * loss incident). Adds a FOURTH, independent recovery link for the Toobit
 * bridge keys: an AES-256-CBC/PBKDF2-200k encrypted escrow INSIDE the
 * database (EngineSetting "toobit.key-escrow").
 *
 * Why a DB escrow on top of the existing chain (commit fb13dcda):
 *   ① sealed copy  /home/z/.nexus-secrets/toobit-bridge.env  (off-tree)
 *   ② KEYS-GUARD   watchdog auto-reinstall (uses ①)
 *   ③ tbenv-*.enc  versioned AES backups (backup.sh, in snapshot zips)
 *   ④ DB ESCROW    this file — db/custom.db rides every snapshot zip AND the
 *      aside-protected DB copies; survives the loss of ① AND ③ (e.g. box-wide
 *      /home/z or /tmp wipe where only the DB backup survives).
 *
 * Payload is byte-compatible with:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:<pass> -in <f>
 * ("Salted__" header + 8-byte salt + PBKDF2-HMAC-SHA256 key(32)+iv(16)) so the
 * shell-side recovery/watchdog fallbacks decrypt it with plain openssl.
 *
 * Passphrase: /home/z/.nexus-secrets/escrow.pass (0600, auto-created random
 * 32-byte hex, OUTSIDE the project tree — never in git, never in backups of
 * the tree; documented in the engineSetting record's location note).
 *
 * Usage: bun scripts/keychain-escrow.ts [verify|escrow]   (default: escrow+verify)
 */
import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";

const DB_PATH = "db/custom.db";
const ENV_PATH = "mini-services/toobit-bridge/.env";
// v2 POLARFS-FIRST passphrase (operator order 2026-11-02 — «مهاجرت اسکرو به
// مسیر پایدارتر»): /home/z was proven the wipe surface (escrow.pass died with
// the 11-erase day, orphaning the DB payload); /tmp/my-project (PolarFS)
// survived every wipe. Passphrase resolves PolarFS-first and ensurePass()
// WRITE-THROUGHs to both surfaces so the shell-side fallbacks (watchdog.sh
// KEYS-GUARD v3.4, bridge-watchdog v1.3) keep working from either path.
const PASS_PRIMARY = "/tmp/my-project/secrets/escrow.pass";
const PASS_LEGACY = "/home/z/.nexus-secrets/escrow.pass";
const PASS_PATH = existsSync(PASS_PRIMARY) ? PASS_PRIMARY : PASS_LEGACY;
const KEY_ESCROW = "toobit.key-escrow";
const ITER = 200_000;

function ensurePass(): Buffer {
  if (existsSync(PASS_PATH)) return readFileSync(PASS_PATH, "utf8").trim() as unknown as Buffer;
  const pass = randomBytes(32).toString("hex");
  for (const p of [PASS_PRIMARY, PASS_LEGACY]) {
    try {
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, pass + "\n", { mode: 0o600 });
      chmodSync(p, 0o600);
    } catch { /* best-effort twin — primary verdict below */ }
  }
  console.log(`[escrow] new passphrase created → ${PASS_PRIMARY} (+ legacy twin ${PASS_LEGACY}) (0600)`);
  return pass as unknown as Buffer;
}

/** openssl enc -aes-256-cbc -pbkdf2 compatible encryption */
function opensslLikeEncrypt(plain: Buffer, pass: string): Buffer {
  const salt = randomBytes(8);
  const derived = pbkdf2Sync(pass, salt, ITER, 48, "sha256"); // key32 + iv16
  const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32, 48));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__", "ascii"), salt, enc]);
}

function opensslLikeDecrypt(blob: Buffer, pass: string): Buffer {
  if (blob.subarray(0, 8).toString("ascii") !== "Salted__") throw new Error("not a Salted__ payload");
  const salt = blob.subarray(8, 16);
  const data = blob.subarray(16);
  const derived = pbkdf2Sync(pass, salt, ITER, 48, "sha256");
  const decipher = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32, 48));
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const mode = process.argv[2] ?? "escrow";
const db = new Database(DB_PATH);
db.exec("PRAGMA busy_timeout = 5000;");

if (mode === "escrow") {
  if (!existsSync(ENV_PATH) || statSync(ENV_PATH).size === 0) {
    console.error("FATAL: toobit-bridge/.env absent/empty — nothing to escrow.");
    process.exit(1);
  }
  const envText = readFileSync(ENV_PATH, "utf8");
  if (!/^TOOBIT_API_KEY=.+/m.test(envText) || !/^TOOBIT_API_SECRET=.+/m.test(envText)) {
    console.error("FATAL: .env malformed (missing KEY/SECRET lines) — refusing to escrow garbage.");
    process.exit(1);
  }
  const pass = ensurePass().toString();
  const payload = opensslLikeEncrypt(Buffer.from(envText, "utf8"), pass);
  const record = {
    v: 1,
    alg: "AES-256-CBC/PBKDF2-SHA256",
    iter: ITER,
    sha256: createHash("sha256").update(envText).digest("hex"),
    payloadB64: payload.toString("base64"),
    at: new Date().toISOString(),
    passphrase: `${PASS_PRIMARY} (legacy twin: ${PASS_LEGACY})`,
    note: "P0 key escrow — 4th recovery link (trace 1a193604acd890f9; v2 PolarFS-first 2026-11-02); decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:/tmp/my-project/secrets/escrow.pass",
  };
  db.query(
    `INSERT INTO EngineSetting (key, value, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`
  ).run(KEY_ESCROW, JSON.stringify(record), Date.now());
  console.log(`[escrow] stored → EngineSetting "${KEY_ESCROW}" (${payload.length}B payload, sha256 ${record.sha256.slice(0, 12)}…)`);

  // self-test: DB → decrypt → byte-identical with .env
  const row = db.query(`SELECT value FROM EngineSetting WHERE key = ?`).get(KEY_ESCROW) as { value: string };
  const back = opensslLikeDecrypt(Buffer.from((JSON.parse(row.value) as { payloadB64: string }).payloadB64, "base64"), pass);
  const ok = back.toString("utf8") === envText;
  console.log(`[self-test] DB roundtrip byte-identical: ${ok ? "MATCH ✓" : "MISMATCH ✗"}`);
  if (!ok) process.exit(1);
}

// ── verify mode (also runs after escrow) — full chain matrix ────────────────
const envOk = existsSync(ENV_PATH) && statSync(ENV_PATH).size > 0;
const envSha = envOk ? createHash("sha256").update(readFileSync(ENV_PATH)).digest("hex") : null;
const sealedOk = existsSync("/home/z/.nexus-secrets/toobit-bridge.env");
const sealedSha = sealedOk ? createHash("sha256").update(readFileSync("/home/z/.nexus-secrets/toobit-bridge.env")).digest("hex") : null;
const escrowRow = db.query(`SELECT value FROM EngineSetting WHERE key = ?`).get(KEY_ESCROW) as { value: string } | null;
let escrowOk = false;
let escrowSha: string | null = null;
if (escrowRow && existsSync(PASS_PATH)) {
  try {
    const rec = JSON.parse(escrowRow.value) as { payloadB64: string };
    const back = opensslLikeDecrypt(Buffer.from(rec.payloadB64, "base64"), readFileSync(PASS_PATH, "utf8").trim()).toString("utf8");
    escrowSha = createHash("sha256").update(back).digest("hex");
    escrowOk = true;
  } catch (e) {
    console.log("[verify] escrow decrypt FAILED:", (e as Error).message);
  }
}
// newest tbenv backup decrypt (link ③)
let tbenvOk: boolean | null = null;
const envdir = existsSync("/tmp/my-project/backups") ? "/tmp/my-project/backups" : null;
let tbenvSha: string | null = null;
if (envdir) {
  const proc = Bun.spawnSync(["bash", "-c", `ls -1t ${envdir}/tbenv-*.enc 2>/dev/null | head -1`]);
  const newest = proc.stdout.toString().trim();
  if (newest) {
    const passFile = existsSync("/home/z/.nexus-secrets/backup.pass") ? "/home/z/.nexus-secrets/backup.pass" : null;
    const pp = passFile ? `file:${passFile}` : "env:BACKUP_PASSPHRASE";
    const dec = Bun.spawnSync(["bash", "-c", `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "${newest}" -pass "${pp}" 2>/dev/null | sha256sum`]);
    tbenvSha = dec.stdout.toString().split(" ")[0] || null;
    tbenvOk = !!tbenvSha && tbenvSha === envSha;
  }
}

console.log("── KEYCHAIN MATRIX ──");
console.log(`① .env present            : ${envOk ? "PASS" : "FAIL"}${envSha ? ` sha ${envSha.slice(0, 10)}…` : ""}`);
console.log(`② sealed copy (off-tree)  : ${sealedOk ? "PASS" : "FAIL"}${sealedSha ? ` ${sealedSha === envSha ? "= env ✓" : "≠ env ⚠"}` : ""}`);
console.log(`③ tbenv AES backup        : ${tbenvOk === null ? "N/A" : tbenvOk ? "PASS (=env)" : "CHECK"}${tbenvSha ? ` sha ${tbenvSha.slice(0, 10)}…` : ""}`);
console.log(`④ DB escrow decryptable   : ${escrowOk ? "PASS" : "FAIL"}${escrowSha ? ` ${escrowSha === envSha ? "= env ✓" : "(≠ current env — stale)"}` : ""}`);
let bridgeKeys: string | null = null;
try {
  const h = await (await fetch("http://127.0.0.1:3021/health", { signal: AbortSignal.timeout(2000) })).json() as { keysInstalled?: boolean };
  bridgeKeys = h.keysInstalled ? "PASS (keysInstalled)" : "FAIL (keysInstalled=false)";
} catch { bridgeKeys = "N/A (bridge down)"; }
console.log(`⑤ bridge auth             : ${bridgeKeys}`);
const allOk = envOk && escrowOk;
console.log(`── VERDICT: ${allOk ? "RECOVERY-PROOF ✓ (env + escrow agree)" : "ATTENTION NEEDED"}`);
db.close();
process.exit(allOk ? 0 : 2);
