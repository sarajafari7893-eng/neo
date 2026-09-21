#!/usr/bin/env python3
"""Operator follow-up analysis 2026-09-14 (read-only).
Q1 best/worst patterns + balance mechanics · Q2 radar-linked signal performance.
"""
import sqlite3, json
from collections import defaultdict

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row

rows = [dict(r) for r in con.execute("""
    SELECT id, symbol, direction, strategy, status, leverage, marginUsd, confidence,
           riskReward, ttlMinutes, pnlPercent, feeUsd, swapUsd, createdAt, closedAt,
           reachedTp, engine, serial
    FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
""")]

def pnl_usd(r):
    return (r["marginUsd"] or 0) * (r["pnlPercent"] or 0) / 100.0

def is_win(r):
    return (r["status"] or "").startswith("TP")

def bucket(r):
    return dict(
        status=r["status"],
        strategy=r["strategy"],
        conf="80-89" if 80 <= (r["confidence"] or 0) <= 89 else ("<80" if (r["confidence"] or 0) < 80 else "90+"),
        lev="<=5" if (r["leverage"] or 0) <= 5 else ("6-9" if (r["leverage"] or 0) <= 9 else ("10-15" if (r["leverage"] or 0) <= 15 else ">15")),
        ttl="<=60" if (r["ttlMinutes"] or 0) <= 60 else ("61-90" if (r["ttlMinutes"] or 0) <= 90 else ("91-150" if (r["ttlMinutes"] or 0) <= 150 else ">150")),
        rr="<=1.5" if (r["riskReward"] or 0) <= 1.5 else ("1.5-2" if (r["riskReward"] or 0) <= 2 else ">2"),
        dir=r["direction"],
        hour=(lambda ts: time.strftime("%H", time.gmtime(ts/1000 + 3.5*3600)))(r["createdAt"]),
    )

import time
def group(key):
    g = defaultdict(list)
    for r in rows:
        g[bucket(r)[key]].append(r)
    out = []
    for k, v in sorted(g.items()):
        n = len(v)
        wr = 100.0 * sum(1 for r in v if is_win(r)) / n
        avg = sum(r["pnlPercent"] or 0 for r in v) / n
        usd = sum(pnl_usd(r) for r in v)
        fee = sum(r["feeUsd"] or 0 for r in v) + sum(r["swapUsd"] or 0 for r in v)
        out.append((k, n, round(wr, 1), round(avg, 2), round(usd, 2), round(fee, 2)))
    return out

print("== BOOK:", len(rows), "settled")
gross = sum(pnl_usd(r) for r in rows)
fees = sum((r["feeUsd"] or 0) + (r["swapUsd"] or 0) for r in rows)
print(f"grossPnl ${gross:.2f} · fees+swap ${fees:.2f} · net ${gross-fees:.2f} · impliedEquity ${100+gross-fees:.2f}")

for dim in ["status", "strategy", "conf", "lev", "ttl", "rr", "dir"]:
    print(f"== BY {dim}: key n WR% avgPnl% pnlUsd feeUsd")
    for t in group(dim):
        print("  ", t)

hours = group("hour")
hours.sort(key=lambda t: t[4])
print("== WORST HOURS (Tehran):", hours[:4])
print("== BEST HOURS (Tehran):", hours[-4:])

worst = sorted(rows, key=lambda r: pnl_usd(r))[:6]
print("== WORST TRADES:", [(r["symbol"], r["strategy"], r["status"], round(pnl_usd(r), 2)) for r in worst])

# Radar linkage
linked = set(r[0] for r in con.execute("SELECT signalId FROM PumpTrack WHERE signalId IS NOT NULL"))
lin = [r for r in rows if r["id"] in linked]
uno = [r for r in rows if r["id"] not in linked]
for label, v in [("RADAR-LINKED", lin), ("NON-LINKED", uno)]:
    n = len(v)
    if n:
        wr = 100.0 * sum(1 for r in v if is_win(r)) / n
        usd = sum(pnl_usd(r) for r in v)
        avg = sum(r["pnlPercent"] or 0 for r in v) / n
        print(f"== {label}: n={n} WR={wr:.1f}% avgPnl={avg:.2f}% pnlUsd=${usd:.2f}")

# radar native fit: what if radar-linked trades had used MFE-style shallow target?
from statistics import mean
print("== radar avgMfe SUCCESS 2.48% FAILURE 0.72 (from PumpTrack) — deep ladder RR>2 needs ~6% travel")
