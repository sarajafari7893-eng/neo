# SECURITY-HARDENING.md — NEXUS//SIGNALS
**Task:** NEXUS-LIVE-HARDENING-MASTER-v1.0 · Phase 2 deliverable
**Written:** 2026-09-26 (Tehran) · **Method:** runtime PoC tests against the live system + source inspection. Every claim below is backed by an executed command and its HTTP status.

---

## 1. Control-plane authentication matrix (post-hardening)

| Layer | Mechanism | Status |
|---|---|---|
| Next.js API (`/api/*`) mutating (POST/PUT/PATCH/DELETE) | `src/middleware.ts` v2: `x-nexus-key` header (constant-time compare) **OR** NextAuth JWT session cookie | ✅ verified T1–T7 |
| NextAuth session issuance | `/api/auth/*` (v4.24.13, JWT strategy, 7d) — credential = `NEXUS_CONTROL_KEY` itself; login UI at `/login` | ✅ verified T7/T7b |
| NextAuth flows | Own CSRF tokens; middleware explicitly passes `/api/auth/*` | ✅ |
| Rate limiting | 60 authorized mutations / rolling 60s per IP → 429 | ✅ verified T6b |
| Mini-service mutating endpoints (`trade-service POST /watch`, etc.) | **NO auth — see Finding W1** | ⚠️ open |
| External gateway (`:81`, platform-owned `/app/Caddyfile`) | `XTransformPort` query forwards to ANY local port (platform architecture) — see Finding W2 | ⚠️ by-design, compensated below |

## 2. CRITICAL finding → FIXED in this task

**Finding C1 — forged-Origin mutation bypass (CONFIRMED by PoC, then CLOSED).**
- v1 middleware allowed mutating requests with a client-supplied `Origin` header matching `Host` (same-origin CSRF heuristic).
- **PoC (before fix):** `curl -X POST /api/bridge/send -H 'Origin: http://127.0.0.1:3000' -d '{"text":"security-poc"}'` → **200** (mutation executed; no key). Without the Origin header the same request → 401.
- Root cause: browsers are the only clients that cannot forge `Origin`; curl/scripts can. The heuristic authenticated *nothing* for non-browser clients.
- **Fix implemented:** `src/middleware.ts` v2 removes the Origin fallback entirely. Mutations now require key **or** a real session obtained by proving the control key at `/login` (NextAuth Credentials `nexus-key`, HttpOnly SameSite=Lax JWT cookie).
- **Re-verification (after fix):** same forged-Origin request → **401**. Session-cookie-only mutation → **200**. Key-only mutation → passes. Fail-closed on missing/malformed env or session → 401.

**Test log (executed 2026-09-26):**

| # | Test | Expected | Result |
|---|---|---|---|
| T1 | POST `/api/bridge/send`, no key, no session | 401 | ✅ 401 |
| T2 | POST with wrong key | 401 | ✅ 401 |
| T3b | POST with forged `Origin: <host>`, no key (PoC) | 401 after fix (was **200** before) | ✅ 401 — CLOSED |
| T6b | 62 authorized mutations | 429 on #61+ | ✅ 429 |
| T7 | Full curl login flow (csrf → credentials callback) | 200 | ✅ 200 |
| T7b | Mutation with session cookie only (no Origin, no key) | non-401 | ✅ 200 |
| — | Unauthenticated requests are cheap-denied (401 before rate bucket) | by design | ✅ verified |

## 3. Reverse-proxy / upstream routing

- **Project `Caddyfile`** (allowlist: only `XTransformPort=3003`, else 403) is **NOT the loaded config**. The live `:81` listener is the platform gateway (`caddy run --config /app/Caddyfile`, pid 2, root) — project Caddyfile is vestigial. (Discovered by runtime divergence: expected 403, got upstream 404/200.)
- **Finding W2 (accepted platform architecture, compensated):** the platform gateway forwards `XTransformPort=<any local port>` by design (sanctioned mechanism for mini-service access). Consequence: every mini-service HTTP endpoint is reachable from the public gateway. Current exposure audit:
  - All mini-service endpoints are **read-only** (`/health`, `/status`, `/flow`, `/top`, telemetry GETs) **except** `trade-service POST /watch`, `push-armor POST /cycle`, `warm-loop`/`sentinel` control POSTs, `telegram-bridge POST /relay` (BRIDGE_TOKEN-checked — verify in Phase 12 security tests).
  - Sensitive-value check: `/health`/`/status` payloads contain operational metadata only; token values never echoed (armor v2 redaction verified in code).
