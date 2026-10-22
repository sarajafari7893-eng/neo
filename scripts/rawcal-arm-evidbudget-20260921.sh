#!/bin/bash
# ── NEXUS-LIVE v10.16 — EVID-BUDGET RE-ARM (operator order 2026-09-21 chat: "موارد الویت دار بعدی رو کامل و مهندسی انجام بده") ──
# Context (SENTINEL-20260921-R2): EPOCH-2 book auto-disarmed at settledN 631 > target 576
#   (2026-09-19). Shadow-veto arms stalled at 5/120 fill with lastFed 158h+; PASS-side
#   feeding is issuance-driven, so the book MUST re-open for arms to accrue toward the
#   30/30 Wilson-LB promotion gate. This is an EVIDENCE-COMPLETION run, not a PnL run:
#   sized +40 settled (auto-lift at book growth +40) per the proven evidbudget pattern.
# Rails that stay ON during arm mode: spacing (spacingMin 12) + maxOpen 8 open-cap.
# Epoch policy: epoch is a regime tag, NOT the evidence window (rolling-30 arms) — no
#   epoch rotation needed; arms keep their rolling windows.
# This is runtime STATE surgery (EngineSetting rawcal.state JSON), not code.
# Lineage: scripts/rawcal-arm-evidbudget.sh (E-20260918 pattern, operator APPROVE 2026-09-17).
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
st.retargetNote = 'EVID-BUDGET RE-ARM (operator order 2026-09-21 chat, priority-list execution): run sized +40 settled to resume shadow-veto arm feeding (stalled 158h at 5/120 fill) + counterfactual capture; EVIDENCE-COMPLETION run, not PnL; rails spacing+maxOpen stay on';
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
st.armedBy = 'NEXUS-SENTINEL EXEC (EVID-BUDGET RE-ARM 2026-09-21 — operator chat order: execute priority list; +40 settled evidence-completion to resume shadow-veto arm feeding + counterfactual book; spacing/maxOpen rails on)';
db.query('UPDATE EngineSetting SET value=? WHERE key=?').run(JSON.stringify(st), 'rawcal.state');
console.log('armedBy patched, armed:', st.armed, '| target:', st.target);
db.close();
"
echo "== EVID-BUDGET RE-ARM COMPLETE — verification: first issue expected within ~12-36min (spacingMin 12) =="
