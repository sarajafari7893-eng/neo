#!/usr/bin/env python3
# VERDICT-CORE study audit — read-only recomputation from the raw gate journal.
# Mirrors gate-journal.ts ring semantics: dedup windows per band/block, caps.
import json, os, time

DATA = "/home/z/my-project/.data"
FILES = [os.path.join(DATA, "gate-journal.jsonl"), os.path.join(DATA, "gate-journal.jsonl.old")]

samples, blocks, deploys = [], [], []
raw = {"s": 0, "b": 0, "d": 0}
last_acc = {}

def load(path):
    if not os.path.exists(path):
        return 0
    n = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            k = rec.get("k")
            if k not in raw:
                continue
            raw[k] += 1
            n += 1
            v = rec.get("v", {})
            if k == "s":
                samples.append(v)
            elif k == "b":
                blocks.append(v)
            elif k == "d":
                deploys.append(v)
    return n

total_lines = sum(load(p) for p in FILES)

now_ms = time.time() * 1000
W12 = now_ms - 12 * 3600 * 1000

# ring semantics
SAMPLE_CAP, BLOCK_CAP, DEPLOY_CAP = 8000, 800, 300
BOUNDARY_DEDUP, REJECT_DEDUP, PASS_DEDUP, BLOCK_DEDUP = 60_000, 150_000, 60_000, 120_000

# emulate ring acceptance in append order (file order = append order)
acc_samples, acc_blocks, acc_deploys = [], [], []
last_accepted = {}
seen_serials = set()
for s in samples:
    key = f"{s.get('symbol')}|{s.get('direction')}|{s.get('band')}"
    iv = BOUNDARY_DEDUP if s.get("band") == "BOUNDARY" else REJECT_DEDUP if s.get("band") == "REJECT" else PASS_DEDUP
    last = last_accepted.get(key, 0)
    if iv and s.get("at", 0) - last < iv:
        continue
    last_accepted[key] = s.get("at", 0)
    acc_samples.append(s)
for b in blocks:
    key = f"{b.get('gate')}|{b.get('symbol') or '*'}"
    if b.get("at", 0) - last_accepted.get(key, 0) < BLOCK_DEDUP:
        continue
    last_accepted[key] = b.get("at", 0)
    acc_blocks.append(b)
for d in deploys:
    ser = d.get("serial", 0)
    if ser and ser in seen_serials:
        continue
    if ser:
        seen_serials.add(ser)
    acc_deploys.append(d)

# apply caps (ring keeps newest N)
acc_samples = acc_samples[-SAMPLE_CAP:]
acc_blocks = acc_blocks[-BLOCK_CAP:]
acc_deploys = acc_deploys[-DEPLOY_CAP:]

win = [s for s in acc_samples if s.get("at", 0) >= W12]
by_band = {"PASS": 0, "BOUNDARY": 0, "REJECT": 0}
for s in win:
    by_band[s.get("band", "?")] = by_band.get(s.get("band", "?"), 0) + 1
bnd = [s for s in win if s.get("band") == "BOUNDARY"]
avg_gap = round(sum(s["gap"] for s in bnd) / len(bnd), 2) if bnd else None
worst = max((s["gap"] for s in bnd), default=None)

# blocks in window (from accepted ring)
blk = {}
for b in acc_blocks:
    if b.get("at", 0) >= W12:
        g = b.get("gate", "?")
        e = blk.setdefault(g, {"n": 0, "last": ""})
        e["n"] += 1
        e["last"] = b.get("reason", "")[:110]
blk_sorted = sorted(blk.items(), key=lambda kv: -kv[1]["n"])

dep_w = [d for d in acc_deploys if d.get("at", 0) >= W12]

print(f"=== RAW FILE LINES: {total_lines} (s={raw['s']} b={raw['b']} d={raw['d']}) ===")
if samples:
    print(f"journal span: {time.strftime('%m-%d %H:%M', time.gmtime(samples[0]['at']/1000))} -> {time.strftime('%m-%d %H:%M', time.gmtime(samples[-1]['at']/1000))} UTC (last sample age {int((now_ms-samples[-1]['at'])/60000)}m)")
if blocks:
    print(f"last block age: {int((now_ms-blocks[-1]['at'])/60000)}m")
print(f"=== 12h WINDOW (ring-emulated) ===")
print(f"samples={len(win)} byBand={by_band} deploys={len(dep_w)}")
print(f"boundary: n={len(bnd)} avgGap={avg_gap} worstGap={worst} share={round(100*len(bnd)/max(1,len(win)),1)}%")
print(f"=== BLOCKS (12h, accepted) ===")
for g, e in blk_sorted:
    print(f"  {g} x{e['n']}  last: {e['last']}")
print(f"=== BOUNDARY FILES (latest 8) ===")
for s in sorted(bnd, key=lambda x: -x.get("at", 0))[:8]:
    thr = " ".join(f"{k}{v:+d}" if isinstance(v, int) else f"{k}{v:+.1f}" for k, v in s.get("thr", {}).items() if v) or "none"
    conf = ",".join(f"{f['factor']}{f['vote']:+d}" for f in s.get("confirms", [])) or "n/a"
    opp = ",".join(f"{f['factor']}{f['vote']:+d}" for f in s.get("opposes", [])) or "n/a"
    t = time.strftime('%m-%d %H:%M', time.gmtime(s['at']/1000))
    print(f"  {t} {s['symbol']} {s['direction']} {s['strategy']} score {s['score']:.1f} eff {s['effMin']} gap {s['gap']:+.1f} | thr: {thr} | conf: {conf} | opp: {opp}")

# PUMPUSDT / ZECUSDT specific check (any band, 12h)
print(f"=== PUMP/ZEC BOUNDARY+REJECT (12h) ===")
for s in win:
    if s["symbol"] in ("PUMPUSDT", "ZECUSDT") and s.get("band") in ("BOUNDARY", "REJECT"):
        opp = ",".join(f"{f['factor']}{f['vote']:+d}" for f in s.get("opposes", [])) or "n/a"
        t = time.strftime('%m-%d %H:%M', time.gmtime(s['at']/1000))
        print(f"  {t} {s['symbol']} {s['direction']} {s['band']} gap {s['gap']:+.1f} opp: {opp}")

# MACD momentum presence among oppose votes in boundary band
macd = [s for s in bnd if any("MACD" in f.get("factor", "").upper() for f in s.get("opposes", []))]
print(f"=== MACD-in-opposes among BOUNDARY: {len(macd)}/{len(bnd)} ===")