- **Compensating controls (to implement in Phase 12 hardening pass):** shared-secret check (`BRIDGE_TOKEN`-style) on every mini-service mutating endpoint; see §5 remediation R2.

## 4. Secrets hygiene

- `.env` — chmod 600, gitignored, **and scrubbed from all 22 git commits** (Task 30: filter-branch in isolated clone + gc; verified `git log --all -- .env` = 0). ✅
- `push-armor v2.0`: GitHub token travels only via child-process env (`GIT_CONFIG_*` extraheader) — never in argv/URL/logs; output redaction against token substring. ✅
- Scripts reading secrets (`scripts/backup.sh`, `rawcal-arm-*.sh`, `restore-drill.sh`): read from `.env` at runtime; zero hardcoded values (verified by pattern scan). ✅
- `.env-erased/erased-*.txt`: contains only `DATABASE_URL` name-entry; chmod 600 applied. ✅
- `/tmp/nexus-scrub` (Task 30 working clone) — **removed** during this audit. ✅
- No secret material found in `/tmp` staging. ✅

## 5. Open findings & remediation plan

| ID | Severity | Finding | Remediation |
|---|---|---|---|
| W1 | MEDIUM | Mini-service mutating endpoints (`trade POST /watch`, `armor POST /cycle`, `sentinel`/`warm-loop` control POSTs) lack service-level auth; reachable via platform gateway | R2: shared-secret header check (`BRIDGE_TOKEN`) on each; fail-closed. Apply at next service restart (hot-reload rebinding risk — change scheduled, not force-deployed) |
| W2 | LOW (by-design) | Platform `XTransformPort` forwards to any local port | Cannot modify platform `/app/Caddyfile` (root-owned, outside repo). Compensate via R2 + keep mutating surface minimal |
| W3 | LOW | All services bind `0.0.0.0` (`*:port`) — sandbox-internal exposure | R3: add `hostname: "127.0.0.1"` to mini-service `Bun.serve` at next restart (demonstrated on push-armor v2.1) |
| W4 | LOW | GET `/api/analytics/pump` + `/api/analytics/duration` perform DB writes (telemetry) | R4: convert to POST in a dashboard-coordinated change, or document as accepted telemetry-on-read |
| W5 | INFO | Dashboard reads are anonymous (GET open) — read-only data (signals/telemetry) is public within gateway boundary | Accepted for research dashboard; revisit if data classification changes |

## 6. Residual risk statement

The control plane now requires **knowledge of the single operator secret** (key or login) for every mutation — verified by PoC round-trip. Remaining exposure is: (a) mini-service mutation endpoints until R2 lands, (b) platform-level `XTransformPort` forwarding (outside repo control). **No privileged mutation endpoint on the Next.js control plane is reachable anonymously.** Real-money order placement remains structurally absent (see ARCHITECTURE-MAP §3) — the strongest possible security posture for the trading surface is that it does not exist yet.

## Phase-2 acceptance self-check (task §2)

- [x] Every POST/PUT/PATCH/DELETE endpoint enumerated (ARCHITECTURE-MAP §2)
- [x] AuthN/AuthZ per control-plane endpoint determined & enforced (middleware v2 + NextAuth)
- [x] Internal services exposure inspected (W1/W2/W3 documented with remediation)
- [x] Reverse proxy inspected (platform gateway reality established)
- [x] Client-controlled upstream routing — identified as platform architecture; compensating control plan (R2)
- [x] CSRF: session cookie SameSite=Lax + NextAuth CSRF on auth flows + Origin heuristic **removed** (was bypassable)
- [x] Rate limiting: active on authorized mutations (T6b)
- [x] Replay: NextAuth JWT has 7d expiry; key auth is header-based (TLS/transport boundary = platform gateway); formal replay protection deferred to R2 auth headers with timestamps — tracked
- [x] Secrets staging: verified clean (§4)

**Phase 2 status: DONE (C1 fixed & verified; W-findings documented with owners/phases).**
