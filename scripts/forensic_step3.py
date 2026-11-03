#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Forensic step 3: daily signal stats around 29/10 LIVE reconnect + latency distribution."""
import sqlite3, json, datetime

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

def iso(ms):
    return datetime.datetime.utcfromtimestamp(ms / 1000).isoformat() + "Z"

out = {}

# --- Daily Signal stats Oct 24 -> now  (2026-10-24 00:00 UTC = 1792195200000 ms)
start = 1792195200000
rows = cur.execute("""
  SELECT date(createdAt/1000,'unixepoch') AS d,
         COUNT(*) AS n,
         SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END) AS tp_hits,
         AVG(maxPnlPercent) AS avg_max_pnl,
         SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END) AS sl_n,
         SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END) AS exp_n,
         SUM(CASE WHEN status IN ('OPEN','TP1','TP2','TP3') THEN 1 ELSE 0 END) AS open_n,
         AVG(CASE WHEN strategy='AI-SWING' THEN 1.0 ELSE 0.0 END) AS aiswing_frac
  FROM Signal WHERE createdAt >= ?
  GROUP BY d ORDER BY d""", (start,)).fetchall()
out["daily_signals"] = [dict(r) for r in rows]

# --- Status distribution since Oct 29 (LIVE reconnect suspicion window)
o29 = 1793232000000  # 2026-10-29 00:00 UTC
rows = cur.execute("""
  SELECT status, COUNT(*) n, AVG(pnlPercent) avg_pnl, AVG(maxPnlPercent) avg_max
  FROM Signal WHERE createdAt >= ? GROUP BY status ORDER BY n DESC""", (o29,)).fetchall()
out["since_1029_status"] = [dict(r) for r in rows]

# --- FillLedger daily latency stats
rows = cur.execute("""
  SELECT date(createdAt/1000,'unixepoch') AS d,
         COUNT(*) n,
         AVG(latencyMs) avg_lat,
         MAX(latencyMs) max_lat,
         SUM(CASE WHEN latencyMs > 90000 THEN 1 ELSE 0 END) late_90s,
         SUM(CASE WHEN latencyMs > 300000 THEN 1 ELSE 0 END) late_5m,
         AVG(slipBps) avg_slip
  FROM FillLedger WHERE createdAt >= ?
  GROUP BY d ORDER BY d""", (start,)).fetchall()
out["daily_fill_latency"] = [dict(r) for r in rows]

# --- signals that reached TP since Oct 29 vs before (window Oct 22-29)
rows = cur.execute("""
  SELECT CASE WHEN createdAt >= ? THEN 'AFTER_1029' ELSE 'BEFORE_1029' END AS win,
         COUNT(*) n, SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END) tp_hits,
         ROUND(100.0*SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END)/COUNT(*),1) tp_rate,
         AVG(maxPnlPercent) avg_max_pnl, AVG(pnlPercent) avg_pnl
  FROM Signal WHERE createdAt >= ? AND status NOT IN ('OPEN')
  GROUP BY win""", (o29, 1791763200000)).fetchall()
out["before_after_1029"] = [dict(r) for r in rows]

# --- EngineSetting: live/mode/gate keys
rows = cur.execute("SELECT key, value, updatedAt FROM EngineSetting").fetchall()
out["engine_settings"] = {r["key"]: {"v": r["value"][:160], "at": iso(r["updatedAt"]) if r["updatedAt"] and str(r["updatedAt"]).isdigit() else str(r["updatedAt"])} for r in rows}

print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
