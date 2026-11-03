#!/usr/bin/env python3
# ── NEXUS//SIGNALS — SIGNAL-DELAY PROBE (P2.8 ring, v14.2 restore) ──────────
# Recreated 2026-11-04 after sandbox rollback (original lost; contract from
# mandate trace 1a1a15fb6bc0bd75). READ-ONLY telemetry, fail-open: any error
# prints OK-line and exits 0 — must never block the watchdog cycle.
#
# Monitors the two-layer delay chain found on 2026-11-03:
#   stage1 (engine): FillLedger.latencyMs = createdAt − detectedAt (radar path)
#   stage2 (bridge): state.json intents lat.detectMs (card-detect gaps)
#   stage3 (LIVE  ): 24h closed Signal quality (TP-family share)
# Writes .data/p0-watchdog/signal-delay-ring.json (atomic tmp+rename).
# Output: "SIGNAL-DELAY OK — ..." or "SIGNAL-DELAY ALERT — ..." (watchdog logs ALERT).
import json
import os
import sqlite3
import time

PROJECT = "/home/z/my-project"
DB = os.path.join(PROJECT, "db", "custom.db")
STATE = os.path.join(PROJECT, ".data", "toobit-bridge", "state.json")
RING = os.path.join(PROJECT, ".data", "p0-watchdog", "signal-delay-ring.json")

DAY_MS = 86_400_000
ENTRY_AGE_MS = 90_000          # bridge maxEntryAgeMs — the SKIP window
ENGINE_AVG_ALERT_MS = 120_000  # v14.2 threshold (first alert fired at avg 529s)
ENGINE_LATE_ALERT_N = 10       # >90s fills per 24h
BRIDGE_MAX_ALERT_MS = 120_000  # detect gap beyond the 90s window = SKIP territory
TP_SHARE_ALERT = 20            # % of TP-family among ≥5 closed in 24h


def fail_open(msg: str) -> None:
    print(f"SIGNAL-DELAY OK — probe degraded (fail-open): {msg}")
    raise SystemExit(0)


def main() -> None:
    now_ms = int(time.time() * 1000)
    since = now_ms - DAY_MS
    out: dict = {"ts": now_ms, "stage1": None, "stage2": None, "stage3": None}

    # ── stage1: engine radar latency (FillLedger, 24h) ──
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=3)
    try:
        rows = con.execute(
            "SELECT latencyMs, symbol FROM FillLedger "
            "WHERE createdAt >= ? AND latencyMs IS NOT NULL",
            (since,),
        ).fetchall()
    finally:
        con.close()
    lat = [r[0] for r in rows]
    stage1 = {
        "n": len(lat),
        "avgMs": int(sum(lat) / len(lat)) if lat else 0,
        "maxMs": max(lat) if lat else 0,
        "over90s": sum(1 for v in lat if v > ENTRY_AGE_MS),
        "worst": max(rows, key=lambda r: r[0])[1] if rows else None,
    }
    out["stage1"] = stage1

    # ── stage2: bridge detect gaps (state.json intents, 24h) ──
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            intents = (json.load(f) or {}).get("intents", {}) or {}
        det = [
            (v.get("lat") or {}).get("detectMs")
            for v in intents.values()
            if (v.get("createdAt0") or 0) >= since
        ]
        det = [d for d in det if isinstance(d, (int, float))]
        stage2 = {
            "n": len(det),
            "maxMs": int(max(det)) if det else 0,
            "over90s": sum(1 for v in det if v > ENTRY_AGE_MS),
        }
    except Exception as e:  # bridge state unreadable → stage2 blind, not fatal
        stage2 = {"n": 0, "maxMs": 0, "over90s": 0, "err": str(e)[:80]}
    out["stage2"] = stage2

    # ── stage3: LIVE close quality (Signal, 24h) ──
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=3)
    try:
        rows = con.execute(
            "SELECT status, COUNT(*) FROM Signal "
            "WHERE createdAt >= ? AND status != 'ACTIVE' GROUP BY status",
            (since,),
        ).fetchall()
    finally:
        con.close()
    closed = sum(n for _, n in rows)
    tp = sum(n for s, n in rows if s.startswith("TP"))
    stage3 = {
        "closed24h": closed,
        "tpFamily": tp,
        "tpSharePct": round(100 * tp / closed) if closed else None,
        "byStatus": {s: n for s, n in rows},
    }
    out["stage3"] = stage3

    # ── verdict ──
    alerts = []
    if stage1["n"] and stage1["avgMs"] > ENGINE_AVG_ALERT_MS:
        alerts.append(f"ENGINE-DELAY avg={stage1['avgMs'] / 1000:.0f}s n={stage1['n']} over90s={stage1['over90s']}")
    if stage1["over90s"] > ENGINE_LATE_ALERT_N:
        alerts.append(f"ENGINE-LATE n>90s={stage1['over90s']}")
    if stage2["maxMs"] > BRIDGE_MAX_ALERT_MS:
        alerts.append(f"BRIDGE-DETECT max={stage2['maxMs'] / 1000:.0f}s over90s={stage2['over90s']}")
    if stage3["closed24h"] and stage3["tpSharePct"] is not None and stage3["tpSharePct"] < TP_SHARE_ALERT:
        alerts.append(f"LIVE-QUALITY tp={stage3['tpSharePct']}% closed={stage3['closed24h']}")

    tmp = RING + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    os.replace(tmp, RING)

    if alerts:
        print("SIGNAL-DELAY ALERT — " + " | ".join(alerts))
    else:
        print(
            "SIGNAL-DELAY OK — "
            f"engine avg={stage1['avgMs'] / 1000:.0f}s(n={stage1['n']}) "
            f"bridge max={stage2['maxMs'] / 1000:.0f}s "
            f"live24h={stage3['closed24h']} tp={stage3['tpSharePct']}%"
        )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # fail-open contract
        fail_open(repr(e)[:160])
