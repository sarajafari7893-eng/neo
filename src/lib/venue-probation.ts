// ── v12.10 SINGLE-VENUE PROBATION lane (server-only) ────────────────────────
// Operator mandate (AUDIT-20261023 follow-up): «فیلتر و وتوی یک ارز بخاطر
// عملکرد ردیابی اشتباه کار هوشمندانه‌ای نیست و باید ریشه‌ای احیا و کالیبره
// شود».
//
// Doctrine shift: the SINGLE-VENUE hard block stays the DEFAULT for machine
// deploys (cross-venue confirmation is impossible on a single-venue tape —
// the operator's own Binance-ticket mandate), but a coin is NOT banished
// forever. Two rehabilitation paths exist:
//   ① STRUCTURAL — venue expansion: the venue-coverage probe maps which other
//     exchanges list the coin; wiring a second venue lifts vCount to ≥2 and
//     the block converts to the NO-BINANCE-CONFIRM surcharge automatically.
//   ② CALIBRATED — this probation lane: the operator lists a symbol in
//     EngineSetting "single-venue-probation" (JSON {"enabled":bool,"symbols":[...]}).
//     A listed symbol re-enters the machine lane at a HIGHER bar: +8 threshold
//     surcharge, PROBATION tag, every other gate (cascade-freeze / stale-bar /
//     flush-exhaustion / stop-floor) still applies. Reversible and measured —
//     a calibrated re-entry instead of a blind veto.
//
// Cached 15s like gate-settings — never a per-evaluate DB hit.

import { db } from "@/lib/db";

export interface SingleVenueProbation {
  enabled: boolean;
  symbols: string[];
}

const KEY = "single-venue-probation";
let cache: { at: number; value: SingleVenueProbation } | null = null;
const CACHE_TTL = 15_000;

export async function getSingleVenueProbation(): Promise<SingleVenueProbation> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.value;
  const fallback: SingleVenueProbation = { enabled: false, symbols: [] };
  try {
    const row = await db.engineSetting.findUnique({ where: { key: KEY } });
    if (!row?.value) {
      cache = { at: Date.now(), value: fallback };
      return fallback;
    }
    const raw = JSON.parse(row.value) as Partial<SingleVenueProbation>;
    const value: SingleVenueProbation = {
      enabled: raw.enabled === true,
      symbols: Array.isArray(raw.symbols) ? raw.symbols.map((s) => String(s).toUpperCase()).filter((s) => s.endsWith("USDT")).slice(0, 50) : [],
    };
    cache = { at: Date.now(), value };
    return value;
  } catch {
    cache = { at: Date.now(), value: fallback };
    return fallback;
  }
}
