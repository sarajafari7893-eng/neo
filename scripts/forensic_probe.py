#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Forensic read-only probe of db/custom.db — NX-3247 delay + LIVE degradation."""
import sqlite3, json, sys

DB = "file:/home/z/my-project/db/custom.db?mode=ro"
con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

out = {}

# 1. Table inventory + row counts for signal-ish tables
tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
out["tables"] = tables

def cols(t):
    return [r[1] for r in cur.execute(f"PRAGMA table_info('{t}')")]

# find tables containing NX ids
nx_hits = {}
for t in tables:
    try:
        c = cols(t)
        if not c:
            continue
        # probe text columns for 'NX-' pattern
        probe_col = None
        for cand in ("id", "cardId", "symbol", "key", "name"):
            if cand in c:
                probe_col = cand
                break
        n = cur.execute(f"SELECT COUNT(*) FROM '{t}'").fetchone()[0]
        nx_hits[t] = {"rows": n, "cols": c[:14]}
    except Exception as e:
        nx_hits[t] = {"err": str(e)}
out["inventory"] = nx_hits

print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
