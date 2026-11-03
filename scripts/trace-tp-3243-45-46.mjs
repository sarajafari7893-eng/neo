// v14.2 — READ-ONLY forensic trace: settle→reachedTp miss on NX-3243/3245/3246
// (audit fc143950 critical lead: maxPnl >> TP1 yet reachedTp=0 — suspect stale
// evaluate price series during the fapi-poverty window). NO writes anywhere.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
const SERIALS = [3243, 3245, 3246];
const rows = await db.signal.findMany({
  where: { serial: { in: SERIALS } },
  include: { events: { orderBy: { createdAt: "asc" } } },
});
for (const r of rows) {
  const long = r.direction === "LONG";
  const dist = (t) => t ? Number((((long ? t - r.entryPrice : r.entryPrice - t) / r.entryPrice) * 100).toFixed(2)) : null;
  console.log("=== NX-" + String(r.serial).padStart(4, "0"), r.symbol, r.direction, r.strategy, "status=" + r.status, "reachedTp=" + r.reachedTp);
  console.log("  entry", r.entryPrice, "tp1", r.tp1, "(" + dist(r.tp1) + "%)", "tp2", r.tp2, "(" + dist(r.tp2) + "%)", "sl", r.stopLoss, "leverage", r.leverage);
  console.log("  maxPnl(levered life)", r.maxPnlPercent + "%", "maxPostPnl", r.maxPostPnlPercent + "%", "pnl", r.pnlPercent + "%", "margin $" + r.marginUsd, "ttl", r.ttlMinutes + "m ext", r.ttlExtensions);
  console.log("  created", r.createdAt?.toISOString?.() ?? r.createdAt, "expires", r.expiresAt?.toISOString?.() ?? r.expiresAt, "closed", r.closedAt?.toISOString?.() ?? r.closedAt, "afterlife", r.afterlife, r.afterlifeAt?.toISOString?.() ?? "");
  for (const e of r.events) console.log("   ev", e.createdAt?.toISOString?.() ?? e.createdAt, e.type, e.level, String(e.message).slice(0, 130));
  // price-series audit inside the life window: sample, min/max, gap structure
  const t0 = new Date(r.createdAt), t1 = new Date(r.closedAt ?? r.expiresAt);
  const pts = await db.pricePoint.findMany({ where: { symbol: r.symbol, createdAt: { gte: t0, lte: t1 } }, orderBy: { createdAt: "asc" }, select: { price: true, createdAt: true } });
  const px = pts.map(p => p.price);
  const tp1Hit = px.filter(p => long ? p >= r.tp1 : p <= r.tp1).length;
  let maxGapMs = 0, gapAt = null, prev = null;
  for (const p of pts) { if (prev) { const g = p.createdAt - prev.createdAt; if (g > maxGapMs) { maxGapMs = g; gapAt = prev.createdAt; } } prev = p.createdAt; }
  // 5-min bucket cadence (feed pulse)
  const buckets = new Map();
  for (const p of pts) { const k = Math.floor(p.createdAt.getTime() / 300000); buckets.set(k, (buckets.get(k) ?? 0) + 1); }
  const cadence = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${new Date(k * 300000).toISOString().slice(11, 16)}:${n}`).join(" ");
  console.log("  [price series]", pts.length, "pts · min", px.length ? Math.min(...px).toFixed(4) : "-", "max", px.length ? Math.max(...px).toFixed(4) : "-", "· points at/beyond TP1:", tp1Hit, "· maxGap", Math.round(maxGapMs / 1000) + "s @" + (gapAt?.toISOString?.() ?? "-"));
  console.log("   cadence/5min:", cadence || "(EMPTY — no price writes in window)");
  // post-window real market check: did price reach TP1 AFTER expiry? (afterlife corroboration)
  const post = await db.pricePoint.findMany({ where: { symbol: r.symbol, createdAt: { gte: t1, lte: new Date(t1.getTime() + 6 * 3600_000) } }, orderBy: { createdAt: "asc" }, select: { price: true, createdAt: true } });
  const postHit = post.find(p => long ? p.price >= r.tp1 : r.tp1 >= p.price || true); // direction below
  const postTp1 = post.filter(p => long ? p.price >= r.tp1 : p.price <= r.tp1);
  console.log("  [post-window 6h]", post.length, "pts · TP1 touched post-expiry:", postTp1.length, postTp1.length ? "first @" + postTp1[0].createdAt.toISOString() : "");
}
await db.$disconnect();
