import { NextResponse } from "next/server";
import { getShadowVetoState, saveShadowVetoConfig, resetShadowEvidence } from "@/lib/shadow-veto";
import { llmHealth } from "@/lib/ai";
import type { ShadowVetoDTO, ShadowVetoModeDTO } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const MODE_COOLDOWN_MS = 45_000;
let lastModeChangeAt = 0;
let lastPromotionNotifiedReady = false;

/**
 * GET /api/ai/shadow-veto — AI-core Phase 0 feed (operator: «قدم بعدی پیشنهادی
 * رو کامل و مهندسی انجام بده»). Serves the shadow adjudicator state: mode +
 * fence window + budget, the outcome-tracked A/B arms (real-keep / real-veto /
 * paper-keep / paper-veto) with Wilson-LB95, the promotion/revocation evidence,
 * recent adjudications and the paper (would-have-won) ledger.
 * v10.2: arm feed wiring / pipeline leaks / durable-JSON status live on the
 * dedicated SV-TELEMETRY channel — /api/ai/shadow-veto/telemetry (single
 * canonical wiring source; the card double-polls both).
 */
export async function GET() {
  try {
    const s = await getShadowVetoState();
    const payload: ShadowVetoDTO = {
      ts: Date.now(),
      config: s.config,
      armEpoch: s.armEpoch,
      stats: s.stats,
      arms: s.arms,
      armsLive: s.armsLive, // v10.11 COHORT-FREEZE — unfrozen live view (monitoring-only)
      cohortFreeze: s.cohortFreeze, // v10.11 — decision-grade snapshot pointer
      promotion: s.promotion,
      patternVeto: s.patternVeto, // v11.0 — the proven-performance filter's live evidence
      recent: s.recent,
      paper: s.paper,
      health: s.health,
      llm: llmHealth(),
    };
    // one-time Telegram ping when the evidence gate first reports READY
    if (s.promotion.ready && !lastPromotionNotifiedReady) {
      lastPromotionNotifiedReady = true;
      void import("@/lib/notify")
        .then((m) => m.sendDirect("SHADOW-VETO: promotion evidence READY — ≥30 settled per arm with Wilson-LB separation. The AI core may now be promoted to live veto power via /api/ai/shadow-veto (mode=veto)."))
        .catch(() => undefined);
    } else if (!s.promotion.ready) {
      lastPromotionNotifiedReady = false;
    }
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[shadow-veto] GET error", err);
    return NextResponse.json({ error: "shadow-veto state failure" }, { status: 500 });
  }
}

/**
 * POST /api/ai/shadow-veto — operator control: {mode, force?, reset?, budgetPerHour?, minSpacingMs?}.
 * mode=veto is EVIDENCE-GATED: refused with the failing criteria unless
 * force:1 (operator override is supreme but audited). 45s cooldown on mode
 * flips prevents control churn. budgetPerHour/minSpacingMs are the v8.4.1
 * neural-stability knobs (N1): clamp-guarded, audited, applied without a mode flip.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { mode?: string; force?: boolean; reset?: boolean; budgetPerHour?: number; minSpacingMs?: number };

    if (body.reset) {
      await resetShadowEvidence();
      await import("@/lib/engine")
        .then((m) => m.fireEvent(null, null, "ENGINE", "info", "SHADOW-VETO: operator reset — evidence arms + paper ledger wiped, config kept. Adjudication restarts from zero."))
        .catch(() => undefined);
      return NextResponse.json({ ok: true, reset: true });
    }

    // v8.4.1 N1 — neural-stability budget patch (no mode flip needed)
    const budget = Number(body.budgetPerHour);
    const spacing = Number(body.minSpacingMs);
    if (Number.isFinite(budget) || Number.isFinite(spacing)) {
      const patch: Record<string, number> = {};
      if (Number.isFinite(budget)) patch.budgetPerHour = Math.max(2, Math.min(40, Math.round(budget)));
      if (Number.isFinite(spacing)) patch.minSpacingMs = Math.max(30_000, Math.min(600_000, Math.round(spacing)));
      const cfg = await saveShadowVetoConfig(patch);
      await import("@/lib/engine")
        .then((m) => m.fireEvent(null, null, "ENGINE", "info", `SHADOW-VETO budget → ${cfg.budgetPerHour}/h · spacing ≥${Math.round(cfg.minSpacingMs / 1000)}s (N1 neural-stability patch, audited)`))
        .catch(() => undefined);
      return NextResponse.json({ ok: true, config: cfg });
    }

    if (body.mode) {
      const mode = body.mode as ShadowVetoModeDTO;
      if (!["off", "shadow", "veto"].includes(mode)) {
        return NextResponse.json({ ok: false, error: "mode must be off | shadow | veto" }, { status: 400 });
      }
      if (Date.now() - lastModeChangeAt < MODE_COOLDOWN_MS) {
        return NextResponse.json({ ok: false, error: "mode-change cooldown (45s) — control churn guard" }, { status: 429 });
      }
      const s = await getShadowVetoState();
      if (mode === "veto" && !s.promotion.ready && !body.force) {
        return NextResponse.json(
          {
            ok: false,
            error: "veto mode is EVIDENCE-GATED — promotion criteria not met yet",
            promotion: s.promotion,
            hint: "review the failing criteria on the SHADOW-VETO card; operator force=true overrides (audited)",
          },
          { status: 409 },
        );
      }
      const cfg = await saveShadowVetoConfig({ mode });
      lastModeChangeAt = Date.now();
      await import("@/lib/engine")
        .then((m) =>
          m.fireEvent(
            null,
            null,
            "ENGINE",
            mode === "veto" ? "warn" : "info",
            `SHADOW-VETO mode → ${mode.toUpperCase()}${mode === "veto" ? (body.force && !s.promotion.ready ? " (OPERATOR FORCE — evidence gate overridden, audited)" : " (evidence gate passed)") : ""} — ${mode === "off" ? "adjudicator off" : mode === "shadow" ? "verdicts recorded, live flow untouched (fail-open)" : "veto-only authority ACTIVE at the fence; blocked trades paper-tracked for revocation"}`,
          ),
        )
        .catch(() => undefined);
      return NextResponse.json({ ok: true, mode: cfg.mode });
    }

    return NextResponse.json({ ok: false, error: "nothing to do — send {mode} or {reset:true}" }, { status: 400 });
  } catch (err) {
    console.error("[shadow-veto] POST error", err);
    return NextResponse.json({ ok: false, error: "shadow-veto control failure" }, { status: 500 });
  }
}
