#!/usr/bin/env python3
"""SUPERVISOR 06:51Z cycle — post 2 structured thoughts to NEXUS terminal."""
import json
import urllib.request

URL = "http://localhost:3000/api/terminal"

# (task 4-b) control gate: mutating app APIs require x-nexus-key (audit P0-1).
# Key is read from env or .env — never printed.
import os as _os, re as _re
def _nexus_key():
    k = _os.environ.get("NEXUS_CONTROL_KEY")
    if k:
        return k
    try:
        m = _re.search(r'^NEXUS_CONTROL_KEY=(.*)$', open("/home/z/my-project/.env").read(), _re.M)
        return m.group(1).strip().strip('"').strip("'") if m else ""
    except Exception:
        return ""

HEADERS = {"content-type": "application/json", "x-nexus-key": _nexus_key()}

THOUGHTS = [
    {
        "agent": "SUPERVISOR",
        "phase": "diagnose",
        "thought": "Counterfactual inversion in shadow-veto: the AI veto layer is currently removing value, not adding it. The would-veto cohort (core TRADE, AI VETO, shadow-settled) is 24/30, WR 50%, net +$1.46 — promotion requires this cohort net NEGATIVE, so the veto arm is failing its own thesis. Meanwhile the agreement cohort (both layers say TRADE) is paper-losing: paper-keep 26, WR 34.6%, net -$4.75, while the same selection rule in real execution is +$0.46 (n=14) — a paper-vs-real divergence on identical rules pointing to paper sim pessimism (fee/slippage modeling) or small-n noise. gateAgreement 61%. All 5 promotion criteria unmet, seq-stop CONTINUE. Interpretation: in the current low-vol regime the AI layer is anti-correlated with realized outcomes — it suppresses compression setups that later expand. n is still small; no action proposed on the veto layer itself, but the rolling-30 evidence is trending AGAINST promotion and the operator should see this before any veto hardening decision.",
        "evidence": {
            "realVeto": "24/30, WR 50.0%, net +1.46 USD (promotion needs net negative)",
            "paperKeep": "26/30, WR 34.6%, net -4.75 USD (agreement cohort loses in paper)",
            "realKeep": "14/30, WR 35.7%, net +0.46 USD (same rule as paper-keep, opposite sign)",
            "gateAgreement": 61,
            "promotion": "0/5 criteria met, seq-stop z CONTINUE",
            "regime": "low-vol compression — vol-barrier t1r blocks 724-4932m vs 240m cap"
        },
    },
    {
        "agent": "SUPERVISOR",
        "phase": "propose",
        "thought": "Highest-leverage improvement: replace the FIXED 240m vertical-barrier time cap with a REGIME-ADAPTIVE cap. Both issuance droughts (139min Sep 19 00:11Z-context, 141min 03:39-06:00Z) had the identical signature: sweep healthy (best score 68 vs MIN_SCORE 35), 100% of blocks = vol-scaled barrier t1r 724-4932m vs the 240m cap — i.e., in compression regimes the barrier math says 'slow' and the cap kills every candidate. The best cohort trade (GUSDT BREAKOUT TP3 +95.2%) is exactly a compression-expansion capture; blocking compression candidates removes the highest-R setups. Literature check: Lopez de Prado's triple-barrier vertical barrier is widely critiqued as a fixed-time constant (quant.stackexchange 'flexible horizon'; insiderfinance critique) and practitioners set it from holding-time distribution percentiles, not absolutes; volatility-compression precedes expansion (Bookmap, WallStreetMojo). Concrete mechanism (paper-first): volPctile = realized-vol percentile of the symbol (30d); cap_m = 240 if volPctile >= 30 else clamp(240 * (1 + 2*(30-volPctile)/30), 240, 720). Gate it with a BARRIER-CAP-NEAR-MISS paper queue: every candidate rejected ONLY by the time cap gets a shadow counterfactual settle so the widening pays for itself with evidence. No knob/EngineSetting change without operator APPROVE — this extends the pending SQN memory-gate + GATE-NEAR-MISS proposal set (Telegram msg 3920) as a complementary third item.",
        "evidence": {
            "drought1": "139min, blocks 100% vol-barrier t1r (BNB 3186m, APT 724-858m, ETH 2971m vs cap 240m)",
            "drought2": "141min, blocks 100% vol-barrier t1r (XRP up to 4932m, PUMP 1169-1240m vs cap 240m)",
            "sweepHealth": "best score 68 vs sweep MIN_SCORE 35 — candidates exist, only the cap blocks",
            "bestCohortTrade": "GUSDT BREAKOUT TP3 +95.2% (compression-expansion capture)",
            "mechanism": "cap_m = 240m if volPctile >= 30 else clamp(240*(1+2*(30-volPctile)/30), 240, 720)",
            "validation": "triple-barrier vertical barrier: flexible/percentile-based horizon preferred over fixed (quant.stackexchange, insiderfinance); compression precedes expansion (Bookmap, WallStreetMojo)",
            "policy": "paper counterfactual queue first; operator APPROVE required for any change"
        },
    },
]

for t in THOUGHTS:
    req = urllib.request.Request(
        URL,
        data=json.dumps(t).encode("utf-8"),
        headers=HEADERS,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        body = json.loads(r.read().decode())
        print(t["phase"], "->", json.dumps(body)[:120])
