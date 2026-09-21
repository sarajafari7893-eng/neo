#!/bin/bash
# ── NEXUS-LIVE v10.11 — EVID-BUDGET RE-ARM (operator APPROVE 2026-09-17T19:35Z msg 861802406) ──
# Supervisor proposal EVID-BUDGET RE-ARM (terminal thought cmu5w2yh7, TG msg 3365):
#   the shadow-veto SEQ-STOP decision is issuance-starved (arms frozen keep 13 / veto 10,
#   min-n guard needs veto >= 12; arms sample at ISSUANCE time and the engine has been
#   disarmed since 2026-09-16T05:34Z). This re-arm is an EVIDENCE-COMPLETION run, not a
#   PnL run: sized +40 settled (target 480 -> 520) ~= 30-40 issues at the historical
#   25.6% observation rate -> veto min-n reachable + seq-boundary headroom.
# v10.11 machinery handles the terminal: SEQ-STOP exits early at the always-valid
#   boundary; COHORT-FREEZE auto-snapshots at decision grade (FILL or SEQ-STOP).
# Epoch policy: ARM_EPOCH stays E-20260915 — arms are rolling-30 (v10.10), epoch is a
#   regime tag, NOT the evidence window; rotating would add nothing and re-tag history.
# This is runtime STATE surgery (EngineSetting rawcal.state JSON), not code.
set -u
cd /home/z/my-project

echo "== [1/5] PRE-FLIGHT HEALTH =="
APP=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse)
echo "pulse:$APP"
[ "$APP" = "200" ] || { echo "ABORT: app not healthy"; exit 1; }

echo "== [2/5] RAW-CAL STATE BEFORE =="
S_BEFORE=$(curl -s -m 10 http://localhost:3000/api/rawcal)
echo "$S_BEFORE" | python3 -c "import json,sys; s=json.load(sys.stdin); print('armed:',s['armed'],'| settledN:',s['settledN'],'| target:',s['target'],'| issuedTotal:',s['issuedTotal'],'| openRaw:',s['openRaw'],'| maxOpen:',s['maxOpen'])"
ARMED=$(echo "$S_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin)['armed'])")
if echo "$ARMED" | grep -qi true; then echo "ABORT: already armed"; exit 1; fi

SETTLED=$(echo "$S_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin)['settledN'])")
NEW_TARGET=$((SETTLED + 40))
echo "evidence budget: settledN $SETTLED + 40 -> target $NEW_TARGET (auto-lift at book growth +40)"

echo "== [3/5] STATE SURGERY: target -> $NEW_TARGET =="
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('db/custom.db');
const row = db.query(\"SELECT value FROM EngineSetting WHERE key='rawcal.state'\").get();
if (!row) { console.error('ABORT: rawcal.state not found'); process.exit(1); }
const st = JSON.parse(row.value);
if (st.armed) { console.error('ABORT: race — state now armed'); process.exit(1); }
const before = st.target;
st.target = Number(process.argv[1]);
st.retargetNote = 'EVID-BUDGET RE-ARM (operator APPROVE 2026-09-17T19:35Z msg 861802406): run sized +40 settled to reach shadow-veto decision grade (veto min-n 12, have 10) + seq-boundary headroom; EVIDENCE-COMPLETION run, not PnL; epoch stays E-20260915 (rolling-30)';
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
const chk = JSON.parse(db.query(\"SELECT value FROM EngineSetting WHERE key='rawcal.state'\").get().value);
console.log('target:', before, '->', chk.target, '| verify-readback:', chk.target === Number(process.argv[1]) ? 'OK' : 'FAIL');
db.close();
" "$NEW_TARGET" || { echo "ABORT: state surgery failed"; exit 1; }

echo "== [4/5] ARM =="
# (task 4-b) control gate: mutating app APIs require x-nexus-key (audit P0-1); never printed
NEXUS_KEY="${NEXUS_CONTROL_KEY:-}"
[ -z "$NEXUS_KEY" ] && NEXUS_KEY=$(grep '^NEXUS_CONTROL_KEY=' /home/z/my-project/.env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')
ARM_RES=$(curl -s -m 20 -X POST http://localhost:3000/api/rawcal -H 'content-type: application/json' -H "x-nexus-key: $NEXUS_KEY" -d '{"action":"arm"}')
echo "$ARM_RES" | python3 -c "import json,sys; s=json.load(sys.stdin); st=s.get('state',s); print('armed:',st.get('armed'),'| armedAt:',st.get('armedAt'),'| target:',st.get('target'))" 2>/dev/null || echo "raw: $ARM_RES"

echo "== [5/5] ATTRIBUTION PATCH =="
sleep 2
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('db/custom.db');
const row = db.query(\"SELECT value FROM EngineSetting WHERE key='rawcal.state'\").get();
const st = JSON.parse(row.value);
if (!st.armed) { console.error('WARN: state shows disarmed?!'); process.exit(1); }
st.armedBy = 'NEXUS-SUPERVISED (EVID-BUDGET RE-ARM E-20260918 — operator APPROVE 2026-09-17T19:35Z: +40 settled evidence-completion run for shadow-veto SEQ-STOP decision; SEQ-STOP early-exit + COHORT-FREEZE handle terminal capture)';
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
console.log('armedBy patched, armed:', st.armed, '| target:', st.target);
db.close();
"
echo "== EVID-BUDGET RE-ARM COMPLETE — verification: first issue expected within ~12-36min (spacingMin 12) =="
