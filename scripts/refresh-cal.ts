import { refreshCalibration } from "../src/lib/calibration";
const { state, auditLine } = await refreshCalibration();
console.log("status:", state.status, "criterion:", state.criterion);
for (const r of state.rows) console.log(`${r.factor}: w=${r.weight} avgPct=${r.avgPct} pnlUsd=${r.pnlUsd} n=${r.n} wr=${r.winRate}`);
console.log("audit:", auditLine);
process.exit(0);
