#!/usr/bin/env python3
"""OP-SJ-RESTORE-0909 v2: rebuild the restored DB with the CORRECT cutoff
(JS-verified epoch) from the pre-restore backup donors, then emit a
WAL-free single-file DB via VACUUM INTO (the stale-WAL lesson)."""
import sqlite3, shutil, time, re, sys, random
from datetime import datetime, timezone

SNAP = "/home/z/my-project/restore-staging/snap/db/custom.db"
DONOR = "/home/z/my-project/db/custom.db.pre-restore-20260908-224912.db"
BUILD = "/home/z/my-project/db/.restore-build.db"
OUT = "/home/z/my-project/db/custom.db.restored2"

CUTOFF_MS = int(datetime(2026, 9, 8, 19, 31, 0, tzinfo=timezone.utc).timestamp() * 1000)
print("cutoff ms:", CUTOFF_MS, "=", datetime.fromtimestamp(CUTOFF_MS / 1000, timezone.utc).isoformat())

def _b36(n):
    s = ""
    while n: s = "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36] + s; n //= 36
    return s or "0"

def cuid():
    return "c" + _b36(int(time.time() * 1000)) + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def main():
    # fresh build from the snapshot
    for p in (BUILD, OUT):
        if __import__("os").path.exists(p):
            __import__("os").remove(p)
    shutil.copyfile(SNAP, BUILD)
    snap = sqlite3.connect(BUILD)
    donor = sqlite3.connect(f"file:{DONOR}?mode=ro", uri=True)
    sc, dc = snap.cursor(), donor.cursor()

    snap_cols = [d[1] for d in sc.execute("PRAGMA table_info(Signal)").fetchall()]
    donor_cols = [d[1] for d in dc.execute("PRAGMA table_info(Signal)").fetchall()]
    ev_cols = [d[1] for d in sc.execute("PRAGMA table_info(SignalEvent)").fetchall()]
    d_ev_cols = [d[1] for d in dc.execute("PRAGMA table_info(SignalEvent)").fetchall()]

    max_serial = sc.execute("SELECT MAX(serial) FROM Signal").fetchone()[0]
    donors = dc.execute("SELECT * FROM Signal WHERE createdAt > ? ORDER BY createdAt, serial", (CUTOFF_MS,)).fetchall()
    print(f"base: max serial {max_serial} | donors after cutoff: {len(donors)} "
          f"({[d[donor_cols.index('symbol')] for d in donors]})")
    if len(donors) != 7:
        print("UNEXPECTED donor count — aborting (expected 7)")
        sys.exit(2)

    id_map, new_serial = {}, max_serial
    common = [c for c in donor_cols if c in snap_cols and c not in ("id", "serial")]
    for row in donors:
        d = dict(zip(donor_cols, row))
        new_serial += 1
        new_id = cuid()
        id_map[d["id"]] = new_id
        vals = {c: d[c] for c in common}
        vals["analysis"] = re.sub(r"^\[NX-\d+\]", f"[NX-{new_serial:04d}]", vals.get("analysis") or "", count=1)
        cols = ["id", "serial"] + common
        sc.execute(f"INSERT INTO Signal ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                   [new_id, new_serial] + [vals.get(c) for c in common])

    ev_moved = 0
    for old_sid, new_sid in id_map.items():
        for ev in dc.execute("SELECT * FROM SignalEvent WHERE signalId = ? ORDER BY rowid", (old_sid,)).fetchall():
            e = dict(zip(d_ev_cols, ev))
            ecommon = [c for c in d_ev_cols if c in ev_cols and c not in ("id", "signalId")]
            cols = ["id", "signalId"] + ecommon
            sc.execute(f"INSERT INTO SignalEvent ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       [cuid(), new_sid] + [e.get(c) for c in ecommon])
            ev_moved += 1
    snap.commit()
    n, mx = sc.execute("SELECT COUNT(*), MAX(serial) FROM Signal").fetchone()
    act = sc.execute("SELECT COUNT(*) FROM Signal WHERE status IN ('ACTIVE','OPEN')").fetchone()[0]
    print(f"built: {n} signals, max serial {mx}, active {act}, donor events {ev_moved}")
    snap.close(); donor.close()

    # WAL-free final artifact via VACUUM INTO (single consistent file)
    src = sqlite3.connect(f"file:{BUILD}?mode=ro", uri=True)
    src.execute("VACUUM INTO ?", (OUT,))
    src.close()
    chk = sqlite3.connect(f"file:{OUT}?mode=ro", uri=True)
    ok = chk.execute("PRAGMA integrity_check").fetchone()[0]
    n2 = chk.execute("SELECT COUNT(*) FROM Signal").fetchone()[0]
    chk.close()
    print(f"final: integrity={ok} signals={n2}")
    if ok != "ok" or n2 != n:
        sys.exit(3)

if __name__ == "__main__":
    main()
