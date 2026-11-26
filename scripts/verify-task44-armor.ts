// ── verify-task44-armor.ts (Task 44 — price-armor + egress manager, readonly) ──
// Proves the v12.0 write-side phantom-anchor neutralization + egress/IP manager:
//   [1] OFFLINE decision tests — resolveTerminalPrice pure-function contract:
//       zombie rejection, cross-plane divergence guard, anchor-locked sim drift,
//       restore-rewind detection, consensus priority, drift excursion cap.
//   [2] LIVE ZOMBIE SPOT SCAN — one spot /api/v3/ticker/24hr call over every
//       tracked symbol: flags zombie books (bid=0/ask=0) + >10% spot↔perp
//       divergence candidates (the XMR class watchlist).
//   [3] EGRESS STATUS — /api/egress-status: sampled pool IP, named ban ledger
//       (persisted), global window, probe counters.
//   [4] XMR LIVE STATE — MarketAsset XMR must carry the live perp price (~590s),
//       NOT the 118.7 zombie anchor; recent PricePoints must be live-only prints.
// Read-only. bun run scripts/verify-task44-armor.ts

import { PrismaClient } from "@prisma/client";
import { resolveTerminalPrice, isTradeableTicker, SIM_DRIFT_CAP_PCT } from "../src/lib/price-armor";

const db = new PrismaClient();
const KEY = "3195f6883529fa43a9d62d0fa92b01e7adc851ed0ed3b2b6";

