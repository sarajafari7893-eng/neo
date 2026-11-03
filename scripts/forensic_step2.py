#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Forensic step 2: NX-3247 record + 29/10 LIVE window signal stats."""
import sqlite3, json, datetime

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

def ts(v):
    """Defensive timestamp parse -> UTC ISO or raw."""
    if v is None: return None
    if isinstance(v, (int, float)):
        ms = v if v > 1e11 else v * 1000
        return datetime.datetime.utcfromtimestamp(ms / 1000).isoformat() + "Z"
    s = str(v)
    if s.replace('.', '').replace('-', '').isdigit():
        try:
            n = float(s)
            ms = n if n > 1e11 else n * 1000
            return datetime.datetime.utcfromtimestamp(ms / 1000).isoformat() + "Z"
        except Exception:
            return s
    return s

out = {}

# --- Signal table schema
sc = [r[1] for r in cur.execute("PRAGMA table_info('Signal')")]
out["Signal.cols"] = sc
n = cur.execute("SELECT COUNT(*) FROM Signal").fetchone()[0]
out["Signal.count"] = n

# --- NX-3247 exact record (search id and serial/text)
row = cur.execute("SELECT * FROM Signal WHERE id LIKE '%3247%' OR CAST(id AS TEXT)='3247' LIMIT 5").fetchall()
out["NX-3247.rows"] = [dict(r) for r in row] if row else None

# fallback: last 5 signals by id/createdAt
last = cur.execute("SELECT * FROM Signal ORDER BY rowid DESC LIMIT 6").fetchall()
out["Signal.last6"] = [dict(r) for r in last]

# --- SignalEvent schema + last events
ec = [r[1] for r in cur.execute("PRAGMA table_info('SignalEvent')")]
out["SignalEvent.cols"] = ec
sev = cur.execute("SELECT * FROM SignalEvent ORDER BY rowid DESC LIMIT 12").fetchall()
out["SignalEvent.last12"] = [dict(r) for r in sev]

print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
