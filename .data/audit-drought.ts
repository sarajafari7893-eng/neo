import { Database } from "bun:sqlite";
const db = new Database("/home/z/my-project/db/custom.db", { readonly: true });
db.exec("PRAGMA busy_timeout=2500");

const now = Date.now();
const h = (n: number) => new Date(now - n * 3600_000).toISOString();

console.log("=== SIGNAL ISSUANCE FUNNEL (last 72h, 6h buckets, Tehran-free UTC) ===");
const funnel = db.prepare(`
  SELECT date(datetime(createdAt/1000,'unixepoch')) d,
         (strftime('%H', datetime(createdAt/1000,'unixepoch'))/6)*6 b6,
         COUNT(*) n,
         SUM(CASE WHEN status='ENTERED' THEN 1 ELSE 0 END) entered,
         SUM(CASE WHEN status='PENDING' THEN 1 ELSE 0 END) pending,
         SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) expired,
         SUM(CASE WHEN status IN ('SL','TP1','TP2','TP3','CLOSED') THEN 1 ELSE 0 END) settled
  FROM Signal WHERE createdAt > (? - 72*3600*1000)
  GROUP BY d, b6 ORDER BY d, b6
`).all(now - 72 * 3600 * 1000) as any[];
for (const r of funnel) console.log(`${r.d} ${String(r.b6).padStart(2, '0')}:00Z  total=${r.n} entered=${r.entered} pending=${r.pending} expired=${r.expired} settled=${r.settled}`);

console.log("\n=== LAST 12 SIGNALS (any status) ===");
const last = db.prepare(`
  SELECT id, symbol, direction, strategy, status, createdAt, confidence,
         CASE WHEN length(reason)>90 THEN substr(reason,1,90)||'…' ELSE reason END reason
  FROM Signal ORDER BY createdAt DESC LIMIT 12
`).all() as any[];
for (const r of last) console.log(`${new Date(r.createdAt).toISOString()} ${r.symbol.padEnd(12)} ${String(r.direction||'').padEnd(5)} ${String(r.strategy||'').slice(0,14).padEnd(14)} ${String(r.status).padEnd(9)} conf=${r.confidence} ${r.reason||''}`);

console.log("\n=== CANDIDATE/SCAN AUDIT TABLES (if exist) ===");
const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as any[];
console.log(tables.map(t => t.name).join(", "));
db.close();
