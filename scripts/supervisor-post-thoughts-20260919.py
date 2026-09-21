#!/usr/bin/env python3
"""SUPERVISOR deep-audit 2026-09-19T03:00Z — post structured thoughts to terminal."""
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
        "thought": "Issuance drought is now TRIPLE-cause, not barrier-only: (1) vol-scaled barrier t1r cap (recent blocks 484-1280m vs 240m cap), (2) ER-floor rejections, and (3) NEW at 02:52Z — memory gate profit-first suppression of AI-SWING engine-wide on WLD/SUI/FIL/APT (realized expectancy -5.4%/trade, n=30 EPOCH-2 rolling, floor -2%). Issuance stall hit 92min (last serial 555 at 01:20:22Z), cadence decayed B->C->D. The E-20260919 evidence-completion mandate (552/576, +24 needed) is now gate-limited, not market-limited: the binding constraint is the engine's own protective layers reacting to a negative-expectancy regime, and they compound multiplicatively.",
        "evidence": {
            "stallMin": 92,
            "cadence": "D",
            "settledN": 552,
            "needed": 24,
            "memoryGate": "AI-SWING suppressed -5.4%/trade n=30 on 4+ symbols",
            "recentT1rBlocks": [1280, 484, 895, 1120],
            "sinceArmRatePerH": 1.17,
        },
    },
    {
        "agent": "SUPERVISOR",
        "phase": "diagnose",
        "thought": "Root cause of the gate over-reaction is the gate STATISTIC, not the gate concept: the profit-first memory gate uses raw mean %-expectancy over a rolling-30 window. Mean percent is (a) not risk-normalized (trades with 2xATR SL at different vol regimes are not comparable), (b) outlier-sensitive (a few large SL losses drag the mean, e.g. GUSDT -61.2% single trade), (c) has no sample-size discount at n=30 where the standard error of the mean is ~std/sqrt(30) ~ 18% of std — the -5.4% reading may be statistically indistinguishable from zero edge. Cohort evidence confirms the divergence pattern: paper-keep 30/30 settled at 53.3% WR but net -$5.31 (win-rate high, expectancy negative), real-veto cohort net +$1.33 POSITIVE (veto model not yet validated: all 5 promotion criteria unmet, seq-stop z=-0.63 CONTINUE). Percent-WR and mean-% statistics keep producing contradictory signals across layers.",
        "evidence": {
            "paperKeep": "30/30, WR 53.3%, net -5.31 USD",
            "realVeto": "22/30, WR 43.5%, net +1.33 USD",
            "promotion": "all criteria unmet, seq z=-0.63 CONTINUE",
            "gateStatistic": "mean pct-expectancy n=30 rolling, floor -2%",
        },
    },
    {
        "agent": "SUPERVISOR",
        "phase": "propose",
        "thought": "HIGHEST-LEVERAGE PROPOSAL (extends approved Phase 3+4, zero knob change without APPROVE): upgrade the memory-gate statistic from mean %-expectancy to an R-multiple SQN-style score — expectancy(R)/std(R) x sqrt(N), optional 10% trimmed mean — and instrument its opportunity cost BEFORE deciding: extend the approved BARRIER-NEAR-MISS paper queue to also capture GATE-NEAR-MISS candidates (memory-gate-suppressed but otherwise-passing setups) with counterfactual R. Rationale: (a) SQN (Van Tharp) jointly prices expectancy, consistency and sample size — robust to the heavy-tail SL losses that distort the current mean; (b) meta-labeling doctrine (Lopez de Prado; Hudson & Thames) requires the FILTER itself to be evidence-validated, else it degrades the primary signal's Sharpe by false-positive suppression; (c) small-sample mean-R is documented unreliable without sqrt(N) sizing. Decision rule: if GATE-NEAR-MISS paper cohort over >=30 settles shows negative counterfactual expectancy, the -2% floor is vindicated (keep gate); if positive, file an advisor KNOB_ADJUST with SQN-based statistic + evidence. Implementation stays on the approved advisor path; I execute nothing directly.",
        "evidence": {
            "proposal": "SQN-style R-normalized memory gate + GATE-NEAR-MISS paper capture",
            "decisionRule": "30-settle paper cohort counterfactual expectancy decides",
            "webValidation": [
                "Van Tharp SQN = expectancy_R/std_R x sqrt(N)",
                "Lopez de Prado meta-labeling filter validation",
                "small-sample mean-R unreliability",
            ],
            "policy": "no knob/DB/EngineSetting change without operator APPROVE",
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
    print("POSTED", t["phase"], "->", json.dumps(body)[:120])
