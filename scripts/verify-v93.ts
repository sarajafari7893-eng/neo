/* v9.3 package verification — lesson gate, chop ladder, auto-promotion (read-only) */
import { db } from "../src/lib/db";
import { lessonThrAdj } from "../src/lib/lesson-gate";
import { maybeAutoPromote, getShadowVetoConfig } from "../src/lib/shadow-veto";
import { regimeRuling, type MarketRegime } from "../src/lib/regime";

async function main() {
  // 1) lesson gate — what does the deep-learn ring currently inject?
  const lesson = await lessonThrAdj();
  console.log("[1] LESSON-GATE adj:", lesson.adj, "· applied:", lesson.applied, "· note:", lesson.note);

  // 2) chop ladder — guard L1 must now veto BREAKOUT in ANY chop (not only strong)
  const chop: MarketRegime = {
    symbol: "TESTUSDT",
    regime: "CHOP",
    strength: 0.35, // deliberately WEAK chop — old ladder would NOT veto
    note: "v93 test — weak chop",
    trendPct: 0.2,
    efficiency: 0.1,
    volPctile: 0.4,
  } as unknown as MarketRegime;
  const bo = regimeRuling(chop, "LONG", "BREAKOUT", 1);
  const mr = regimeRuling(chop, "LONG", "MEAN-REVERT", 1);
  const strongChop = { ...chop, strength: 0.7 } as MarketRegime;
  const mrStrong = regimeRuling(strongChop, "LONG", "AI-SCALP", 1);
  console.log("[2] CHOP L1 BREAKOUT weak-chop → ok:", bo.ok, "|", (bo.reason ?? "").slice(0, 90));
  console.log("    CHOP L1 MEAN-REVERT weak-chop → ok:", mr.ok, "thrAdj:", mr.thrAdj);
  console.log("    CHOP L1 AI-SCALP strong-chop → ok:", mrStrong.ok, "thrAdj:", mrStrong.thrAdj);

  // 3) auto-promotion — must report evidence-not-ready (criteria unchanged)
  const cfg = await getShadowVetoConfig(true);
  console.log("[3] shadowveto config autoPromote:", cfg.autoPromote, "· mode:", cfg.mode);
  const promo = await maybeAutoPromote();
  console.log("    maybeAutoPromote → promoted:", promo.promoted, "·", promo.detail.slice(0, 140));
  const after = await getShadowVetoConfig(true);
  console.log("    mode after check:", after.mode);

  await db.$disconnect();
}
main().catch((e) => {
  console.error("VERIFY FAILED:", e);
  process.exit(1);
});
