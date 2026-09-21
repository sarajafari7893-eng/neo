#!/usr/bin/env python3
"""Restore signal history: merge Sep-5 snapshot DB (127 signals, full history)
with the post-rollback donor DB (10 re-deployed signals, serials 20-29).
Donor signals are re-serialized to continue after the snapshot's max serial.
Output: db/custom.db.restored (atomic swap happens after Next.js is stopped).
"""
import sqlite3, shutil, time, calendar, re, sys

SNAP = "/home/z/my-project/scripts/staging/sep5/db/custom.db"
DONOR = "/home/z/my-project/db/custom.db"
OUT = "/home/z/my-project/db/custom.db.restored"
CUTOFF_UTC = calendar.timegm((2026, 9, 6, 20, 0, 0)) * 1000  # sandbox restore moment

def cuid():
    ts = format(int(time.time() * 1000), "base36") if False else _b36(int(time.time() * 1000))
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

    snap_cols = [d[1] for d in sc.execute("PRAGMA table_info(Signal)").fetchall()]
    donor_cols = [d[1] for d in dc.execute("PRAGMA table_info(Signal)").fetchall()]
    ev_cols = [d[1] for d in sc.execute("PRAGMA table_info(SignalEvent)").fetchall()]
    donor_ev_cols = [d[1] for d in dc.execute("PRAGMA table_info(SignalEvent)").fetchall()]
    print("snap Signal cols:", len(snap_cols), "| donor:", len(donor_cols))
    print("SignalEvent cols (snap):", ev_cols)

    max_serial = sc.execute("SELECT MAX(serial) FROM Signal").fetchone()[0]
    max_id_probe = sc.execute("SELECT COUNT(*) FROM Signal").fetchone()[0]
    print(f"snapshot: {max_id_probe} signals, max serial {max_serial}")

    donors = dc.execute(
        "SELECT * FROM Signal WHERE createdAt > ? ORDER BY createdAt, serial", (CUTOFF_UTC,)
    ).fetchall()
    print(f"donor signals created after restore cutoff: {len(donors)}")

    id_map, new_serial = {}, max_serial
    for row in donors:
        d = dict(zip(donor_cols, row))
        new_serial += 1
        new_id = cuid()
        id_map[d["id"]] = new_id
        common = [c for c in donor_cols if c in snap_cols and c != "id" and c != "serial"]
        vals = {c: d[c] for c in common}
        analysis = vals.get("analysis") or ""
        vals["analysis"] = re.sub(r"^\[NX-\d+\]", f"[NX-{new_serial:04d}]", analysis, count=1)
        cols_sql = ", ".join(["id", "serial"] + common)
        ph = ", ".join(["?"] * (2 + len(common)))
        sc.execute(
            f"INSERT INTO Signal ({cols_sql}) VALUES ({ph})",
            [new_id, new_serial] + [vals[c] for c in common],
        )
        print(f"  serial {d['serial']} {d['symbol']} {d['status']} -> serial {new_serial} ({new_id[:10]}..)")

    # migrate SignalEvent rows tied to donor signals
    ev_moved = 0
    for old_id, new_id in id_map.items():
        rows = dc.execute(
            f"SELECT * FROM SignalEvent WHERE signalId = ? ORDER BY createdAt", (old_id,)
        ).fetchall()
        for r in rows:
            e = dict(zip(donor_ev_cols, r))
            common_ev = [c for c in donor_ev_cols if c in ev_cols and c != "id"]
            cols_sql = ", ".join(["id"] + common_ev)
            ph = ", ".join(["?"] * (1 + len(common_ev)))
            sc.execute(
                f"INSERT INTO SignalEvent ({cols_sql}) VALUES ({ph})",
                [cuid()] + [e[c] for c in common_ev],
            )
            ev_moved += 1

    # sanity + summary
    total = sc.execute("SELECT COUNT(*) FROM Signal").fetchone()[0]
    nser = sc.execute("SELECT MAX(serial) FROM Signal").fetchone()[0]
    active = sc.execute("SELECT serial, symbol, status FROM Signal WHERE status='ACTIVE' ORDER BY serial").fetchall()
    ev_total = sc.execute("SELECT COUNT(*) FROM SignalEvent").fetchone()[0]
    pp = sc.execute("SELECT COUNT(*) FROM PricePoint").fetchone()[0]
    print(f"\nRESTORED DB: signals={total} max_serial={nser} events={ev_total} (moved {ev_moved}) pricePoints={pp}")
    print("ACTIVE:", active)
    # duplicate serial check
    dup = sc.execute("SELECT serial, COUNT(*) c FROM Signal GROUP BY serial HAVING c > 1").fetchall()
    print("duplicate serials:", dup if dup else "none")
    snap.commit(); snap.close(); donor.close()
    print("OK ->", OUT)

if __name__ == "__main__":
    main()
