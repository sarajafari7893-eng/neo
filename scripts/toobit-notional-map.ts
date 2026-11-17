// TOOBIT MIN-NOTIONAL MAP (read-only recon) — Next-mission proposal ② (trace 1a1937b74e767b61)
// «نقشهٔ کامل سمبل‌هایی که با مارجین ۲$ غیرقابل‌معامله‌اند (مثل HYPE) در doctrine بریج
//  تا انتظارات کارت شفاف باشد» — mirrors the bridge's own floor math:
//   floorNotional = max(minNotional, minQty × price × mult, floorLearn)
//   marginNotional = marginUsdt × lev   (lev = levMap[sym] ?? cfg.leverage)
// Output: EngineSetting "toobit.notional-map" (DB data-layer, reversible) + stdout summary.
// FLAT-10 untouched — no engine edit.
import { db } from "../src/lib/db";
import { readFileSync, existsSync } from "node:fs";

const BASE = "https://api.toobit.com";
const MARGIN = 2; // fixed-margin mandate (operator order)
const FALLBACK_LEV = 5;

type Instr = { tickSize: number; stepSize: number; minQty: number; maxQty: number; minNotional: number; mult: number };

async function jget<T>(path: string, params: Record<string, string> = {}): Promise<T | null> {
  try {
    const q = new URLSearchParams(params).toString();
    const r = await fetch(`${BASE}${path}${q ? "?" + q : ""}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

// ① instruments
const info = await jget<{ contracts?: Array<{ symbol: string; contractMultiplier?: string; filters?: Array<{ filterType?: string; tickSize?: string; stepSize?: string; minQty?: string; maxQty?: string; minNotional?: string }> }> }>("/api/v1/exchangeInfo");
if (!info?.contracts?.length) { console.error("FATAL: exchangeInfo unreachable"); process.exit(1); }
const instr = new Map<string, Instr>();
for (const c of info.contracts) {
  const it: Instr = { tickSize: 0, stepSize: 0, minQty: 0, maxQty: 0, minNotional: 0, mult: Number(c.contractMultiplier) > 0 ? Number(c.contractMultiplier) : 1 };
  for (const f of c.filters ?? []) {
    const t = f.filterType;
    if (t === "PRICE_FILTER") it.tickSize = Number(f.tickSize);
    if (t === "LOT_SIZE") { it.stepSize = Number(f.stepSize); it.minQty = Number(f.minQty); it.maxQty = Number(f.maxQty); }
    if (t === "MIN_NOTIONAL") it.minNotional = Number(f.minNotional);
  }
  instr.set(c.symbol, it);
}

// ② prices (all-symbol 24hr ticker — Toobit contract quote plane)
type Tick = { s?: string; symbol?: string; c?: string; close?: string; lastPrice?: string };
const ticks = await jget<Tick[]>("/quote/v1/contract/ticker/24hr");
const price = new Map<string, number>();
for (const t of ticks ?? []) {
  const s = t.s ?? t.symbol; const c = Number(t.c ?? t.close ?? t.lastPrice);
  if (s && c > 0) price.set(s, c);
}
console.log(`instruments=${instr.size} · prices=${price.size}`);

// ③ bridge state: levMap + floorLearn + audit-learned floors
const levMap: Record<string, number> = {};
const floorLearn: Record<string, number> = {};
const STATE = ".data/toobit-bridge/state.json";
if (existsSync(STATE)) {
  try { const s = JSON.parse(readFileSync(STATE, "utf8")); Object.assign(levMap, s.levMap ?? {}); Object.assign(floorLearn, s.floorLearn ?? {}); } catch {}
}
// harvest historical server-rejection floors (-1199/-1202) from audit.jsonl — qty × current price × mult is a LOWER bound
try {
  const audit = readFileSync(".data/toobit-bridge/audit.jsonl", "utf8");
  for (const line of audit.split("\n")) {
    if (!/quantity too small/.test(line)) continue;
    try {
      const e = JSON.parse(line);
      const sym = String(e.symbol ?? ""); const qty = Number(e.qty ?? 0);
      const p = price.get(sym); const mult = instr.get(sym)?.mult ?? 1;
      if (sym && qty > 0 && p > 0) floorLearn[sym] = Math.max(floorLearn[sym] ?? 0, qty * p * mult);
    } catch {}
  }
} catch {}

// ④ compute map
type Row = { symbol: string; price: number; minQty: number; mult: number; minNotional: number; floor: number; lev: number; marginNotional: number; verdict: "OK" | "TIGHT" | "BLOCKED"; src: string };
const rows: Row[] = [];
for (const [sym, it] of instr) {
  const p = price.get(sym);
  if (!p || p <= 0) continue;
  const floor = Math.max(it.minNotional, it.minQty * p * it.mult, floorLearn[sym] ?? 0);
  const lev = levMap[sym] ?? FALLBACK_LEV;
  const marginNotional = MARGIN * lev;
  const src = floorLearn[sym] && floorLearn[sym] >= Math.max(it.minNotional, it.minQty * p * it.mult) ? "learned" : "exchangeInfo";
  const verdict: Row["verdict"] = floor > marginNotional ? "BLOCKED" : floor > marginNotional * 0.6 ? "TIGHT" : "OK";
  rows.push({ symbol: sym, price: p, minQty: it.minQty, mult: it.mult, minNotional: it.minNotional, floor: +floor.toFixed(2), lev, marginNotional, verdict, src });
}
rows.sort((a, b) => b.floor / b.marginNotional - a.floor / a.marginNotional);
const blocked = rows.filter(r => r.verdict === "BLOCKED");
const tight = rows.filter(r => r.verdict === "TIGHT");
const ok = rows.filter(r => r.verdict === "OK");

console.log(`\n== TOOBIT NOTIONAL MAP @ margin=$${MARGIN} (lev=levMap||${FALLBACK_LEV}) ==`);
console.log(`OK=${ok.length} · TIGHT=${tight.length} · BLOCKED=${blocked.length}  (total priced=${rows.length})`);
console.log(`\nBLOCKED (${blocked.length}) — a $${MARGIN}-margin signal on these symbols will honestly MIN_FLOOR_SKIP:`);
for (const r of blocked.slice(0, 40)) console.log(`  ${r.symbol.padEnd(20)} floor=$${String(r.floor).padStart(8)} > $${MARGIN}×${r.lev}=${r.marginNotional}$ (${r.src}, minQty=${r.minQty}×$${r.price.toPrecision(4)}×mult${r.mult})`);
console.log(`\nTIGHT (${tight.length}) — floor within 60-100% of margin notional (slippage/rounding risk):`);
for (const r of tight.slice(0, 15)) console.log(`  ${r.symbol.padEnd(20)} floor=$${String(r.floor).padStart(8)} vs $${r.marginNotional}$ (${r.src})`);
const hype = rows.find(r => r.symbol.startsWith("HYPE"));
if (hype) console.log(`\nHYPE check: floor=$${hype.floor} vs marginNotional=$${hype.marginNotional} → ${hype.verdict} (NX-3218 forensics said floor 90.04$ @ lev11 — now lev=${hype.lev})`);

// ⑤ persist snapshot (data-layer journal, reversible)
const snap = { at: new Date().toISOString(), marginUsdt: MARGIN, fallbackLev: FALLBACK_LEV, priced: rows.length, counts: { ok: ok.length, tight: tight.length, blocked: blocked.length }, blockedSymbols: blocked.map(r => ({ symbol: r.symbol, floor: r.floor, lev: r.lev, marginNotional: r.marginNotional, src: r.src })), tightSymbols: tight.map(r => ({ symbol: r.symbol, floor: r.floor, lev: r.lev, marginNotional: r.marginNotional, src: r.src })) };
await db.engineSetting.upsert({
  where: { key: "toobit.notional-map" },
  create: { key: "toobit.notional-map", value: JSON.stringify(snap) },
  update: { value: JSON.stringify(snap) },
});
await db.signalEvent.create({ data: { type: "SYSTEM", level: "ai", message: `TOOBIT NOTIONAL MAP: priced=${rows.length} OK=${ok.length} TIGHT=${tight.length} BLOCKED=${blocked.length} @ margin=$${MARGIN} — doctrine expectations for the live card (proposal ②, trace 1a1937b74e767b61). Top-blocked: ${blocked.slice(0, 6).map(r => r.symbol).join(", ") || "—"}` } });
console.log("\npersisted → EngineSetting 'toobit.notional-map' + SYSTEM event ✓");
await db.$disconnect();
