#!/usr/bin/env python3
"""Read-only forensics for operator follow-up (Q1 balance, Q2 pump radar/journal, Q3 self-improve)."""
import sqlite3, json

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
c = sqlite3.connect(DB, uri=True)
c.row_factory = sqlite3.Row

print("=== SIGNAL full schema ===")
print(", ".join(r[1] for r in c.execute("PRAGMA table_info(Signal)")))

print("\n=== LIFE AGGREGATE (settled, pnlUsd=margin*pct/100) ===")
r = c.execute("""SELECT COUNT(*) n,
 SUM(CASE WHEN status LIKE 'TP%' THEN 1 ELSE 0 END) tp,
 SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END) sl,
 SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) exp,
 SUM(marginUsd*pnlPercent/100.0) pnl, SUM(feeUsd+swapUsd) fee,
 AVG(pnlPercent) avgpct,
 SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END) wins FROM Signal
 WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED')""").fetchone()
print(dict(r))
r = c.execute("SELECT COUNT(*) n, SUM(marginUsd*pnlPercent/100.0) upnl FROM Signal WHERE status IN ('ACTIVE','TP1','TP2')").fetchone()
print("open:", dict(r))

print("\n=== BY STRATEGY ===")
for r in c.execute("""SELECT strategy, COUNT(*) n, SUM(marginUsd*pnlPercent/100.0) pnl,
 AVG(pnlPercent) avgpct, SUM(CASE WHEN reachedTp>=1 THEN 1 ELSE 0 END) wins
 FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED')
 GROUP BY strategy ORDER BY pnl"""):
    print(dict(r))

print("\n=== BY LEVERAGE BAND ===")
for r in c.execute("""SELECT CASE WHEN leverage<=5 THEN '05' WHEN leverage<=10 THEN '06-10'
 WHEN leverage<=15 THEN '11-15' ELSE '16+' END band, COUNT(*) n,
 SUM(marginUsd*pnlPercent/100.0) pnl, AVG(pnlPercent) avgpct
 FROM Signal WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') GROUP BY band"""):
    print(dict(r))

print("\n=== STATUS MIX x PNL (why balance drifts) ===")
for r in c.execute("""SELECT status, COUNT(*) n, SUM(marginUsd*pnlPercent/100.0) pnl,
 AVG(pnlPercent) avgpct, AVG(marginUsd) avgmargin FROM Signal
 WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','CLOSED') GROUP BY status"""):
    print(dict(r))

print("\n=== PUMPTRACK outcomes ===")
for r in c.execute("SELECT kind, phase, outcome, COUNT(*) n FROM PumpTrack GROUP BY kind, phase, outcome ORDER BY n DESC"):
    print(dict(r))

print("\n=== PUMPTRACK sample (latest 5) ===")
for r in c.execute("SELECT symbol, kind, phase, outcome, vel5mPct, volBurstX, detectedAt FROM PumpTrack ORDER BY detectedAt DESC LIMIT 5"):
    print(dict(r))

print("\n=== ADVISOR PROPOSALS (all) ===")
for r in c.execute("SELECT createdAt, cycle, kind, knob, currentValue, proposedValue, status, rationale FROM AdvisorProposal ORDER BY createdAt"):
    print(dict(r))

print("\n=== ENGINESETTING keys ===")
for r in c.execute("SELECT key, length(value) len, updatedAt FROM EngineSetting ORDER BY key"):
    print(dict(r))

print("\n=== deep-learn / journal / veto snapshots ===")
for k in ["deep-learn", "shadow-veto", "gate", "advisor", "journal"]:
    row = c.execute("SELECT value FROM EngineSetting WHERE key=?", (k,)).fetchone()
    if row:
        v = row[0]
        print(f"--- {k} ({len(v)}B):", v[:900])

print("\n=== SIGNAL columns re engine source (sample analysis of pump-linked) ===")
for r in c.execute("SELECT COUNT(*) n FROM Signal WHERE analysis LIKE '%PUMP%' OR analysis LIKE '%RADAR%'"):
    print("signals mentioning PUMP/RADAR in analysis:", dict(r))

print("\n=== VolCauseEvent vs Signal overlap (symbols) ===")
r = c.execute("""SELECT COUNT(DISTINCT v.symbol) FROM VolCauseEvent v WHERE v.symbol IN
 (SELECT DISTINCT symbol FROM Signal)""").fetchone()
print("volcause symbols that later got signals:", dict(r))
