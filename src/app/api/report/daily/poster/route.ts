import { NextResponse } from "next/server";
import { buildDailyDigest } from "@/lib/dailyReport";
import { renderDailyPosterMinimal } from "@/lib/daily-poster-minimal";
import { sendPhotoDirect } from "@/lib/notify";

export const dynamic = "force-dynamic";

function tehranStamp(): string {
  return `${new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(",", "")} TEHRAN`;
}

/** GET /api/report/daily/poster — render the MINIMAL / DATA-DRIVEN poster
 * design variant. Without params → image/jpeg bytes (design review).
 * ?send=1 → pushes the JPG to the operator chat via the design-preview
 * channel — deliberately OUTSIDE the once-per-day report dedup guard, so
 * artwork iterations never consume the 00:00 Tehran report slot. */
export async function GET(req: Request) {
  const send = new URL(req.url).searchParams.get("send") === "1";
  try {
    const digest = await buildDailyDigest();
    const jpg = await renderDailyPosterMinimal({ digest, ts: tehranStamp() });

    if (!send) {
      return new NextResponse(new Uint8Array(jpg), {
        headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
      });
    }

    const caption = [
      "🖼 <b>DESIGN PREVIEW — MINIMAL / DATA-DRIVEN</b>",
      "",
      "مدل مینیمال دیتامحور برای گزارش روزانه — تایپوگرافی بزرگ، جدول معاملات با لوگوی واقعی ارزها، گاو خشمگین 🐂 برای تی‌پی و خرس خشمگین 🐻 برای استاپ.",
      "",
      "<i>اعداد واقعی موتور زنده — نمونهٔ طراحی، گزارش رسمی امروز جداگانه می‌آید.</i>",
    ].join("\n");
    const r = await sendPhotoDirect(caption, jpg, "DAILY-MINIMAL.jpg");
    return NextResponse.json({ ok: r.ok, error: r.error, bytes: jpg.length, digest }, { status: r.ok ? 200 : 502 });
  } catch (err) {
    console.error("[report/daily/poster] render error", err);
    return NextResponse.json({ error: "minimal poster render failed" }, { status: 500 });
  }
}
