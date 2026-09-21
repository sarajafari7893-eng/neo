#!/bin/bash
# ── NEXUS-LIVE v9.6 — RAW-CAL SUPERVISED ARM (Option B, operator mandate 2026-09-14) ──
# Operator order: «گزینه B را کامل و مهندسی انجام بده» + «مسلح سازی را هوشمند و
# تحت نظر خودت انجام بده و گزارش روند پیشرفت + هر زمان تایید و مسلح شد گزارشش
# رو به تلگرام بفرست»
#
# ENGINEERING NOTE (the auto-lift trap):
#   raw-cal.ts maybeRawCalDeploy() step-1 auto-cancels the mode when the
#   EPOCH-2 settled book >= state.target. Book = 253, old target = 100 →
#   arming WITHOUT raising the target is a one-tick no-op (auto-lift ~35s
#   after arm, zero captures, REAL arms stay starved). Engineered fix:
#   raise state.target to 380 (~25h supervised capture at ~5 settles/h,
#   then auto-lift → R6 recalibration over the enlarged book).
#   This is runtime STATE surgery (EngineSetting rawcal.state JSON), not code.
set -u
cd /home/z/my-project

echo "== [1/5] PRE-FLIGHT HEALTH =="
APP=$(curl -s -m 10 -o /dev/null -w '%{http_code}' http://localhost:3000/api/pulse)
echo "pulse:$APP"
[ "$APP" = "200" ] || { echo "ABORT: app not healthy"; exit 1; }

echo "== [2/5] RAW-CAL STATE BEFORE =="
S_BEFORE=$(curl -s -m 10 http://localhost:3000/api/rawcal)
echo "$S_BEFORE" | python3 -c "import json,sys; s=json.load(sys.stdin); print('armed:',s['armed'],'| settledN:',s['settledN'],'| target:',s['target'],'| issuedTotal:',s['issuedTotal'],'| openRaw:',s['openRaw'],'| spacing:',s['spacingMin'],'min | maxOpen:',s['maxOpen'])"
ARMED=$(echo "$S_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin)['armed'])")
[ "$ARMED" = "False" ] && ARMED=false || true
if echo "$ARMED" | grep -qi true; then echo "ABORT: already armed"; exit 1; fi

SETTLED=$(echo "$S_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin)['settledN'])")
OLD_TARGET=$(echo "$S_BEFORE" | python3 -c "import json,sys; print(json.load(sys.stdin)['target'])")
if [ "$SETTLED" -ge "$OLD_TARGET" ]; then
  echo "AUTO-LIFT TRAP CONFIRMED: settledN $SETTLED >= target $OLD_TARGET — target raise REQUIRED"
else
  echo "target raise not required (settledN $SETTLED < target $OLD_TARGET)"
fi

echo "== [3/5] STATE SURGERY: target -> 380 =="
bun -e "
const { Database } = require('bun:sqlite');
const db = new Database('db/custom.db');
const row = db.query(\"SELECT value FROM EngineSetting WHERE key='rawcal.state'\").get();
if (!row) { console.error('ABORT: rawcal.state not found'); process.exit(1); }
const st = JSON.parse(row.value);
if (st.armed) { console.error('ABORT: race — state now armed'); process.exit(1); }
const before = st.target;
st.target = 380;
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
const chk = JSON.parse(db.query(\"SELECT value FROM EngineSetting WHERE key='rawcal.state'\").get().value);
console.log('target:', before, '->', chk.target, '| verify-readback:', chk.target === 380 ? 'OK' : 'FAIL');
db.close();
" || { echo "ABORT: state surgery failed"; exit 1; }

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
st.armedBy = 'NEXUS-SUPERVISED (Option B — operator mandate 2026-09-14, engineered: target 100→380 vs auto-lift trap)';
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
console.log('armedBy patched, armed:', st.armed, '| target:', st.target);
db.close();
"
echo "== OPTION-B ARM SEQUENCE COMPLETE — entering verification window =="
