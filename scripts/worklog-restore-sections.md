---
Task ID: RECONSTRUCTED-GAP-0905-0906
Agent: main (Z.ai Code)
Task: Reconstruction of the worklog gap Sep 5 09:26 UTC → Sep 6 20:20 UTC (entries destroyed by the sandbox rollback; rebuilt from session records after recovery of the Sep-5 snapshot)

Work Log:
- FEAT-VOLONSET-0906 (Sep 6): VOL-ONSET implemented full-stack under a telemetry-only contract (tag + factor vote=0, never gates/sizes): src/lib/volOnset.ts (resampleTicks, detectOnset 15m bars MIN_BARS 110 / TRAILING 96 / eruption ≥5× trailing-24h median, onsetScoreOf 40+30+20+10 → 0–100, isHot ≤90m & ≥5× & follow-through > 0, getOnsetBoard 90s cache + kline-first 220 bars + 50h tick fallback + bounded concurrency 5, onsetTagFor never-throw, onsetTagStats tagged-vs-rest over settled TP1/TP2/TP3/SL/EXPIRED/CLOSED); src/app/api/vol-onset (force-dynamic, rules + tagStats + rows); MarketMovers VolOnsetRadar (60s poll, 5 rows, HOT badge, score-meter, QUIET TAPE, LEARNING LOOP footer, telemetry-only label).
- Engine wiring (Sep 6): 4-point telemetry-only integration (onsetTagFor call, vote-0 push into conf.votes, "VOL-ONSET" tag, analysis line) — re-applied verbatim during this restore on top of the Sep-5 v6.3 engine.
- QA-0906-0645: verified — lint clean, /api/vol-onset 200, radar E2E (LINKUSDT score 86 ×11.4 top row, row click opens spotlight dialog, zero console errors, desktop 1440 + mobile 390).
- NX-0154 attribution query answered for the operator (signal attribution breakdown).
- Snapshots: 3-hourly snapshots ran 04:33 → 19:30 UTC Sep 6 (7.3M→8.2M zips) — all destroyed by the rollback; the only surviving copy was the user-side upload/nexus-snapshot-20260905-093557.zip outside the rolled-back tree.

Stage Summary:
- This section is a faithful reconstruction from session records, not original logs; the recovered Sep-5 snapshot + merged DB are the authoritative state.

---
Task ID: RESTORE-0907-DB
Agent: main (Z.ai Code)
Task: User (Persian) asked to restore the project to the latest version and recover issued-signal history — full merge of the recovered Sep-5 snapshot

Work Log:
- RECOVERY SOURCE FOUND: upload/nexus-snapshot-20260905-093557.zip (6.3MB, survived the rollback inside the root-owned upload/ mount) — full Sep 5 09:35 state: db/custom.db 15.6MB (127 signals NX-0001..0127, 18,216 events, 90,753 price points), v6.3 engine (57KB), worklog 206KB, 7 extra libs (macro, notify, supervisor, telegram-image, tp3-lab, ttl-gate, veracity), deep-learn + notify APIs, DeepLearnCard / NetPnlLedgerCard / TpDeepLabCard, 19 audit/test scripts, docs/system-review-2026-09-04.md.
- SOURCE MERGE: snapshot src/ rsynced over the project (excluded engine.ts + MarketMovers.tsx); schema.prisma restored (+reachedTp, +ttlExtensions columns), tsconfig (noise dirs excluded), next.config (ignoreBuildErrors: false), 19 scripts, 1 doc; prisma generate re-run.
- ENGINE MERGE: Sep-5 v6.3 engine (985 lines) + VOL-ONSET 4-point telemetry wiring re-applied (import L28, onsetTagFor + vote-0 push L676-679, tags spread L758, analysis line L765) — contract unchanged, vote 0, telemetry-only.
- DB MERGE (scripts/restore-db-merge.py): snapshot DB as base; the 10 post-restore donor signals (old serials 20-29) re-serialized to 128-137 with fresh cuids, 17 events remapped, analysis [NX-xxxx] prefixes rewritten; zero duplicate serials. Result: 137 signals, 18,233 events, 90,753 price points. EngineSetting: snapshot's 13-key v6.3 set replaces the current 8-key set. MarketAsset: snapshot's 26-asset universe.
- worklog.md rebuilt: snapshot 206KB (through Sep 5 09:26) + reconstructed gap section + incident sections + this section.
- Swap executed after source merge: Next.js stopped, db/custom.db ← custom.db.restored, Next.js restarted; pre-merge DB kept as db/custom.db.pre-restore-0907.

Stage Summary:
- Project restored to the true latest state: Sep-5 v6.3 feature set + VOL-ONSET (rebuilt, contract-compliant) + full signal history NX-0001..0137; the "history unrecoverable" verdict from the earlier incident pass is superseded by this merge.
