#!/usr/bin/env python3
"""RESTORE-0909: merge the decrypted Sep-8 19:31 snapshot DB (authoritative
epoch-2 lineage) with the post-resync donor DB (current live trades).

Adapted from scripts/restore-db-merge.py (RESTORE-0907). Differences:
- cutoff = platform resync moment 2026-09-08 20:21:00 UTC
- donor PricePoints post-cutoff are imported (new cuids)
- snapshot-only Signal columns (initialStopLoss, mtfJson) get NULL
- EngineSetting: snapshot rows stay; dailyreport.last is refreshed from the
  donor's report.daily.lastSentAt (today's actual relay send)
- integrity battery: FK check, duplicate-serial check, counts
Output: db/custom.db.restored (atomic swap happens in restore-0909-apply.sh)
"""
import sqlite3, shutil, time, re

import os
SNAP = os.environ.get("SNAP_DB", "/home/z/my-project/restore-staging/rebuild/sep8b/db/custom.db")
DONOR = os.environ.get("DONOR_DB", "/home/z/my-project/restore-staging/rebuild/donor.db")
OUT = os.environ.get("OUT_DB", "/home/z/my-project/restore-staging/rebuild/merged.db")
CUTOFF = 1788898860000  # 2026-09-08 20:21:00 UTC — platform resync moment

def cuid():
    ts = _b36(int(time.time() * 1000))
    return "c" + ts + "0000" + _rand12()

def _b36(n):
    s = ""
    while n: s = "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36] + s; n //= 36
    return s or "0"

