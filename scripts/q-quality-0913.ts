// one-off: force a quality journal write + verify persistence (v9.3 wiring check)
import { recordRawcalQuality, readPersistedQuality, r6GateLine } from "../src/lib/rawcal-quality";

const d = await recordRawcalQuality();
if (!d) {
  console.log("recordRawcalQuality → null (throttled or failed)");
  process.exit(1);
}
console.log("FORCE-WROTE quality digest:");
console.log(" ", r6GateLine(d));
const p = await readPersistedQuality();
console.log("readPersistedQuality →", p ? `key rawcal.quality OK (gate ${p.gate.verdict}, settled ${p.settledRaw}, snapshotPct ${p.snapshotPct})` : "MISSING");
process.exit(0);
