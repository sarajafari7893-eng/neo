import { NextResponse } from "next/server";
import { buildDailyDigest, composeDailyCaption, markDailySent, lastDailySentAt, lastSuccessfulSentAt, tehranDayKey, type DailyDigest } from "@/lib/dailyReport";
import { sendDailyReport, loadDailyArt } from "@/lib/notify";
import { renderDailyPoster } from "@/lib/telegram-art";
import { advisorCaptionBlock } from "@/lib/advisor";
import { maybeRunSeniorReview } from "@/lib/senior-review";

export const dynamic = "force-dynamic";

function tehranStamp(): string {
  return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "")} TEHRAN`;
}

/** v8.1 poster render with honest fallback — a sharp failure must never block
 * the report; sendDailyReport falls back to DAILY.jpg / plain text. */
async function renderPoster(digest: DailyDigest): Promise<Buffer | null> {
  try {
    return await renderDailyPoster({ digest, ts: tehranStamp() });
  } catch (err) {
    console.error("[report/daily] poster render failed — falling back", err);
    return null;
  }
}

/** GET /api/report/daily — preview the compiled digest WITHOUT sending. */
export async function GET() {
  try {
    const [digest, art, lastAt, advisorBlock] = await Promise.all([buildDailyDigest(), loadDailyArt(), lastDailySentAt(), advisorCaptionBlock()]);
    return NextResponse.json(
      {
        digest,
        caption: composeDailyCaption(digest, advisorBlock || undefined),
        advisorBlock: advisorBlock || undefined,
        artworkLoaded: Boolean(art),
        artworkBytes: art?.length ?? 0,
        lastSentAt: lastAt,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[report/daily] preview error", err);
    return NextResponse.json({ error: "digest compilation failed" }, { status: 500 });
  }
}

/** POST /api/report/daily — compile + send to Telegram (photo DAILY.jpg + caption).
 * Hard invariant: AT MOST ONE SUCCESSFUL SEND PER TEHRAN CALENDAR DAY — applies
 * to force=1 too. This neutralizes cron-schedule misfires (e.g. a job firing
 * hourly instead of daily) at the route level regardless of who calls it.
 * Failed deliveries are never counted (markDailySent stores ok flag), so a
 * failed send can always be retried the same day. The legitimate 00:00 Tehran
 * send always starts a fresh Tehran day → never blocked. */
export async function POST(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const lastOk = await lastSuccessfulSentAt();
    const alreadyToday = lastOk !== null && tehranDayKey(lastOk) === tehranDayKey(Date.now());
    if (alreadyToday) {
      const digest = await buildDailyDigest();
      return NextResponse.json(
        { ok: false, deduped: true, forceBlocked: force || undefined, lastSentAt: lastOk, detail: "daily report already delivered today (Tehran) — max 1 send/day anti-spam guard applies to force=1 too; the next scheduled 00:00 Tehran send is unaffected", digest },
        { status: 200 }
      );
    }
    const [digest, advisorBlock] = await Promise.all([buildDailyDigest(), advisorCaptionBlock()]);
    const caption = composeDailyCaption(digest, advisorBlock || undefined);
    const poster = await renderPoster(digest);
    const r = await sendDailyReport(caption, poster);
    await markDailySent(r.ok);
    // v10.0 R6 DAILY SENIOR-REVIEW — the nightly agent's PRIMARY trigger: right
    // after a successful 00:00 Tehran report. Fire-and-forget (self-guarded to
    // once per Tehran day inside the module); a review failure never unsets the
    // report's ok status.
    if (r.ok) {
      void maybeRunSeniorReview().catch((e) => console.error("[report/daily] senior-review failed", e));
    }
    return NextResponse.json({ ok: r.ok, error: r.error, withPhoto: r.withPhoto, digest, caption }, { status: r.ok ? 200 : 502 });
  } catch (err) {
    console.error("[report/daily] send error", err);
    return NextResponse.json({ error: "daily report send failed" }, { status: 500 });
  }
}
