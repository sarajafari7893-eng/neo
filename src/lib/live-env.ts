// ── NEXUS//SIGNALS — LIVE-ENV (Task 36 · stale-env class killer) ─────────────
// Incident class (proven live 2026-09-26): process.env is FROZEN at container
// boot — the platform's tini/start.sh boots Next once and never respawns it,
// and every watchdog/layer-2 heal-spawn simply INHERITS the boot env. bun's
// .env auto-load does NOT override already-set env vars, so after a control-key
// rotation every gate kept validating the OLD key forever (verified: old→200,
// new→401 across app + mini-services).
//
// DOCTRINE: the .env FILE is the live source of truth on this machine (same
// stance as env-guard.ts: "the local plain snapshot ring / .env is the env
// source of truth"). liveEnv() reads it with an mtime-cached parse and falls
// back to process.env only for keys absent from the file. Never logs values.
//
// SERVER-ONLY (node:fs) — safe in route handlers, server components and
// nodejs-runtime middleware. Never import from client components.

import { readFileSync, statSync } from "node:fs";

const ENV_PATH = `${process.cwd()}/.env`;
let cache: { mtimeMs: number; values: Map<string, string> } | null = null;

function parseEnvFile(): Map<string, string> {
  try {
    const st = statSync(ENV_PATH);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.values;
    const values = new Map<string, string>();
    for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] && m[2] !== undefined) values.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
    }
    cache = { mtimeMs: st.mtimeMs, values };
    return values;
  } catch {
    return cache?.values ?? new Map<string, string>();
  }
}

/** .env file first (live, mtime-cached) → process.env fallback. */
export function liveEnv(key: string): string {
  const fromFile = parseEnvFile().get(key);
  if (fromFile && fromFile.length > 0) return fromFile;
  return process.env[key] ?? "";
}
