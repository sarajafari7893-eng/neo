// v8.4.1 N3 — NEURAL LINK health + ACTIVE recovery probe (operator mandate
// «هوش غیرفعال شده رو فعال و پایدار کن»): GET returns the live shield state;
// POST fires one minimal LLM probe THROUGH the cooldown — success resets the
// 429 shield instantly so MODEL verdicts (shadow adjudication, governor,
// analyst chat) resume without waiting for the next natural call. Probe is
// rate-limited to 1 per 2min inside ai.ts; every result is audited.
import { NextResponse } from "next/server";
import { llmHealth, probeNeuralLink } from "@/lib/ai";
import { fireEvent } from "@/lib/engine";

export async function GET() {
  return NextResponse.json({ ts: Date.now(), health: llmHealth() });
}

export async function POST() {
  const r = await probeNeuralLink();
  if (r.ok) {
    await fireEvent(null, null, "ENGINE", "info", "NEURAL PROBE OK — LLM link restored, 429 shield reset (streak cleared); MODEL verdicts resume automatically. (manual probe)").catch(() => undefined);
  }
  return NextResponse.json({ ts: Date.now(), ...r });
}
