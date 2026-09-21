import { db } from "../src/lib/db";
const row = await db.engineSetting.findUnique({ where: { key: "governor.log" } });
if (row) {
  const log = JSON.parse(row.value) as Array<{ at: string; label: string; decisions: Array<{ action: string; value?: number; rationale: string; applied: boolean }> }>;
  const last = log[0];
  console.log("LAST CYCLE:", last?.at, last?.label);
  for (const d of last?.decisions ?? []) console.log(` ${d.applied ? "APPLIED" : "rejected"} ${d.action}${d.value !== undefined ? ` → ${d.value}` : ""}\n   · ${d.rationale.slice(0, 260)}`);
}
const gate = await db.engineSetting.findUnique({ where: { key: "gate" } });
console.log("\nGATE:", gate?.value);
process.exit(0);
