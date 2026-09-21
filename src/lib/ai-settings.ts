// ── FlowRadar//AI-CORE settings (server-only) — v6.7.4 THOUGHT-CORE ──
// Persisted in EngineSetting key "ai". The operator owns the AI-core mode
// (this is infrastructure, NOT a deployment gate — those stay governor-only).
// thoughtMode=1 upgrades every judgment LLM channel to reasoning ("thought")
// mode: the model reasons step-by-step before answering, trading latency for
// depth on exactly the channels where depth pays (governor, card briefs,
// analyst chat, deep-learn research). The high-frequency symbol scanner keeps
// fast mode so bulk structural scans stay snappy (per-channel plan below).

import { db } from "@/lib/db";

export interface AiSettings {
  thoughtMode: number; // 0–1, default 1 — 1 = reasoning ("thought") mode ON for judgment channels
}

const CLAMP: [number, number, number] = [0, 1, 1]; // [min, max, default]

/** Per-channel thought-mode plan (documented operator contract):
 *  - analyst-chat  → follows thoughtMode (on-demand, depth pays)
 *  - card-brief    → follows thoughtMode (HOLD/CLOSE/PARTIAL decisions)
 *  - governor      → follows thoughtMode (strategy decisions, 1 cycle/6h)
 *  - deep-learn    → ALWAYS thought (research desk — the original thought channel)
 *  - symbol-scan   → ALWAYS fast (bulk structural scans, latency-sensitive UX) */
export const THOUGHT_CHANNELS: Record<string, boolean> = {
  "analyst-chat": true,
  "card-brief": true,
  governor: true,
  "deep-learn": true,
  "symbol-scan": false,
};

const KEY = "ai";

let cache: { at: number; value: AiSettings } | null = null;
const CACHE_TTL = 15_000;

function clamp(raw: Partial<AiSettings>): AiSettings {
  return {
    thoughtMode: Math.min(CLAMP[1], Math.max(CLAMP[0], Math.round(raw.thoughtMode ?? CLAMP[2]))),
  };
}

export async function getAiSettings(): Promise<AiSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value;
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    const value = clamp(row ? (JSON.parse(row.value) as Partial<AiSettings>) : {});
    cache = { at: Date.now(), value };
    return value;
  } catch {
    return clamp({});
  }
}

export async function putAiSettings(next: Partial<AiSettings>): Promise<AiSettings> {
  const cur = await getAiSettings();
  const value = clamp({ ...cur, ...next });
  await db.engineSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(value) },
    update: { value: JSON.stringify(value) },
  });
  cache = { at: Date.now(), value };
  return value;
}

export function describeAi(a: AiSettings): string {
  const on = a.thoughtMode === 1;
  const channels = Object.entries(THOUGHT_CHANNELS)
    .map(([ch, follows]) => (on ? (follows ? `${ch}:THOUGHT` : `${ch}:FAST`) : `${ch}:FAST`))
    .join(" · ");
  return `THOUGHT-CORE ${on ? "ON" : "OFF"} · ${channels}`;
}
