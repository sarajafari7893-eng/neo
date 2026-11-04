#!/usr/bin/env python3
# VERDICT-CORE audit v2 — chronological merge, hourly histograms, study-window replay.
import json, os, time

DATA = "/home/z/my-project/.data"
MAIN = os.path.join(DATA, "gate-journal.jsonl")
OLD = MAIN + ".old"

now_ms = time.time() * 1000

def load(path):
    out = []
    if not os.path.exists(path):
        return out, 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            out.append(rec)
    st = os.stat(path)
    return out, st

recs_main, st_main = load(MAIN)
recs_old, st_old = load(OLD)

print(f"MAIN: {len(recs_main)} lines, {st_main.st_size/1e6:.2f}MB, mtime {time.strftime('%m-%d %H:%M:%S', time.gmtime(st_main.st_mtime))}Z (age {int((now_ms-st_main.st_mtime*1000)/60000)}m)")
if st_old:
    print(f"OLD : {len(recs_old)} lines, {st_old.st_size/1e6:.2f}MB, mtime {time.strftime('%m-%d %H:%M:%S', time.gmtime(st_old.st_mtime))}Z")

allr = recs_old + recs_main  # chronological: .old is the rotated predecessor
S = [r["v"] for r in allr if r.get("k") == "s"]
B = [r["v"] for r in allr if r.get("k") == "b"]
D = [r["v"] for r in allr if r.get("k") == "d"]
S.sort(key=lambda x: x.get("at", 0)); B.sort(key=lambda x: x.get("at", 0)); D.sort(key=lambda x: x.get("at", 0))

fmt = lambda t: time.strftime('%m-%d %H:%M', time.gmtime(t/1000))
print(f"merged span: samples {fmt(S[0]['at'])} -> {fmt(S[-1]['at'])} | blocks {fmt(B[0]['at'])} -> {fmt(B[-1]['at'])} | last sample age {int((now_ms-S[-1]['at'])/60000)}m, last block age {int((now_ms-B[-1]['at'])/60000)}m")

# RAW (no dedup) hourly histogram, last 36h, blocks by gate
print("=== RAW blocks/hour (36h, no dedup) ===")
h0 = int((now_ms - 36*3600e3) / 3600e3)
hist = {}
for b in B:
    h = int(b.get("at", 0) / 3600e3)
    if h < h0:
        continue
    hist.setdefault(h, {}).setdefault(b.get("gate", "?"), 0)
    hist[h][b.get("gate", "?")] += 1
for h in sorted(hist):
    row = hist[h]
    top = " ".join(f"{g}:{n}" for g, n in sorted(row.items(), key=lambda kv: -kv[1])[:4])
    print(f"  {time.strftime('%m-%d %H', time.gmtime(h*3600))}Z  total={sum(row.values()):4d}  {top}")

# RAW REGIME + MEMORY count in the STUDY window (10:08 -> 22:08 UTC 11-04) vs my window
def win_count(arr, t0, t1, gate=None):
    return sum(1 for x in arr if t0 <= x.get("at", 0) < t1 and (gate is None or x.get("gate") == gate))

study_t0 = time.mktime(time.strptime("2026-11-04 10:08:00", "%Y-%m-%d %H:%M:%S")) - time.timezone
study_t0 *= 1000
study_t1 = study_t0 + 12 * 3600e3
print(f"=== STUDY WINDOW {fmt(study_t0)} -> {fmt(study_t1)} UTC (raw, no dedup) ===")
print(f"  REGIME raw={win_count(B, study_t0, study_t1, 'REGIME')}  MEMORY raw={win_count(B, study_t0, study_t1, 'MEMORY')}  all-blocks raw={win_count(B, study_t0, study_t1)}")
sb = [s for s in S if study_t0 <= s.get("at", 0) < study_t1 and s.get("band") == "BOUNDARY"]
print(f"  BOUNDARY raw={len(sb)} avgGap={round(sum(s['gap'] for s in sb)/len(sb),2) if sb else None}")

# distinct gate|symbol keys for REGIME in study window
keys = set()
for b in B:
    if study_t0 <= b.get("at", 0) < study_t1 and b.get("gate") == "REGIME":
        keys.add(b.get("symbol") or "*")
print(f"  REGIME distinct symbols: {len(keys)}: {sorted(keys)[:10]}")

# single-pass dedup replay over merged stream (engine semantics)
last_accepted = {}
acc_b = []
for b in B:
    key = f"{b.get('gate')}|{b.get('symbol') or '*'}"
    if b.get("at", 0) - last_accepted.get(key, 0) < 120_000:
        continue
    last_accepted[key] = b.get("at", 0)
    acc_b.append(b)
print(f"=== dedup-replayed blocks in study window ===")
print(f"  REGIME={win_count(acc_b, study_t0, study_t1, 'REGIME')} MEMORY={win_count(acc_b, study_t0, study_t1, 'MEMORY')} all={win_count(acc_b, study_t0, study_t1)}")

# boundary files around the study moment — PUMP/ZEC evidence
print("=== PUMP/ZEC BOUNDARY (study window, raw) ===")
seen = set()
for s in sorted(sb, key=lambda x: -x.get("at", 0)):
    k = (s["symbol"], s["direction"])
    if k in seen:
        continue
    seen.add(k)
    thr = " ".join(f"{kk}:{vv:+g}" for kk, vv in s.get("thr", {}).items() if vv) or "none"
    conf = ",".join(f"{f['factor']}{f['vote']:+g}" for f in s.get("confirms", [])) or "n/a"
    opp = ",".join(f"{f['factor']}{f['vote']:+g}" for f in s.get("opposes", [])) or "n/a"
    print(f"  {fmt(s['at'])} {s['symbol']} {s['direction']} {s['strategy']} score {s['score']:.1f} eff {s['effMin']} gap {s['gap']:+.1f} | thr {thr} | conf {conf} | opp {opp}")

macd = [s for s in sb if any("MACD" in f.get("factor", "").upper() for f in s.get("opposes", []))]
pump = [s for s in sb if s["symbol"] == "PUMPUSDT"]
print(f"boundary raw={len(sb)} | MACD-in-opposes={len(macd)} | PUMPUSDT={len(pump)}")
