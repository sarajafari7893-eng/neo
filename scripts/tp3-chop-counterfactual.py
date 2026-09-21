#!/usr/bin/env python3
"""TP3-CHOP counterfactual lab (read-only) — operator proposal 2026-09-14:
«حذف TP3 فقط در رژیم CHOP، نگه داشتن رانر در TREND»

Model = the engine's own v6.6 tranche accounting inverted exactly:
  pnlPercent(DB, margin-relative NET) = [0.5*p1 + 0.3*p2 + 0.2*runner] * lev
                                        - feePct(lev, minutes)
  => runnerMove(UNLEVERED %) recovered per settled row with reachedTp>=2.
Cap-at-TP2 variant (CHOP only): runner 20% closes at the TP2 rung instead of
its realized final exit. Delta = margin*0.2*(p2 - runnerMove)/100 (runner leg
only — fees symmetric across arms, same convention as research-shadow).
TREND cohort: runner realized move reported (evidence for keeping it there).
"""
import sqlite3

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
TAKER = 0.0005 * 2          # round-trip taker
FUND8H = 0.0001             # per-8h funding baseline

con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row

rows = con.execute("""
    SELECT serial, symbol, direction, status, reachedTp, pnlPercent, marginUsd,
           leverage, entryPrice, tp1, tp2, tp3, stopLoss, tags,
           createdAt, closedAt
    FROM Signal
    WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED')
      AND tags LIKE '%EPOCH-2%' AND tags LIKE '%REGIME-%'
""").fetchall()

def regime(tags):
    for t in (tags or "").split(","):
        if t.startswith("REGIME-"):
            return t
    return "NONE"

def grp(r):
    g = regime(r["tags"])
    return "CHOP" if g == "REGIME-CHOP" else ("TREND" if g in ("REGIME-TREND-UP", "REGIME-TREND-DOWN") else g.replace("REGIME-", ""))

def pct_at(px, r):
    d = 1 if r["direction"] == "LONG" else -1
    return ((px - r["entryPrice"]) / r["entryPrice"]) * d * 100

out = {}
for g in ("CHOP", "TREND", "VOLATILE"):
    out[g] = dict(n=0, tp3=0, tp2hit=0, runner_usd=0.0, capped_usd=0.0, rows=[])

for r in rows:
    g = grp(r)
    if g not in out:
        continue
    o = out[g]
    o["n"] += 1
    if r["status"] == "TP3":
        o["tp3"] += 1
    if (r["reachedTp"] or 0) >= 2:
        o["tp2hit"] += 1
        lev = r["leverage"] or 1
        mins = max(1, (r["closedAt"] - r["createdAt"]) / 60000)
        fee_pct = (TAKER + FUND8H * mins / 480) * lev * 100  # margin-relative fee %
        p1, p2 = pct_at(r["tp1"], r), pct_at(r["tp2"], r)
        gross_margin_pct = (r["pnlPercent"] or 0) + fee_pct          # = finalMove*lev
        runner = ((gross_margin_pct / lev) - 0.5 * p1 - 0.3 * p2) / 0.2
        m = r["marginUsd"] or 0
        live_r = m * 0.2 * runner / 100
        cap_r = m * 0.2 * p2 / 100
        o["runner_usd"] += live_r
        o["capped_usd"] += cap_r
        o["rows"].append((r["serial"], r["symbol"], r["status"], round(runner, 2), round(p2, 2), round(cap_r - live_r, 3)))

print(f"book: {len(rows)} settled EPOCH-2 with regime tag")
print(f"{'cohort':10} {'n':>4} {'TP3hit':>6} {'TP2hit':>6} {'runner$':>9} {'capTP2$':>9} {'delta$':>8}")
for g, o in out.items():
    print(f"{g:10} {o['n']:>4} {o['tp3']:>6} {o['tp2hit']:>6} {o['runner_usd']:>9.2f} {o['capped_usd']:>9.2f} {o['capped_usd']-o['runner_usd']:>8.2f}")

ch = out["CHOP"]
if ch["rows"]:
    print("\n-- CHOP TP2-hit trades: runner realized vs TP2-cap (delta>0 = cap wins) --")
    gave_back = [r for r in ch["rows"] if r[4] > r[3]]
    for r in sorted(ch["rows"], key=lambda x: -x[5])[:12]:
        print(f"  NX-{r[0]:04d} {r[1]:12} {r[2]:8} runner {r[3]:>7.2f}%  tp2 {r[4]:>7.2f}%  delta {r[5]:>+8.3f}$")
    print(f"CHOP TP2-hit n={len(ch['rows'])}: cap wins on {len(gave_back)} ({100*len(gave_back)/len(ch['rows']):.0f}%) — avg delta/trade {(ch['capped_usd']-ch['runner_usd'])/len(ch['rows']):+.3f}$")

tr = out["TREND"]
if tr["rows"]:
    kept = sum(1 for r in tr["rows"] if r[3] > r[4])
    print(f"\nTREND TP2-hit n={len(tr['rows'])}: runner beat TP2-cap on {kept} — runner$ {tr['runner_usd']:.2f} vs cap$ {tr['capped_usd']:.2f} (delta {tr['capped_usd']-tr['runner_usd']:+.2f}$)")
