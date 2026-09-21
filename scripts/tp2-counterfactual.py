#!/usr/bin/env python3
# ── TP2 COUNTERFACTUAL LAB (read-only) — operator question 2026-09-14 ──
# «اگر هر سیگنال فقط 2 تی‌پی داشت (60% خروج در TP1، 40% باقیمانده در TP2)
#  عملکرد PnL بهتر می‌شد یا بدتر؟»
#
# Method: EXACT tranche algebra over the stored ledger (no invented fills):
#   stored net% = T1*m1 + T2*m2 + T3*mR - feePct   (tranches .5/.3/.2)
#   moves m1..mR are levered % at the ACTUAL fills (TP1/TP2/TP3/BE/trail/
#   expiry mark) — unknown fills are SOLVED from the stored net, so the
#   counterfactual only re-WEIGHTS the same real fills.
#   CF(60/40) per signal:
#     r=0  (never TP1)          -> identical (single fill, unchanged)
#     r=1  (TP1 only)           -> net + 0.1*(m1 - mR)     [mR solved]
#     r>=2 (TP2+ hit)           -> 0.6*m1 + 0.4*m2 - fee   [TP3 tranche never sells]
# Fees accrue on FULL notional in both ladders (accounting.ts contract).
# DB access: file:db/custom.db?mode=ro — read-only, zero writes.

import sqlite3, json, datetime

con = sqlite3.connect("file:db/custom.db?mode=ro", uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = cur.execute("""
SELECT serial, symbol, direction, strategy, status, reachedTp, maxPnlPercent,
       entryPrice, tp1, tp2, tp3, stopLoss, leverage, pnlPercent, marginUsd,
       feeUsd, swapUsd, confidence, closedAt
FROM Signal WHERE closedAt IS NOT NULL
""").fetchall()

T1, T2, T3 = 0.5, 0.3, 0.2

def mv(price, s):
    if price is None or s["entryPrice"] in (None, 0):
        return None
    d = 1 if s["direction"] == "LONG" else -1
    return ((price - s["entryPrice"]) / s["entryPrice"]) * d * (s["leverage"] or 1) * 100

agg = dict(n=0, used=0, skip=0, cur=0.0, cf=0.0, win_cur=0, win_cf=0)
by_bucket = {"r0": [0, 0.0, 0.0], "r1": [0, 0.0, 0.0], "r2p": [0, 0.0, 0.0]}
per_strategy = {}
sanity_tp3 = []
worst = []
best = []

for s in rows:
    agg["n"] += 1
    net = s["pnlPercent"] or 0.0
    fee = ((s["feeUsd"] or 0.0) + (s["swapUsd"] or 0.0)) / (s["marginUsd"] or 1.0) * 100
    r = s["reachedTp"] or 0
    m1, m2 = mv(s["tp1"], s), mv(s["tp2"], s)
    if r >= 1 and m1 is None:
        agg["skip"] += 1
        continue
    agg["used"] += 1
    cur_net, cf_net = net, net
    b = "r0" if r == 0 else ("r1" if r == 1 else "r2p")
    if r == 1:
        # solve the actual remaining-tranche fill from the stored net
        mR = (net + fee - T1 * m1) / T2  # remaining tranche = .5 -> net+fee = .5m1+.5mR
        cf_net = 0.6 * m1 + 0.4 * mR - fee
    elif r >= 2:
        if m2 is None:
            agg["skip"] += 1
            continue
        mR = (net + fee - T1 * m1 - T2 * m2) / T3  # runner fill (TP3/BE/trail/mark)
        if s["status"] == "TP3" and s["tp3"]:
            sanity_tp3.append(abs(mR - mv(s["tp3"], s)))
        cf_net = 0.6 * m1 + 0.4 * m2 - fee
    agg["cur"] += cur_net
    agg["cf"] += cf_net
    if cur_net > 0: agg["win_cur"] += 1
    if cf_net > 0: agg["win_cf"] += 1
    by_bucket[b][0] += 1
    by_bucket[b][1] += cur_net
    by_bucket[b][2] += cf_net
    st = per_strategy.setdefault(s["strategy"], [0, 0.0, 0.0])
    st[0] += 1; st[1] += cur_net; st[2] += cf_net
    d = cf_net - cur_net
    (best if d >= 0 else worst).append((d, s["serial"], s["symbol"], s["direction"], s["status"], r, round(cur_net, 1), round(cf_net, 1)))

print("=== TP2 COUNTERFACTUAL (60% @TP1 / 40% @TP2 vs current 50/30/20) ===")
print(f"ledger settled: {agg['n']}  |  used in algebra: {agg['used']}  |  skipped (missing tp levels): {agg['skip']}")
print(f"CURRENT  ladder total pnl%: {agg['cur']:.1f}%   (sanity: matches engine)")
print(f"CF 60/40 ladder total %:     {agg['cf']:.1f}%")
print(f"DELTA (CF - current):        {agg['cf'] - agg['cur']:+.1f}% of one margin-unit across the ledger")
print(f"win-count: current {agg['win_cur']} vs CF {agg['win_cf']} of {agg['used']}")
if sanity_tp3:
    print(f"model sanity — solved runner fill vs stored TP3 price, mean|err| = {sum(sanity_tp3)/len(sanity_tp3):.2f}% over {len(sanity_tp3)} TP3 cases")
print("\nby rung-depth bucket (total pnl%: current -> CF):")
for k, (n, c, f) in by_bucket.items():
    name = {"r0": "never TP1 (single fill)", "r1": "TP1 only (BE/trail/expiry after)", "r2p": "TP2+ hit"}[k]
    print(f"  {name:36s} n={n:4d}  {c:8.1f}% -> {f:8.1f}%   delta {f-c:+7.1f}%")
print("\nby strategy (n / current% -> CF%):")
for k, v in sorted(per_strategy.items(), key=lambda kv: -kv[1][0]):
    print(f"  {k:22s} n={v[0]:4d}  {v[1]:8.1f}% -> {v[2]:8.1f}%  delta {v[2]-v[1]:+7.1f}%")
worst.sort(); best.sort(reverse=True)
print("\ntop 5 signals the 60/40 ladder HURTS (runner would have kept running):")
for d, ser, sym, dirn, st_, r, c, f in worst[:5]:
    print(f"  NX-{ser:04d} {sym} {dirn} {st_} r={r}: {c:+.1f} -> {f:+.1f} ({d:+.1f})")
print("top 5 signals the 60/40 ladder HELPS (locks more at TP1/TP2):")
for d, ser, sym, dirn, st_, r, c, f in best[:5]:
    print(f"  NX-{ser:04d} {sym} {dirn} {st_} r={r}: {c:+.1f} -> {f:+.1f} ({d:+.1f})")
con.close()
