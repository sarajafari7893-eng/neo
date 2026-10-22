// ONE-SHOT MAINTENANCE CLI — v10.17 P1-3: manually drain the SignalEvent
// ENGINE-chatter archive NOW (bypasses the 24h gate; the engine rail keeps
// self-throttling on its own schedule). Never throws — result JSON on stdout.
//   bun scripts/archive-events.ts              → force run, batch 1000
//   bun scripts/archive-events.ts --gate       → honor the 24h gate (gate probe)
//   bun scripts/archive-events.ts --batch 400  → override batch size
import { maybeArchiveEvents, type ArchiveResult } from "../src/lib/maintenance";

const argv = process.argv.slice(2);
const force = !argv.includes("--gate");
const batchIdx = argv.indexOf("--batch");
const batchRaw = batchIdx >= 0 ? Number(argv[batchIdx + 1]) : 1000;
const batch = Number.isFinite(batchRaw) && batchRaw > 0 ? Math.floor(batchRaw) : 1000;

const result: ArchiveResult = await maybeArchiveEvents({ force, batch });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