let pass = 0;
let fail = 0;
function test(name: string, cond: boolean, detail: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name} — ${detail}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} — ${detail}`);
  }
}

async function main() {
  console.log("═".repeat(84));
  console.log("TASK 44 · PRICE-ARMOR + EGRESS VERIFICATION (v12.0)");
  console.log("═".repeat(84));

  // ── [1] offline decision tests ─────────────────────────────────────────
  console.log("\n[1] resolveTerminalPrice decision contract (offline, deterministic jitter=0):");
  const j = () => 0.5; // neutral jitter → walk = base exactly

  // 1a. the measured XMR case: zombie spot 118.7 while anchor is live 592
  let r = resolveTerminalPrice({ tPrice: 118.7, tZombie: true, tSpotOverlay: true, consMedian: null, consVenues: 0, anchor: 592.0, storedPrice: 118.7 }, j);
  test("zombie spot refused", r.zombieRejected && !r.liveNow, `class=${r.priceClass} next=${r.next.toFixed(2)}`);
  test("rewind detected (118.7 vs 592 anchor)", r.rewound, `stored deviates ${(((118.7 - 592) / 592) * 100).toFixed(1)}%`);
  test("sim drift anchors on LIVE price, not stored row", Math.abs(r.next - 592.0) < 592 * (SIM_DRIFT_CAP_PCT / 100) + 1e-9, `next=${r.next.toFixed(2)} (118.7 would be the phantom)`);

  // 1b. zombie WITH book but diverging spot (spot 118.7, non-empty book edge)
  r = resolveTerminalPrice({ tPrice: 118.7, tZombie: false, tSpotOverlay: true, consMedian: null, consVenues: 0, anchor: 592.0, storedPrice: 592.0 }, j);
  test("cross-plane divergence guard (>10% vs anchor)", r.zombieRejected && r.priceClass === "sim-drift", `class=${r.priceClass}`);

  // 1c. real crash (AGT-class, −16% in 100s) via LIVE fapi ticker must PASS
  r = resolveTerminalPrice({ tPrice: 0.0624, tZombie: false, tSpotOverlay: false, consMedian: null, consVenues: 0, anchor: 0.0745, storedPrice: 0.0745 }, j);
  test("real fapi-sourced crash is NOT blocked", r.liveNow && r.priceClass === "live-ticker" && !r.zombieRejected, `next=${r.next} (spot-overlay guard only touches overlay quotes)`);
  r = resolveTerminalPrice({ tPrice: 0.0624, tZombie: false, tSpotOverlay: true, consMedian: null, consVenues: 0, anchor: 0.0745, storedPrice: 0.0745 }, j);
  test("crash-shaped SPOT-OVERLAY quote refused (guard scope)", r.zombieRejected && r.priceClass === "sim-drift", "the same shape from the overlay plane is the XMR class");

  // 1d. consensus (≥2 venues) wins over a zombie ticker
  r = resolveTerminalPrice({ tPrice: 118.7, tZombie: true, tSpotOverlay: true, consMedian: 591.5, consVenues: 3, anchor: 592.0, storedPrice: 591.8 }, j);
  test("consensus beats zombie ticker", r.liveNow && r.priceClass === "live-consensus" && Math.abs(r.next - 591.5) < 1e-9, `next=${r.next}`);

  // 1e. cold start (no anchor): zombie refused, no crash
  r = resolveTerminalPrice({ tPrice: 118.7, tZombie: true, tSpotOverlay: true, consMedian: null, consVenues: 0, anchor: null, storedPrice: 0 }, j);
  test("cold-start zombie refused + freeze", !r.liveNow && r.next === 0 && r.priceClass === "frozen", `class=${r.priceClass}`);

  // 1f. drift excursion cap: violent jitter cannot walk the sim price >±0.25%
  const wild = () => 1.0; // max positive jitter
  r = resolveTerminalPrice({ tPrice: null, tZombie: true, tSpotOverlay: true, consMedian: null, consVenues: 0, anchor: 592.0, storedPrice: 592.0 }, wild);
  test("sim drift excursion capped", r.next <= 592.0 * (1 + SIM_DRIFT_CAP_PCT / 100) + 1e-9, `next=${r.next.toFixed(3)} cap=+${SIM_DRIFT_CAP_PCT}%`);

  // 1g. isTradeableTicker contract
  test("zombie book (bid=0,ask=0) detected", !isTradeableTicker({ bidPrice: "0.00000000", askPrice: "0.00000000" }), "XMR spot shape");
  test("real book passes", isTradeableTicker({ bidPrice: "591.9", askPrice: "592.1" }), "two-sided market");

  // ── [2] live zombie spot scan ─────────────────────────────────────────
  console.log("\n[2] LIVE zombie/divergence scan (spot plane vs tracked perp rows):");
  const assets = await db.marketAsset.findMany({ select: { symbol: true, price: true, source: true } });
  let spot: Array<{ symbol: string; lastPrice: string; bidPrice?: string; askPrice?: string }> = [];
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/24hr", { cache: "no-store" });
    if (res.ok) spot = await res.json();
  } catch { /* spot down — skip scan */ }
  const spotMap = new Map(spot.map((t) => [t.symbol, t]));
  const zombies: string[] = [];
  const divergent: string[] = [];
  let spotSeen = 0;
  for (const a of assets) {
    const t = spotMap.get(a.symbol);
    if (!t) continue;
    spotSeen++;
    if (!isTradeableTicker(t)) zombies.push(a.symbol);
    else {
      const sp = Number(t.lastPrice);
      if (sp > 0 && a.price > 0 && (Math.abs(sp - a.price) / a.price) * 100 > 10) divergent.push(`${a.symbol} spot=${sp} perp=${a.price}`);
    }
  }
  console.log(`  spot rows matched: ${spotSeen}/${assets.length} tracked symbols`);
  console.log(`  zombie books (bid=0/ask=0): ${zombies.length ? zombies.join(", ") : "none in tracked universe ✓"}`);
  console.log(`  >10% spot↔perp divergence: ${divergent.length ? divergent.join(" · ") : "none ✓"}`);

  // ── [3] egress status ──────────────────────────────────────────────────
  console.log("\n[3] EGRESS / IP-BAN picture (/api/egress-status):");
  try {
    const res = await fetch("http://localhost:3000/api/egress-status", { headers: { "x-nexus-key": KEY }, cache: "no-store" });
    const j2 = await res.json();
    const e = j2.egress ?? {};
    console.log(`  sampled egress IP: ${e.sampledIp ?? "?"} (${e.sampledAt ? new Date(e.sampledAt).toISOString() : "never"})`);
    console.log(`  global ban window: ${e.banRemainingMs > 0 ? `${Math.round(e.banRemainingMs / 1000)}s left` : "none"}`);
    const bans = e.bannedIps ?? [];
    console.log(`  named banned pool IPs: ${bans.length === 0 ? "none ✓" : ""}`);
    for (const b of bans) console.log(`    · ${b.ip} — until ${new Date(b.until).toISOString()} (${Math.round(b.remainingMs / 60000)}min left)`);
    console.log(`  rotation-aware probes: issued=${e.probesIssued ?? 0} lifts=${e.probeLifts ?? 0}`);
    console.log(`  feed: ${j2.feed?.source ?? "?"} lastOk=${j2.feed?.lastOkAt ? Math.round((Date.now() - j2.feed.lastOkAt) / 1000) + "s ago" : "—"}`);
  } catch (e: any) {
    console.log(`  egress-status unreachable: ${String(e).slice(0, 80)}`);
  }

  // ── [4] XMR live state ────────────────────────────────────────────────
  console.log("\n[4] XMRUSDT live state (the phantom-anchor case):");
  const xmr = await db.marketAsset.findUnique({ where: { symbol: "XMRUSDT" } });
  if (xmr) {
    const zombieAnchor = Math.abs(xmr.price - 118.7) / 118.7 < 0.02;
    console.log(`  MarketAsset price=${xmr.price} source=${xmr.source} ${zombieAnchor ? "← STILL THE 118.7 ZOMBIE ANCHOR ✗" : "← live perp region ✓"}`);
  }
  const pts = await db.pricePoint.findMany({ where: { symbol: "XMRUSDT" }, orderBy: { createdAt: "desc" }, take: 20, select: { price: true, createdAt: true } });
  const realRange = pts.filter((p) => p.price > 400).length;
  console.log(`  last ${pts.length} PricePoints: ${realRange} in the real 400+ range, ${pts.length - realRange} below (recent tail should be 100% live-only)`);
  const last10 = pts.slice(0, 10).map((p) => p.price.toFixed(1)).join(" ");
  console.log(`  tail: ${last10}`);

  console.log("\n" + "═".repeat(84));
  console.log(`RESULT: offline contract ${pass}/${pass + fail} ✓${fail ? ` · ${fail} FAILED` : ""}`);
  console.log("═".repeat(84));
  await db.$disconnect();
  if (fail > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error("verify-task44-armor failed:", e);
  process.exit(1);
});
