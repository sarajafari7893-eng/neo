// ── ENV-GUARD v1.0 — self-healing .env for the recurring sandbox-erasure class ──
// Incident class (3× on 2026-09-21 alone): the platform resumes/replaces the
// sandbox and resets .env to the bare DATABASE_URL template → Telegram relay
// disarms, bridge sleeps, backups go NO_PASSPHRASE, daily reports die.
//
// Doctrine: the LOCAL plain snapshot ring (/tmp/my-project/backups/*.zip) is
// the env source of truth on this machine — zips intentionally include .env
// ("plain zip never leaves the sandbox"; only off-site copies are encrypted).
// This guard rides the pulse (probe cadence 15s) and heals within ~1 minute
// of any erasure, WITHOUT needing the operator passphrase.
//
// Safety: never logs values (key names only); atomic install (tmp+rename,
// chmod 600); backs up the erased file for forensics; also injects recovered
// values into process.env so the running process heals without a restart;
// re-arms the bridge loop; appends a human changelog line; records
// EngineSetting envguard.state. Every path fails soft — the pulse must never
// break because of the guard.

import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const ROOT = process.cwd();
const ENV_PATH = `${ROOT}/.env`;
const BACKUP_DIR = "/tmp/my-project/backups";
const REQUIRED_KEYS = [
  "DATABASE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "NEXUS_CONTROL_KEY",
  "BACKUP_PASSPHRASE",
] as const;

export interface EnvGuardResult {
  checked: boolean;
  healthy: boolean;
  missing: string[];
  restored: boolean;
  source?: string;
  error?: string;
}

interface G {
  lastCheckAt?: number;
  lastHealthy?: boolean;
  lastResult?: EnvGuardResult;
  inflight?: boolean;
}
const g = globalThis as unknown as G;

function parseEnvKeys(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (k && v) map.set(k, v);
  }
  return map;
}

async function currentMissing(): Promise<string[]> {
  try {
    if (!existsSync(ENV_PATH)) return [...REQUIRED_KEYS];
    const txt = await readFile(ENV_PATH, "utf8");
    const map = parseEnvKeys(txt);
    return REQUIRED_KEYS.filter((k) => !map.get(k));
  } catch {
    return [...REQUIRED_KEYS];
  }
}

async function newestPlainZip(maxAgeDays = 10): Promise<string | null> {
  try {
    const dirStat = await stat(BACKUP_DIR).catch(() => null);
    if (!dirStat) return null;
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(BACKUP_DIR))
      .filter((f) => /^nexus-snapshot-\d{8}-\d{6}\.zip$/.test(f))
      .sort()
      .reverse(); // stamp sorts chronologically
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    for (const f of files) {
      const st = await stat(`${BACKUP_DIR}/${f}`).catch(() => null);
      if (st && st.mtimeMs >= cutoff) return `${BACKUP_DIR}/${f}`;
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

async function extractEnvFromZip(zip: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run("unzip", ["-p", zip, ".env"], { timeout: 15_000, maxBuffer: 4_000_000 });
    return stdout && stdout.includes("=") ? stdout : null;
  } catch {
    // some zips prefix "./" — retry once
    try {
      const { stdout } = await run("unzip", ["-p", zip, "./.env"], { timeout: 15_000, maxBuffer: 4_000_000 });
      return stdout && stdout.includes("=") ? stdout : null;
    } catch {
      return null;
    }
  }
}

async function changelog(line: string): Promise<void> {
  try {
    const stamp = new Date().toISOString();
    await appendFile(`${ROOT}/docs/CHANGELOG-human.md`, `\n- \`${stamp}\` ENV-GUARD: ${line}\n`);
  } catch {
    /* changelog is best-effort */
  }
}

async function recordState(state: Record<string, unknown>): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.engineSetting.upsert({
      where: { key: "envguard.state" },
      create: { key: "envguard.state", value: JSON.stringify(state) },
      update: { value: JSON.stringify(state) },
    });
  } catch {
    /* state is best-effort */
  }
}

