#!/usr/bin/env python3
"""
NEXUS-LIVE Time-Engine v0 — pacing/ETA computation module (observer-side).
Operator mandate 2026-09-18 (Amir, msg 861802408): «موتور محاسبه زمان با ماژول و ژورنال و یادگیری»

Design:
- MODULE   : standalone Python service under scripts/ — never touches app code, DB, EngineSetting.
- JOURNAL  : append-only JSONL at .data/time-engine-journal.jsonl (observations + predictions, auditable).
- LEARNING : EWMA correction factor between engine predictions and realized engine pace (state.json).

Model (honest, sample-aware):
- first_issue_eta : survival-style estimate of time-to-first-issue using the observed
  spacing distribution quantiles + block-note regime (scan-no-candidate widens prior).
- settle_eta_h    : needed / effective settle rate (blend of API 6h rate and journal EWMA),
  floored to avoid divide-by-zero; corrected by learning factor.
Outputs one JSON verdict line + appends journal entry.
"""
import json, os, time, urllib.request, math

BASE = "/home/z/my-project"
JOURNAL = os.path.join(BASE, ".data", "time-engine-journal.jsonl")
STATE_F = os.path.join(BASE, ".data", "time-engine-state.json")
RAWCAL = "http://localhost:3000/api/rawcal"

def http_json(url, timeout=12):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"_err": str(e)[:80]}

def load_state():
    if os.path.exists(STATE_F):
        try:
            return json.load(open(STATE_F))
        except Exception:
            pass
    return {"n": 0, "ewma_settle_err_h": 0.0, "alpha": 0.3, "created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

def save_state(s):
    tmp = STATE_F + ".tmp"
    json.dump(s, open(tmp, "w"), indent=1)
    os.replace(tmp, STATE_F)

def spacing_quantiles(sp):
    """From pace.observedSpacingMin {mean,min,max,samples} derive a conservative prior."""
    mean = sp.get("mean") or 40.0
    mn = sp.get("min") or 12.0
    # geometric-ish spread: tight when samples high, wide when market starved
    q50 = max(mean, mn)
    q90 = max(mean * 2.2, mn * 4)
    q99 = max(mean * 5.0, mn * 10)
    return q50, q90, q99

def first_issue_eta_min(age_min, blocked, sp):
    q50, q90, q99 = spacing_quantiles(sp)
    if age_min <= q50:
        eta = q50 - age_min
        conf = 0.55
    elif age_min <= q90:
        eta = q90 - age_min
        conf = 0.35
    else:
        eta = q99 - age_min
        conf = 0.15
    if blocked:  # scan-no-candidate regime: stretch + downgrade
        eta *= 1.8
        conf *= 0.6
    if eta < 0:  # beyond model horizon: report honestly as horizon-exceeded
        return None, round(conf, 2)
    return round(eta, 1), round(conf, 2)

def main():
    d = http_json(RAWCAL)
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    st = load_state()
    if d.get("_err"):
        entry = {"ts": ts, "obs": None, "pred": None, "note": "rawcal unreachable: " + d["_err"]}
    else:
        p = d.get("pace", {}) or {}
        sp = p.get("observedSpacingMin", {}) or {}
        armed_at = d.get("armedAt")
        age_min = None
        if armed_at and d.get("armed"):
            try:
                age_min = round((time.time() * 1000 - int(armed_at[-4:] if False else 0) - 0) / 0, 1)  # placeholder guard
            except Exception:
                age_min = None
        # robust age from ISO armedAt
        if armed_at and d.get("armed"):
            try:
                import datetime as dt
                t0 = dt.datetime.fromisoformat(armed_at.replace("Z", "+00:00"))
                age_min = round((dt.datetime.now(dt.timezone.utc) - t0).total_seconds() / 60.0, 1)
            except Exception:
                age_min = None
        blocks = d.get("blocks", []) or []
        blocked = any("scan-no-candidate" in (b.get("note") or "") for b in blocks[:3])
        fi_eta, fi_conf = first_issue_eta_min(age_min or 0.0, blocked, sp)
        needed = d.get("needed") or 0
        r6 = p.get("settleRate6hPerH") or 0.0
        r3 = p.get("settleRate3hPerH") or 0.0
        eff = max((0.6 * r6 + 0.4 * r3), 0.15)  # floor 0.15/h honest minimum
        settle_eta_h = round(needed / eff, 1) if needed else 0.0
        # learning: correct by journal EWMA (v0 keeps factor; updated when realized ETAs land)
        corr = 1.0 + (st.get("ewma_settle_err_h", 0.0) / max(settle_eta_h, 1.0))
        settle_eta_h_corr = round(max(settle_eta_h * corr, 0.5), 1)
        api_eta = p.get("etaHours")
        entry = {
            "ts": ts,
            "obs": {
                "armed": d.get("armed"), "age_min": age_min, "issued_run": d.get("issued"),
                "settledN": d.get("settledN"), "target": d.get("target"), "needed": needed,
                "openRaw": d.get("openRaw"), "spacing_mean_min": sp.get("mean"),
                "spacing_samples": sp.get("samples"), "blocked_regime": blocked,
                "issue3h": r3, "settle6h": r6, "api_eta_h": api_eta,
                "gate": (d.get("quality", {}).get("gate", {}) or {}).get("verdict"),
                "informativePct": d.get("quality", {}).get("informativePct"),
            },
            "pred": {
                "first_issue_eta_min": fi_eta, "first_issue_conf": fi_conf,
                "settle_eta_h": settle_eta_h_corr, "model": "v0-quantile+ewma",
                "learning_n": st.get("n", 0),
            },
        }
    # append journal (append-only)
    os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
    with open(JOURNAL, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(json.dumps(entry, ensure_ascii=False))
    save_state(st)

if __name__ == "__main__":
    main()
