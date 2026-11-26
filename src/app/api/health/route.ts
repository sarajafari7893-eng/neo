import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — SANDBOX HEARTBEAT compat endpoint (operator order 2026-09-30).
 * The operator's keep-warm cron template probes `localhost:81/api/health` and
 * requires HTTP 200 + version/uptime fields. The deep P0 endpoint lives at
 * /api/healthz (z-suffix, battle-tested — do not move). This is the template-
 * facing alias: fast, fail-open, no DB, single watchdog roundtrip for `ver`.
 */
function gitHeadSha(): string | null {
  try {
    const head = readFileSync("/home/z/my-project/.git/HEAD", "utf8").trim();
    const m = head.match(/^ref:\s+(.+)$/);
    if (!m) return head.slice(0, 7) || null;
    const refPath = `/home/z/my-project/.git/${m[1]!}`;
    if (!existsSync(refPath)) return null;
    const sha = readFileSync(refPath, "utf8").trim();
    return sha.slice(0, 7) || null;
  } catch {
    return null;
  }
}

async function watchdogVer(): Promise<string | null> {
  try {
    const r = await fetch("http://127.0.0.1:3020/status", {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!r.ok) return null;
    const d = (await r.json()) as { ver?: unknown };
    return typeof d.ver === "string" ? d.ver : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const ver = await watchdogVer();
  return NextResponse.json(
    {
      ok: true,
      ver: ver ?? "unknown",
      uptimeSec: Math.round(process.uptime()),
      gitSha: gitHeadSha(),
      ts: Date.now(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
