// SENTINEL-20261124-DATA-HISTORY — mtime forensics: did anything get WRITTEN during the 11-12..11-18 hole?
// If files carry mtimes inside the hole → the sandbox was alive and writes happened (rollback loss).
// If nothing carries mtimes in the hole → the sandbox was suspended (no collection at all).
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const HOLE_A = Date.UTC(2026, 10, 12, 0, 0, 0); // 2026-11-12T00:00Z
const HOLE_B = Date.UTC(2026, 10, 19, 0, 0, 0); // 2026-11-19T00:00Z
const GAP2_A = Date.UTC(2026, 10, 21, 12, 0, 0); // second outage candidate
const GAP2_B = Date.UTC(2026, 10, 23, 20, 0, 0);

const roots = [".data", "db", "src", "scripts", "prisma", "mini-services"];
const inHole1 = [], inHole2 = [];

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    try {
      const st = statSync(p);
      const m = st.mtimeMs;
      if (m >= HOLE_A && m < HOLE_B) inHole1.push(`${p} | mtime=${st.mtime.toISOString()} | size=${st.size}`);
      else if (m >= GAP2_A && m < GAP2_B) inHole2.push(`${p} | mtime=${st.mtime.toISOString()} | size=${st.size}`);
    } catch {}
  }
}
for (const r of roots) walk(r, 0);

console.log(`--- files WRITTEN during hole-1 (11-12 .. 11-19): ${inHole1.length} ---`);
for (const line of inHole1.slice(0, 60)) console.log("  " + line);
console.log(`--- files WRITTEN during hole-2 (11-21 12:00 .. 11-23 20:00): ${inHole2.length} ---`);
for (const line of inHole2.slice(0, 40)) console.log("  " + line);
console.log("mtime scan done");
