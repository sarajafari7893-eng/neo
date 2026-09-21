#!/bin/bash
# ── NEXUS-LIVE v10.11 — EVID-BUDGET RE-ARM E-20260919 (operator APPROVE 2026-09-18T22:28Z msg 861802417 + execution order 23:28Z msg 861802418) ──
# Supervisor proposal set approved by operator: new re-arm -> NEAR-MISS review -> BARRIER-NEAR-MISS
#   paper queue implementation (bridge msgs 861802417, 861802418: "پیشنهادات سوپروایزر رو کامل و مهندسی انجام بده").
# Prior run E-20260918 completed 2026-09-18T18:57Z (521/520 settled, auto-lift, clean close).
# This run continues evidence-completion cadence: sized +40 settled (auto-lift at book growth +40)
#   to grow the EPOCH-2 book and feed shadow-veto arms (rolling-30) + upcoming NEAR-MISS /
#   BARRIER-NEAR-MISS evaluation windows under live cadence.
# Epoch policy: ARM_EPOCH stays E-20260915 — arms are rolling-30 (v10.10), epoch is a regime tag.
# This is runtime STATE surgery (EngineSetting rawcal.state JSON), not code — same path as E-20260918.
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
st.retargetNote = 'EVID-BUDGET RE-ARM E-20260919 (operator APPROVE 2026-09-18T22:28Z msg 861802417 + execution order 2026-09-18T23:28Z msg 861802418: fully implement SUPERVISOR proposals): run sized +40 settled continuing evidence-completion cadence; feeds shadow-veto rolling-30 arms + NEAR-MISS / BARRIER-NEAR-MISS evaluation windows; EVIDENCE-COMPLETION run, not PnL; epoch stays E-20260915 (rolling-30)';
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
st.armedBy = 'NEXUS-SUPERVISED (EVID-BUDGET RE-ARM E-20260919 — operator APPROVE 2026-09-18T22:28Z msg 861802417 + execution order 23:28Z msg 861802418: +40 settled evidence-completion run per SUPERVISOR proposal set; NEAR-MISS review + BARRIER-NEAR-MISS queue sequenced after)';
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
console.log('armedBy patched, armed:', st.armed, '| target:', st.target);
db.close();
"
echo "== EVID-BUDGET RE-ARM E-20260919 COMPLETE — verification: first issue expected within ~12-36min (spacingMin 12) =="
