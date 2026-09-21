import { NextResponse } from "next/server";
import { getCalibration } from "@/lib/calibration";

export const dynamic = "force-dynamic";

/** GET /api/ai/calibration — factor-weight learning state (OBSERVING → ACTIVE) */
export async function GET() {
  const state = await getCalibration();
  return NextResponse.json({ calibration: state });
}
