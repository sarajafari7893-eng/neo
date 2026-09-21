#!/usr/bin/env python3
"""Operator review analysis (2026-09-14): 250+ settled signals counterfactual study.
Q1: best config for higher PNL — TP depth, TTL, leverage, timing (TP DEPTH x DEEP-LEARN).
Read-only. Output: JSON to download/ + concise stdout summary."""
import sqlite3, json, statistics
from collections import defaultdict

DB = 'file:/home/z/my-project/db/custom.db?mode=ro'
TEHRAN_OFFSET_MS = 3*3600*1000 + 30*60*1000

con = sqlite3.connect(DB, uri=True)
con.row_factory = sqlite3.Row
cur = con.cursor()

cols = "id,serial,symbol,direction,entryPrice,tp1,tp2,tp3,stopLoss,initialStopLoss,leverage,marginUsd,confidence,riskReward,strategy,status,reachedTp,pnlPercent,maxPnlPercent,maxPostPnlPercent,ttlMinutes,ttlExtensions,feeUsd,createdAt,expiresAt,closedAt"
rows = [dict(r) for r in cur.execute(f"SELECT {cols} FROM Signal").fetchall()]
pp_span = cur.execute("SELECT MIN(createdAt), MAX(createdAt) FROM PricePoint").fetchone()
PP_START, PP_END = pp_span[0], pp_span[1]

price_cache = {}
def series_for(sym):
    if sym not in price_cache:
        rs = cur.execute("SELECT createdAt t, price p FROM PricePoint WHERE symbol=? ORDER BY createdAt", (sym,)).fetchall()
        price_cache[sym] = [(r['t'], r['p']) for r in rs]
    return price_cache[sym]

def touched(series, t0, t1, level, direction):
    """first time price crosses level in favor; returns (t, price) or None"""
    for (t, p) in series:
        if t < t0: continue
        if t > t1: break
        if direction == 'LONG' and p >= level: return (t, p)
        if direction == 'SHORT' and p <= level: return (t, p)
    return None

def adverse_before(series, t0, t_sl, direction, t_limit):
    for (t, p) in series:
        if t < t0: continue
        if t > t_limit: break
        if direction == 'LONG' and p <= t_sl: return t
        if direction == 'SHORT' and p >= t_sl: return t
    return None

settled = [r for r in rows if r['status'] in ('EXPIRED','SL','TP3')]
def pnl_usd(r): return (r['marginUsd'] or 0)*(r['pnlPercent'] or 0)/100.0 - (r['feeUsd'] or 0)

def agg(sub, label, out):
    n = len(sub)
    if not n: return
    wins = [r for r in sub if (r['pnlPercent'] or 0) > 0.5]
    tp3 = [r for r in sub if r['status']=='TP3']
    tot = sum(pnl_usd(r) for r in sub)
    out[label] = {'n': n, 'winRatePct': round(100*len(wins)/n,1), 'tp3': len(tp3),
                  'avgPnlPct': round(statistics.mean(r['pnlPercent'] or 0 for r in sub),2),
                  'sumUsd': round(tot,2), 'avgUsd': round(tot/n,3)}

out = {'generatedAt': '2026-09-14T10:00Z', 'ppSpanH': round((PP_END-PP_START)/3600000,1), 'blocks': {}}
B = out['blocks']
agg(settled, 'ALL_SETTLED', B)
for s in ('EXPIRED','SL','TP3'): agg([r for r in settled if r['status']==s], f'STATUS_{s}', B)
for st in ('AI-SWING','AI-SCALP','MEAN-REVERT','BREAKOUT','MOMENTUM'):
    agg([r for r in settled if r['strategy']==st], f'STRAT_{st}', B)
for lo,hi,name in ((5,9,'LEV_5_9'),(10,15,'LEV_10_15'),(16,20,'LEV_16_20')):
    agg([r for r in settled if lo <= (r['leverage'] or 0) <= hi], name, B)
for lo,hi,name in ((0,90,'TTL_60_90'),(91,150,'TTL_91_150'),(151,400,'TTL_150_PLUS')):
    agg([r for r in settled if lo <= (r['ttlMinutes'] or 0) <= hi], name, B)
for d in ('LONG','SHORT'): agg([r for r in settled if r['direction']==d], f'DIR_{d}', B)

