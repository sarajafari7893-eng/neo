// ── NEXUS//SIGNALS — HYPERLIQUID KEY VETTING (Task 56 / HL-ALLOWLIST) ─────────
// Operator order: «نگاشت کلید Hyperliquid به allowlist محدود شود».
//
// Root cause (Task 55 / PHANTOM-FEED-0930): hyperliquidAll() mapped EVERY
// allMids key k → `${k}USDT`. HL carries tokens that share a ticker with a
// DIFFERENT asset (HL "ARK" = 0.1067 while Binance ARKUSDT ≈ 0.7+) — the
// mapped phantom quote fed the consensus and (before the robust-median guard)
// once produced a median that exists on no exchange.
//
// This script is the ONE-SHOT vetting authority:
//   1. structural gate  — HL key must be a plain uppercase ticker
//                          ^[A-Z0-9]{2,20}$  (rejects "@107", "PURR/USDC",
//                          "kPEPE", "=NIL" style keys outright)
//   2. universe gate    — `${k}USDT` must exist on Binance USDT-M futures
//                          (the instrument class the engine actually trades)
//   3. price gate       — HL mid within TOL_PCT of the Binance last price
//                          (catches same-ticker-different-asset collisions)
// Output: src/lib/hl-allowlist.ts — a generated, stamped allowlist module.
// Fail-closed: keys that fail vetting (or new HL listings) are NOT mapped
// until this script is re-run; the other three venues keep quoting.
//
// Run:  bun scripts/hl-vet.ts        (one-shot, ~2 public requests, no keys)
// ─────────────────────────────────────────────────────────────────────────────

const TOL_PCT = 3; // HL allMids vs Binance last — mid-vs-last noise on liquid perps is ≪1%
const OUT = "/home/z/my-project/src/lib/hl-allowlist.ts";

interface VetRow { key: string; sym: string; hl: number; binance: number }

async function jsonFetch(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function main(): Promise<void> {
  const [mids, binance] = await Promise.all([
    jsonFetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }) }) as Promise<Record<string, string>>,
    jsonFetch("https://fapi.binance.com/fapi/v1/ticker/24hr") as Promise<Array<{ symbol: string; lastPrice: string }>>,
  ]);
  const binanceMap = new Map<string, number>();
  for (const row of binance) {
    const p = Number(row.lastPrice);
    if (Number.isFinite(p) && p > 0) binanceMap.set(row.symbol, p);
  }

  const vetted: VetRow[] = [];
  const rejected: Array<{ key: string; why: string }> = [];
  for (const [k, raw] of Object.entries(mids)) {
    const sym = `${k}USDT`;
    const hl = Number(raw);
    if (!/^[A-Z0-9]{2,20}$/.test(k)) { rejected.push({ key: k, why: "structural" }); continue; }
    const ref = binanceMap.get(sym);
    if (ref === undefined) { rejected.push({ key: k, why: "not-on-binance-fapi" }); continue; }
    if (!Number.isFinite(hl) || hl <= 0) { rejected.push({ key: k, why: "bad-hl-price" }); continue; }
    const dev = (Math.abs(hl - ref) / ref) * 100;
    if (dev > TOL_PCT) { rejected.push({ key: k, why: `price-gap ${dev.toFixed(1)}% (hl ${hl} vs fapi ${ref})` }); continue; }
    vetted.push({ key: k, sym, hl, binance: ref });
  }
  vetted.sort((a, b) => a.key.localeCompare(b.key));

  const stamp = new Date().toISOString();
  const body = `// ── GENERATED FILE — do not hand-edit ────────────────────────────────────────
// Task 56 HL-ALLOWLIST · generated ${stamp} by scripts/hl-vet.ts
// Vet: HL allMids key → plain-ticker regex + \${k}USDT exists on Binance USDT-M
// fapi + HL mid within ${TOL_PCT}% of Binance last. ${vetted.length} keys passed,
// ${rejected.length} rejected (same-ticker-different-asset collisions like HL
// "ARK"=0.1067 vs Binance ARKUSDT die here, at the root, before the median).
// Re-run \`bun scripts/hl-vet.ts\` to re-vet / pick up new listings.

export const HL_VETTED_AT = "${stamp}";
export const HL_VET_TOL_PCT = ${TOL_PCT};

export const HL_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
${vetted.map((r) => `  "${r.key}",`).join("\n")}
]);
`;
  await Bun.write(OUT, body);

  const ark = rejected.find((r) => r.key === "ARK");
  console.log(`[hl-vet] vetted=${vetted.length} rejected=${rejected.length} → ${OUT}`);
  console.log(`[hl-vet] sample vetted: ${vetted.slice(0, 8).map((r) => r.key).join(", ")} …`);
  if (ark) console.log(`[hl-vet] ARK correctly REJECTED: ${ark.why}`);
  const collisions = rejected.filter((r) => r.why.startsWith("price-gap"));
  if (collisions.length) console.log(`[hl-vet] price-gap collisions blocked: ${collisions.map((r) => r.key).join(", ")}`);
}

main().catch((e) => { console.error("[hl-vet] FAILED:", String(e).slice(0, 300)); process.exit(1); });