/** Heal entry point — call from the pulse (internally throttled to 60s). */
export async function maybeEnsureEnv(force = false): Promise<EnvGuardResult> {
  const now = Date.now();
  if (!force) {
    if (g.inflight) return g.lastResult ?? { checked: false, healthy: true, missing: [], restored: false };
    if (g.lastCheckAt && now - g.lastCheckAt < 60_000) {
      return g.lastResult ?? { checked: false, healthy: true, missing: [], restored: false };
    }
  }
  g.inflight = true;
  g.lastCheckAt = now;
  try {
    const missing = await currentMissing();
    if (missing.length === 0) {
      g.lastHealthy = true;
      g.lastResult = { checked: true, healthy: true, missing: [], restored: false };
      return g.lastResult;
    }

    console.warn(`[env-guard] .env missing keys: ${missing.join(",")} — attempting auto-restore from local snapshot ring`);
    const zip = await newestPlainZip();
    if (!zip) {
      g.lastHealthy = false;
      g.lastResult = { checked: true, healthy: false, missing, restored: false, error: "no local snapshot zip available" };
      await recordState({ at: now, missing, restored: false, error: "no-zip" });
      await changelog(`.env erasure detected (missing: ${missing.join(", ")}) — NO local zip available, manual recovery needed`);
      return g.lastResult;
    }

    const text = await extractEnvFromZip(zip);
    if (!text) {
      g.lastHealthy = false;
      g.lastResult = { checked: true, healthy: false, missing, restored: false, error: "zip had no readable .env", source: zip };
      await recordState({ at: now, missing, restored: false, error: "zip-unreadable", source: zip });
      await changelog(`.env erasure detected — zip ${zip.split("/").pop()} had no readable .env`);
      return g.lastResult;
    }

    const map = parseEnvKeys(text);
    const recovered = REQUIRED_KEYS.filter((k) => map.get(k));
    if (recovered.length < 4) {
      g.lastHealthy = false;
      g.lastResult = { checked: true, healthy: false, missing, restored: false, error: `zip env had only ${recovered.length}/5 required keys`, source: zip };
      await recordState({ at: now, missing, restored: false, error: "zip-env-incomplete", source: zip });
      await changelog(`.env erasure — candidate zip env incomplete (${recovered.length}/5 keys), refusing install`);
      return g.lastResult;
    }

    // forensics: keep the erased file
    try {
      await mkdir(`${ROOT}/.env-erased`, { recursive: true });
      const cur = await readFile(ENV_PATH, "utf8").catch(() => "");
      await writeFile(`${ROOT}/.env-erased/erased-${now}.txt`, cur, { mode: 0o600 });
    } catch {
      /* forensics best-effort */
    }

    // atomic install
    const tmp = `${ENV_PATH}.guard.tmp`;
    await writeFile(tmp, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, ENV_PATH);
    await chmod(ENV_PATH, 0o600);

    // heal the RUNNING process without restart
    for (const [k, v] of map) process.env[k] = v;

    // re-arm the bridge loop with the recovered token
    try {
      const bridge = await import("@/lib/telegram-bridge");
      void bridge.ensureBridgeLoopAlive();
    } catch {
      /* re-arm best-effort */
    }

    await recordState({ at: now, missing, restored: true, source: zip.split("/").pop(), recoveredKeys: recovered.length });
    await changelog(`.env auto-restored from local snapshot ring (${zip.split("/").pop()}) — ${recovered.length}/5 keys, bridge re-arm issued. Erasure forensics: .env-erased/erased-${now}.txt`);
    console.warn(`[env-guard] RESTORED .env from ${zip.split("/").pop()} — ${recovered.length}/5 keys, process.env healed, bridge re-arm issued`);
    g.lastHealthy = true;
    g.lastResult = { checked: true, healthy: true, missing: [], restored: true, source: zip };
    return g.lastResult;
  } catch (e) {
    g.lastHealthy = false;
    g.lastResult = { checked: true, healthy: false, missing: await currentMissing().catch(() => []), restored: false, error: String(e).slice(0, 140) };
    return g.lastResult;
  } finally {
    g.inflight = false;
  }
}

/** Read-only status for /api/healthz-style consumers. */
export function getEnvGuardStatus(): EnvGuardResult & { lastCheckAt?: number } {
  return { ...(g.lastResult ?? { checked: false, healthy: true, missing: [], restored: false }), lastCheckAt: g.lastCheckAt };
}
