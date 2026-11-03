#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""v14.2 SIGNAL-DELAY ring probe (read-only) — the engineering execution of the
NX-3247 / LIVE-degradation investigation recommendations.

Measures the TWO delay stages found in forensics:
  stage-1 (engine): FillLedger.latencyMs = signal.createdAt - radar.detectedAt
  stage-2 (bridge): toobit-bridge state.json intents lat.detectMs
And the LIVE quality gate: closed signals 24h -> TP hits vs EXPIRED/SL.

Writes .data/p0-watchdog/signal-delay-ring.json (atomic tmp+rename).
Prints a single-line verdict for the watchdog to log/alert. Read-only: the
SQLite URI uses mode=ro; nothing here writes to the DB or trading code.
"""
import json, sqlite3, time, os, sys

PROJ = "/home/z/my-project"
OUT = os.path.join(PROJ, ".data/p0-watchdog/signal-delay-ring.json")
TMP = OUT + ".tmp"

def main():
    now_ms = int(time.time() * 1000)
    day_ago = now_ms - 86_400_000
    ring = {"ver": "signal-delay-ring v1.0 (watchdog v14.2)", "at": now_ms,
            "stage1_engine": None, "stage2_bridge": None, "live_quality": None,
            "verdict": "OK", "notes": []}

    # ── stage-1: engine detection→issuance latency (24h)
    try:
        con = sqlite3.connect(f"file:{PROJ}/db/custom.db?mode=ro", uri=True, timeout=3)
        cur = con.cursor()
        row = cur.execute(
            "SELECT COUNT(*), AVG(latencyMs), SUM(CASE WHEN latencyMs>90000 THEN 1 ELSE 0 END) "
            "FROM FillLedger WHERE createdAt >= ?", (day_ago,)).fetchone()
        if row and row[0]:
            ring["stage1_engine"] = {"n": row[0], "avgMs": int(row[1] or 0), "over90s": row[2] or 0}
            if row[0] >= 5 and (row[1] or 0) > 120_000:
                ring["notes"].append(f"ENGINE-DELAY avg={int(row[1]//1000)}s (n={row[0]}) — radar→signal window degraded")
        # LIVE quality: closed signals last 24h
        row2 = cur.execute(
            "SELECT COUNT(*), SUM(CASE WHEN reachedTp>0 THEN 1 ELSE 0 END), "
            "SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END), SUM(CASE WHEN status='SL' THEN 1 ELSE 0 END) "
            "FROM Signal WHERE createdAt >= ? AND status NOT IN ('OPEN','ACTIVE')", (day_ago,)).fetchone()
        if row2 and row2[0]:
            ring["live_quality"] = {"closed": row2[0], "tpHits": row2[1] or 0,
                                    "expired": row2[2] or 0, "sl": row2[3] or 0}
            if row2[0] >= 5 and not row2[1]:
                ring["notes"].append(f"LIVE-NO-TP: {row2[0]} closed/24h, 0 TP hits ({row2[2]} EXP/{row2[3]} SL)")
        con.close()
    except Exception as e:
        ring["notes"].append(f"db-probe-error: {type(e).__name__}")

    # ── stage-2: bridge detection latency (latest intents)
    try:
        sp = os.path.join(PROJ, ".data/toobit-bridge/state.json")
        with open(sp) as f:
            st = json.load(f)
        dms = [i.get("lat", {}).get("detectMs") for i in st.get("intents", {}).values()
               if isinstance(i.get("lat"), dict)]
        dms = [d for d in dms if isinstance(d, (int, float))]
        if dms:
            ring["stage2_bridge"] = {"intents": len(dms), "maxDetectMs": int(max(dms)),
                                     "over90s": sum(1 for d in dms if d > 90_000)}
            if max(dms) > 300_000:
                ring["notes"].append(f"BRIDGE-DETECT max={max(dms)//1000}s — poll gap/bridge-down window")
    except Exception as e:
        ring["notes"].append(f"bridge-probe-error: {type(e).__name__}")

    ring["verdict"] = "ALERT" if ring["notes"] else "OK"
    try:
        with open(TMP, "w") as f:
            json.dump(ring, f, ensure_ascii=False)
        os.replace(TMP, OUT)
    except Exception:
        pass
    print(f"SIGNAL-DELAY {ring['verdict']}" + ((" — " + " | ".join(ring["notes"])) if ring["notes"] else ""))
    return 0 if ring["verdict"] == "OK" else 0  # telemetry-only: never fails the cycle

if __name__ == "__main__":
    sys.exit(main())