# hour-of-day (Tehran)
hour = defaultdict(list)
for r in settled:
    h = ((r['createdAt'] + TEHRAN_OFFSET_MS)//3600000) % 24
    hour[h].append(r)
hh = {}
for h in sorted(hour):
    sub = hour[h]; tot = sum(pnl_usd(r) for r in sub)
    hh[f'{h:02d}'] = {'n': len(sub), 'winRatePct': round(100*sum(1 for r in sub if (r['pnlPercent'] or 0)>0.5)/len(sub),1),
                      'avgPnlPct': round(statistics.mean(r['pnlPercent'] or 0 for r in sub),2), 'sumUsd': round(tot,2)}
B['HOUR_TEHRAN'] = hh

# symbol concentration
sym = defaultdict(lambda: [0,0.0])
for r in settled:
    sym[r['symbol']][0] += 1; sym[r['symbol']][1] += pnl_usd(r)
B['TOP_SYMBOLS_USD'] = sorted(((v[1], k, v[0]) for k,v in sym.items()), key=lambda x: x[0])[:6] + sorted(((v[1], k, v[0]) for k,v in sym.items()), key=lambda x: -x[0])[:4]

# ---- PricePoint-based counterfactuals (window-restricted) ----
recent = [r for r in rows if r['createdAt'] >= PP_START]
LADDER = (0.4, 0.3, 0.3)  # TP1/TP2/TP3 tranche assumption

def ladder_eval(r, tps, end_t):
    """replay signal against price series with custom TP levels (price distances scaled), same SL.
    returns dict(status, pnlPct) — tranche ladder, SL on remainder, else mark at end (EXPIRED ~ last pnl)."""
    s = series_for(r['symbol']); t0 = r['createdAt']
    sl = r['initialStopLoss'] or r['stopLoss']; d = r['direction']
    done = [False]*3; fill = [0.0]*3; exitp = [None]*3; sl_t = None
    sl_hit = adverse_before(s, t0, sl, d, end_t)
    for i, tp in enumerate(tps):
        hit = touched(s, t0, end_t, tp, d)
        if hit and (not sl_hit or hit[0] <= sl_hit):
            done[i] = True; exitp[i] = hit[0]
    if sl_hit:
        # only TPs touched strictly before SL count
        for i in range(3):
            if exitp[i] is not None and exitp[i] > sl_hit: done[i] = False; exitp[i] = None
    sign = 1 if d=='LONG' else -1
    lev = r['leverage']; entry = r['entryPrice']
    pnl = 0.0; rem = 1.0
    for i in range(3):
        if done[i]:
            pm = (tps[i]-entry)/entry*sign*100
            pnl += LADDER[i]*pm*lev; rem -= LADDER[i]
    if rem > 1e-9:
        if sl_hit:
            pm = (sl-entry)/entry*sign*100; pnl += rem*pm*lev
            st = 'SL' if not any(done) else 'SL-PART'
        else:
            # expire: mark at last price in window
            lastp = None
            for (t,p) in s:
                if t > end_t: break
                lastp = p
            if lastp is None: return None
            pm = (lastp-entry)/entry*sign*100
            pnl += rem*pm*lev; st = 'EXPIRED'
    else:
        st = 'TP3'
    if st=='TP3' or all(done): st='TP3'
    return {'status': st, 'pnlPct': pnl, 'touched': sum(done), 'slHit': bool(sl_hit)}

cf = {'n': 0, 'actual': 0.0, 'tp1only': 0.0, 'tp2only': 0.0, 'ladder': 0.0,
      'tp1wins': 0, 'ladder_wins': 0, 'ladder_wins_actual': 0, 'deep_tp3only': 0.0,
      'ttl60_extra_tp1': 0, 'ttl60_pnl': 0.0, 'ttl120_extra_tp1': 0, 'ttl120_pnl': 0.0,
      'expired_n': 0, 'expired_would_tp1_60': 0, 'expired_would_tp1_120': 0}
t2tp1 = []
for r in recent:
    if r['status'] not in ('EXPIRED','SL','TP3'): continue
    s = series_for(r['symbol'])
    if not s: continue
    entry = r['entryPrice']; d = r['direction']
    dist1 = abs(r['tp1']-entry)/entry if r['tp1'] else None
    if not dist1: continue
    end_t = r['closedAt'] or r['expiresAt']
    a1 = ladder_eval(r, [r['tp1']]*3, end_t)               # all-in at TP1
    a2 = ladder_eval(r, [r['tp2'] or r['tp1']]*3, end_t)   # all-in at TP2
    aL = ladder_eval(r, [r['tp1'], r['tp2'], r['tp3']], end_t)  # 40/30/30 ladder
    aD = ladder_eval(r, [r['tp3']]*3, end_t)               # all-in at TP3 (deep)
    if not aL: continue
    cf['n'] += 1
    cf['actual'] += pnl_usd(r)
    cf['tp1only'] += a1['pnlPct']/100*(r['marginUsd'] or 0) - (r['feeUsd'] or 0)
    cf['tp2only'] += a2['pnlPct']/100*(r['marginUsd'] or 0) - (r['feeUsd'] or 0)
    cf['ladder']  += aL['pnlPct']/100*(r['marginUsd'] or 0) - (r['feeUsd'] or 0)
    cf['deep_tp3only'] += aD['pnlPct']/100*(r['marginUsd'] or 0) - (r['feeUsd'] or 0)
    if a1['pnlPct'] > 0.5: cf['tp1wins'] += 1
    if aL['pnlPct'] > 0.5: cf['ladder_wins'] += 1
    if (r['pnlPercent'] or 0) > 0.5: cf['ladder_wins_actual'] += 1
    # time to TP1 (actual distance) for winners
    hit1 = touched(s, r['createdAt'], end_t, r['tp1'], d)
    if hit1: t2tp1.append((hit1[0]-r['createdAt'])/60000.0)
    # TTL counterfactual on EXPIRED
    if r['status'] == 'EXPIRED':
        cf['expired_n'] += 1
        for extra, key1, keyp in ((60,'ttl60_extra_tp1','ttl60_pnl'), (120,'ttl120_extra_tp1','ttl120_pnl')):
            hit_e = touched(s, r['expiresAt'], r['expiresAt']+extra*60000, r['tp1'], d)
            if hit_e:
                cf[key1] += 1
                pm = dist1*100*sign if False else (r['tp1']-entry)/entry*(1 if d=='LONG' else -1)*100
                cf[keyp] += (pm*r['leverage'])/100*(r['marginUsd'] or 0) - (r['feeUsd'] or 0)
B['CF_PRICE_REPLAY'] = {k: (round(v,2) if isinstance(v,float) else v) for k,v in cf.items()}
if t2tp1:
    t2tp1.sort()
    B['TIME_TO_TP1_MIN'] = {'n': len(t2tp1), 'p50': round(t2tp1[len(t2tp1)//2],1),
                            'p75': round(t2tp1[int(len(t2tp1)*0.75)],1), 'p90': round(t2tp1[int(len(t2tp1)*0.9)],1)}

# ---- equity curves / leverage sizing CF (whole settled book) ----
base = [pnl_usd(r) for r in settled]
def curve(xs):
    eq, peak, mdd = 100.0, 100.0, 0.0
    for x in xs:
        eq += x; peak = max(peak, eq); mdd = max(mdd, peak-eq)
    return round(eq,2), round(mdd,2)
B['EQUITY'] = {
  'actual_risk1x': curve(base),
  'half_risk0.5x': curve([x*0.5 for x in base]),
  'double_risk2x': curve([x*2 for x in base]),
}

# leverage bucket avg price-move (de-leveraged) sanity
pm = defaultdict(list)
for r in settled:
    lev = r['leverage'] or 1
    pm[('LEV_5_9' if 5<=lev<=9 else 'LEV_10_15' if 10<=lev<=15 else 'LEV_16_20')].append((r['pnlPercent'] or 0)/lev)
B['DELEVERAGED_AVG_PCT'] = {k: round(statistics.mean(v),3) for k,v in pm.items() if v}

# deep-learn lesson quote
dl = cur.execute("SELECT value FROM EngineSetting WHERE key='deep-learn'").fetchone()
out['deepLearnLesson'] = json.loads(dl[0])['lessons'][0] if dl else None
reg = cur.execute("SELECT value FROM EngineSetting WHERE key='regime.telemetry'").fetchone()
out['regimeTelemetry'] = json.loads(reg[0]) if reg else None

with open('/home/z/my-project/download/nexus-signal-analysis-20260914.json','w') as f:
    json.dump(out, f, ensure_ascii=False, indent=1, default=str)

print(json.dumps(out['blocks'], ensure_ascii=False, indent=1, default=str))
print('LESSON:', json.dumps(out['deepLearnLesson'], ensure_ascii=False)[:400])
print('REGIME:', json.dumps(out['regimeTelemetry'], ensure_ascii=False)[:400])
