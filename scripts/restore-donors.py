#!/usr/bin/env python3
"""OP-SJ-RESTORE-0909: build db/custom.db.restored from the decrypted Sep-8 19:31 UTC
snapshot DB (epoch 2, serials 1-6) + donor signals created after the snapshot moment
from the LIVE db (serials 20-26 -> re-serialized 7-13, events remapped).
Follows the restore-db-merge.py conventions from INCIDENT-0907."""
import sqlite3, shutil, time, re, sys, random

SNAP = "/home/z/my-project/restore-staging/snap/db/custom.db"
DONOR = "/home/z/my-project/db/custom.db"
OUT = "/home/z/my-project/db/custom.db.restored"
CUTOFF_UTC = 1788903060000  # 2026-09-08T19:31:00Z — snapshot moment

def _b36(n):
    s = ""
    while n: s = "abcdefghijklmnopqrstuvwxyz0123456789"[n % 36] + s; n //= 36
    return s or "0"

def cuid():
    return "c" + _b36(int(time.time() * 1000)) + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))

def main():
    shutil.copyfile(SNAP, OUT)
    snap = sqlite3.connect(OUT)
    donor = sqlite3.connect(f"file:{DONOR}?mode=ro", uri=True)
    sc, dc = snap.cursor(), donor.cursor()

    snap_cols = [d[1] for d in sc.execute("PRAGMA table_info(Signal)").fetchall()]
    donor_cols = [d[1] for d in dc.execute("PRAGMA table_info(Signal)").fetchall()]
    ev_cols = [d[1] for d in sc.execute("PRAGMA table_info(SignalEvent)").fetchall()]
    d_ev_cols = [d[1] for d in dc.execute("PRAGMA table_info(SignalEvent)").fetchall()]
    print(f"Signal cols snap={len(snap_cols)} donor={len(donor_cols)} | Event cols snap={len(ev_cols)} donor={len(d_ev_cols)}")

    max_serial = sc.execute("SELECT MAX(serial) FROM Signal").fetchone()[0]
    print(f"snapshot base: {sc.execute('SELECT COUNT(*) FROM Signal').fetchone()[0]} signals, max serial {max_serial}")

    donors = dc.execute("SELECT * FROM Signal WHERE createdAt > ? ORDER BY createdAt, serial", (CUTOFF_UTC,)).fetchall()
    print(f"donor signals created after snapshot moment: {len(donors)}")

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
    print(f"inserted {len(id_map)} donor signals (serials {max_serial + 1}..{new_serial})")

    ev_moved = 0
    for old_sid, new_sid in id_map.items():
        evs = dc.execute("SELECT * FROM SignalEvent WHERE signalId = ? ORDER BY rowid", (old_sid,)).fetchall()
        for ev in evs:
            e = dict(zip(d_ev_cols, ev))
            new_eid = cuid()
            ecommon = [c for c in d_ev_cols if c in ev_cols and c not in ("id", "signalId")]
            cols = ["id", "signalId"] + ecommon
            sc.execute(f"INSERT INTO SignalEvent ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                       [new_eid, new_sid] + [e.get(c) for c in ecommon])
            ev_moved += 1
    print(f"inserted {ev_moved} donor events")

    snap.commit()
    n, mx = sc.execute("SELECT COUNT(*), MAX(serial) FROM Signal").fetchone()
    act = sc.execute("SELECT COUNT(*) FROM Signal WHERE status IN ('ACTIVE','OPEN')").fetchone()[0]
    print(f"restored DB: {n} signals, max serial {mx}, active {act}")
    snap.close(); donor.close()

    # integrity check before declaring success
    chk = sqlite3.connect(OUT)
    ok = chk.execute("PRAGMA integrity_check").fetchone()[0]
    chk.close()
    print("integrity_check:", ok)
    if ok != "ok":
        sys.exit(2)

if __name__ == "__main__":
    main()
