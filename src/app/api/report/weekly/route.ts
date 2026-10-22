// ── v10.20 WEEKLY PERFORMANCE REPORT (operator mandate: P1 upgrade) ────────
// Mirror of /api/report/daily for the Iranian week (Sat→Fri): violet weekly
// poster (renderWeeklyPoster) + 7-day digest caption through the SAME honest
// pipeline (buildWeeklyDigest → buildDigest(7×24h)). Hard invariant: AT MOST
// ONE SUCCESSFUL SEND PER IRANIAN WEEK (tehranWeekKey guard) — neutralizes
// cron misfires exactly like the daily route; failed sends never count.

import { NextResponse } from "next/server";
import { buildWeeklyDigest, composeDailyCaption, markWeeklySent, lastWeeklySentAt, lastWeeklySuccessfulSentAt, tehranWeekKey, type DailyDigest } from "@/lib/dailyReport";
import { sendDailyReport } from "@/lib/notify";
import { renderWeeklyPoster } from "@/lib/telegram-art";

export const dynamic = "force-dynamic";

function tehranStamp(): string {
  return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "")} TEHRAN`;
}

/** Poster render with honest fallback — a sharp failure must never block the
 * report (the send path degrades to plain text, numbers still land). */
async function renderPoster(digest: DailyDigest): Promise<Buffer | null> {
  try {
    return await renderWeeklyPoster({ digest, ts: tehranStamp() });
  } catch (err) {
    console.error("[report/weekly] poster render failed — falling back", err);
    return null;
  }
}

/** GET /api/report/weekly — preview the compiled 7-day digest WITHOUT sending. */
export async function GET() {
  try {
    const [digest, lastAt] = await Promise.all([buildWeeklyDigest(), lastWeeklySentAt()]);
    return NextResponse.json(
      {
        digest,
        caption: composeDailyCaption(digest, undefined, "WEEKLY"),
        lastSentAt: lastAt,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[report/weekly] preview error", err);
    return NextResponse.json({ error: "weekly digest compilation failed" }, { status: 500 });
  }
}

/** POST /api/report/weekly — compile + send to Telegram (violet weekly poster
 * + 7-day caption). Max 1 successful send per Iranian week (Sat→Fri). */
export async function POST(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const lastOk = await lastWeeklySuccessfulSentAt();
    const alreadyThisWeek = lastOk !== null && tehranWeekKey(lastOk) === tehranWeekKey(Date.now());
    if (alreadyThisWeek) {
      const digest = await buildWeeklyDigest();
      return NextResponse.json(
        { ok: false, deduped: true, forceBlocked: force || undefined, lastSentAt: lastOk, detail: "weekly report already delivered this Iranian week (Sat→Fri) — max 1 send/week anti-spam guard applies to force=1 too", digest },
        { status: 200 }
      );
    }
    const digest = await buildWeeklyDigest();
    const caption = composeDailyCaption(digest, undefined, "WEEKLY");
    const poster = await renderPoster(digest);
    const r = await sendDailyReport(caption, poster, "WEEKLY.png");
    await markWeeklySent(r.ok);
    return NextResponse.json({ ok: r.ok, error: r.error, withPhoto: r.withPhoto, digest, caption }, { status: r.ok ? 200 : 502 });
  } catch (err) {
    console.error("[report/weekly] send error", err);
    return NextResponse.json({ error: "weekly report send failed" }, { status: 500 });
  }
}
