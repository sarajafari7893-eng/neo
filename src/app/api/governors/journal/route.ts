import { NextResponse } from "next/server";
import { getFourPackDoc } from "@/lib/fourpack-journal";

export const dynamic = "force-dynamic";

/** GET /api/governors/journal — v10.8 FOUR-PACK JSON JOURNAL DOCTRINE
 * (operator mandate: «گزارش جیسون جورنال دکترین» — a retrievable, auditable
 * JSON document for the whole GOVERNOR MODULES FOUR-PACK).
 *  · ?limit=N     → tail N events (default 500, cap 5000)
 *  · ?download=1  → Content-Disposition attachment with a dated filename
 * The same content also persists on disk: .data/fourpack-journal.jsonl
 * (append-only, rotates to .old at 6MB) + .data/fourpack-latest.json. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? "500") || 500));
  const doc = await getFourPackDoc(limit);
  if (url.searchParams.get("download") === "1") {
    const date = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(doc, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="fourpack-journal-${date}.json"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json(doc);
}