def _rand12():
    import random
    return "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def main():
    shutil.copyfile(SNAP, OUT)
    snap = sqlite3.connect(OUT)
    donor = sqlite3.connect(f"file:{DONOR}?mode=ro", uri=True)
    sc, dc = snap.cursor(), donor.cursor()

    snap_cols = [d[1] for d in sc.execute("PRAGMA table_info(Signal)")]
    donor_cols = [d[1] for d in dc.execute("PRAGMA table_info(Signal)")]
    ev_cols = [d[1] for d in sc.execute("PRAGMA table_info(SignalEvent)")]
    pp_cols = [d[1] for d in sc.execute("PRAGMA table_info(PricePoint)")]

    max_serial = sc.execute("SELECT MAX(serial) FROM Signal").fetchone()[0]
    print(f"snapshot base: {sc.execute('SELECT COUNT(*) FROM Signal').fetchone()[0]} signals, max serial {max_serial}")

    # ── 1) donor signals after the resync cutoff ──
    donors = dc.execute("SELECT * FROM Signal WHERE createdAt > ? ORDER BY createdAt, serial", (CUTOFF,)).fetchall()
    print(f"donor signals post-resync: {len(donors)}")
    id_map, new_serial = {}, max_serial
    for row in donors:
        d = dict(zip(donor_cols, row))
        new_serial += 1
        new_id = cuid()
        id_map[d["id"]] = new_id
        common = [c for c in donor_cols if c in snap_cols and c not in ("id", "serial")]
        vals = {c: d[c] for c in common}
        analysis = vals.get("analysis") or ""
        vals["analysis"] = re.sub(r"^\[NX-\d+\]", f"[NX-{new_serial:04d}]", analysis, count=1)
        cols = ["id", "serial"] + common + [c for c in snap_cols if c not in common and c not in ("id", "serial")]
        params = [new_id, new_serial] + [vals.get(c) for c in common] + [None] * len(snap_cols)  # placeholder
        # build explicit column/value list (snap-only cols → NULL)
        cols_sql = ", ".join(f'"{c}"' for c in ["id", "serial"] + common + [c for c in snap_cols if c not in common and c not in ("id", "serial")])
        values = [new_id, new_serial] + [vals[c] for c in common] + [None] * (len(snap_cols) - len(common) - 2)
        ph = ", ".join(["?"] * len(values))
        sc.execute(f'INSERT INTO Signal ({cols_sql}) VALUES ({ph})', values)
        print(f"  serial {d['serial']} {d['symbol']} {d['status']} -> serial {new_serial}")

    # ── 2) their SignalEvents ──
    ev_moved = 0
    donor_ev_cols = [d[1] for d in dc.execute("PRAGMA table_info(SignalEvent)")]
    for old_id, new_id in id_map.items():
        for r in dc.execute("SELECT * FROM SignalEvent WHERE signalId = ? ORDER BY createdAt", (old_id,)).fetchall():
            e = dict(zip(donor_ev_cols, r))
            common_ev = [c for c in donor_ev_cols if c in ev_cols and c != "id"]
            cols_sql = ", ".join(f'"{c}"' for c in ["id"] + common_ev)
            sc.execute(f'INSERT INTO SignalEvent ({cols_sql}) VALUES ({", ".join(["?"] * (1 + len(common_ev)))})',
                       [cuid()] + [new_id if c == "signalId" else e[c] for c in common_ev])
            ev_moved += 1
    print(f"events moved: {ev_moved}")

    # ── 3) donor PricePoints after cutoff ──
    donor_pp_cols = [d[1] for d in dc.execute("PRAGMA table_info(PricePoint)")]
    pps = dc.execute("SELECT * FROM PricePoint WHERE createdAt > ? ORDER BY createdAt", (CUTOFF,)).fetchall()
    rows = []
    for r in pps:
        p = dict(zip(donor_pp_cols, r))
        if "id" in pp_cols and "symbol" in pp_cols and "price" in pp_cols and "createdAt" in pp_cols:
            rows.append([cuid(), p["symbol"], p["price"], p["createdAt"]])
    if rows:
        sc.executemany(f'INSERT INTO PricePoint ({", ".join(chr(34)+c+chr(34) for c in ["id","symbol","price","createdAt"])}) VALUES (?,?,?,?)', rows)
    print(f"price points imported: {len(rows)}")

    # ── 4) EngineSetting: refresh dailyreport.last from donor truth ──
    es_cols = [d[1] for d in sc.execute("PRAGMA table_info(EngineSetting)")]
    dr = dc.execute("SELECT value FROM EngineSetting WHERE key='report.daily.lastSentAt'").fetchone()
    if dr:
        import datetime as _dt
        now_iso = _dt.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
        if "updatedAt" in es_cols:
            sc.execute("INSERT OR REPLACE INTO EngineSetting (key, value, updatedAt) VALUES ('dailyreport.last', ?, ?)",
                       [f'{{"at":{dr[0]},"ok":true}}', now_iso])
        else:
            sc.execute("INSERT OR REPLACE INTO EngineSetting (key, value) VALUES ('dailyreport.last', ?)",
                       [f'{{"at":{dr[0]},"ok":true}}'])
        print(f"dailyreport.last = {dr[0]} (today's actual relay send)")

    # ── 5) integrity battery ──
    total = sc.execute("SELECT COUNT(*) FROM Signal").fetchone()[0]
    dup = sc.execute("SELECT serial, COUNT(*) c FROM Signal GROUP BY serial HAVING c > 1").fetchall()
    fk = sc.execute("PRAGMA foreign_key_check").fetchall()
    active = sc.execute("SELECT serial, symbol FROM Signal WHERE status='ACTIVE' ORDER BY serial").fetchall()
    print(f"\nMERGED DB: signals={total} max_serial={sc.execute('SELECT MAX(serial) FROM Signal').fetchone()[0]} "
          f"events={sc.execute('SELECT COUNT(*) FROM SignalEvent').fetchone()[0]} "
          f"pricePoints={sc.execute('SELECT COUNT(*) FROM PricePoint').fetchone()[0]} "
          f"settings={sc.execute('SELECT COUNT(*) FROM EngineSetting').fetchone()[0]}")
    print("ACTIVE:", active)
    print("duplicate serials:", dup if dup else "none")
    print("FK violations:", fk if fk else "none")
    snap.commit(); snap.close(); donor.close()
    print("OK ->", OUT)

if __name__ == "__main__":
    main()
