// ── v10.20 RAW-CAL RUN HEARTBEAT (engine-native) ───────────────────────────
// M4 mission finding SENTINEL-20260921-M4 #6: the RAWCAL run heartbeat
// (.data/rawcal-run-heartbeat.txt) was historically written by an external
// 2h cron that died 2026-09-19T11:33Z — the sentinel kept reading a stale
// "heartbeatAgeH" for a system that was in fact alive-but-idle (disarmed by
// design at target). This module makes the ENGINE itself the heartbeat
// writer: maybeRawCalDeploy() runs every 10 ticks (always alive while Next
// runs), so the heartbeat now reflects the true run-loop state:
//   · ARMED  — capture mode issuing (state carries issued/target)
//   · IDLE   — disarmed by policy (the honest "alive, not dead" signal)
//   · ISSUE  — a raw record was just issued (state change → always written)
//   · ARMED/…— arm/disarm transitions (always written)
// Format stays sentinel-compatible: each line begins with the minute-precision
// UTC stamp the sentinel parses (`YYYY-MM-DDTHHMMZ`), state detail follows.
// Failure contract: best-effort telemetry — never throws, never blocks a tick.
import { promises as fs } from "fs";
import path from "path";

const HB_FILE = path.join(process.cwd(), ".data", "rawcal-run-heartbeat.txt");
const SAME_STATE_THROTTLE_MS = 30 * 60_000; // idle/armed steady-state: 1 line / 30min
const MAX_LINES = 200; // bounded file — ~4 days of steady-state history

let lastState = "";
let lastWriteAt = 0;
let chain: Promise<void> = Promise.resolve(); // serialize read-modify-write

const p2 = (n: number) => String(n).padStart(2, "0");

function stamp(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}Z`;
}

async function writeHeartbeat(state: string): Promise<void> {
  const now = Date.now();
  const line = `${stamp(new Date(now))} ${state}`;
  if (line === lastState && now - lastWriteAt < SAME_STATE_THROTTLE_MS) return; // steady-state throttle
  const txt = await fs.readFile(HB_FILE, "utf8").catch(() => "");
  const lines = txt.trim().split("\n").filter(Boolean);
  lines.push(line);
  const keep = lines.slice(-MAX_LINES).join("\n") + "\n";
  await fs.mkdir(path.dirname(HB_FILE), { recursive: true });
  await fs.writeFile(HB_FILE, keep, "utf8");
  lastState = line;
  lastWriteAt = now;
}

/** Fire-and-forget heartbeat touch — call from the engine tick path & state transitions. */
export function touchRawcalHeartbeat(state: string): void {
  const trimmed = state.slice(0, 110);
  chain = chain
    .then(() => writeHeartbeat(trimmed))
    .catch(() => undefined); // telemetry is best-effort — never block the caller
}
