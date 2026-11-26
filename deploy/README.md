# NEXUS//SIGNALS — Self-Host Deployment Guide (SELFHOST-0929)

> **Iranian VPS?** Read `deploy/README-IRAN-FA.md` (Persian) — Bybit/Binance
> geo-block Iranian IPs and `api.telegram.org` is filtered there; the guide
> covers the free WARP tunnel fix + full Persian step-by-step.

**Why this exists.** Operator verdict 2026-09-29: the sandbox recycles the
whole machine every few hours and restores stale snapshots — proven 4× in the
worklog (09-26 13:32Z · 09-27 ~15:50Z · 09-28 12:23Z · 09-29 09:28Z boots).
A profitability-grade trading terminal needs 24/7 uptime, durable storage and
**no external party that can reset it**. This repo now ships everything needed
to run outside the sandbox with ZERO proprietary dependencies.

## 0 · What changes, conceptually

| Sandbox mechanism (the limitation) | Self-hosted replacement |
|---|---|
| Platform recycles VM + restores stale snapshots | **Nothing does this anymore** — your box is yours; git + snapshot ring remain the backups |
| "Platform lineage" process reaping | `restart: unless-stopped` (Docker) / `Restart=always` (systemd) |
| Platform LLM (`z-ai-web-dev-sdk`) | `LLM_PROVIDER=openai` → Ollama / vLLM / LM Studio / OpenRouter (one env switch, zero call-site changes — `src/lib/llm-provider.ts`) |
| Gateway `?XTransformPort=` | Reverse proxy path (`/ws` → :3003) or direct port — `NEXT_PUBLIC_WS_URL` |
| bun --hot + resurrect.sh resurrection | Supervised units + healthchecks (resurrect.sh still ships, optional) |
| Stale-snapshot code resurrection (armor boot-align fights it) | Impossible by construction: the checkout IS the deployment |

Unchanged (already open-source & portable): Next.js 16 + Prisma/SQLite,
Telegram bridge (public Bot API), Binance/Bybit public feeds, git durable
store (your own GitHub repo + PAT), AES-256 snapshot ring, all NEXUS engines.

## 1 · Docker path (recommended)

```bash
# 0) prerequisites: docker >= 24 with compose plugin, 4GB+ RAM, 20GB disk
git clone https://github.com/<you>/<your-fork>.git /home/z/my-project
cd /home/z/my-project

# 1) secrets
cp deploy/.env.example .env && $EDITOR .env
#    → set TELEGRAM_*, NEXUS_CONTROL_KEY, BRIDGE_TOKEN, GITHUB_TOKEN,
#      BACKUP_PASSPHRASE, DATABASE_URL (template default is fine),
#      LLM_PROVIDER=openai + LLM_BASE_URL/LLM_MODEL (Ollama or hosted)

# 2) build (NEXT_PUBLIC_WS_URL defaults to /ws for the proxy layout)
docker build -f deploy/Dockerfile -t nexus-signals:latest .

# 3) up — every service + healthchecks + restart policies
docker compose -f deploy/docker-compose.yml up -d

# 4) database
docker compose -f deploy/docker-compose.yml exec app bunx prisma db push

# 5) verify
curl -s http://127.0.0.1:3000/api/healthz   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3003/   # 400 = ws ALIVE
```

Optional reverse proxy (single public port, like the sandbox gateway):

```nginx
# /etc/nginx/sites-available/nexus  (or Caddy equivalent)
server {
  listen 80;
  server_name your.domain;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
  location /ws { proxy_pass http://127.0.0.1:3003; proxy_http_version 1.1;
                 proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; }
}
```

## 2 · Bare-metal path (systemd, no docker)

The code expects its absolute path `/home/z/my-project` (a handful of ops
scripts). Simplest contract: **clone exactly there**:

```bash
sudo git clone https://github.com/<you>/<your-fork>.git /home/z/my-project
cd /home/z/my-project
cp deploy/.env.example .env && $EDITOR .env
bun install && bunx prisma generate && bunx prisma db push && bun run build
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-app nexus-minis nexus-guard
```

(`start-minis.sh` runs every service WITHOUT --hot — supervision replaces it.)

## 3 · First-boot checklist (either path)

- [ ] `/api/healthz` 200 · ws :3003 root 400 · all ports listening
- [ ] Telegram: bridge sends the boot report; `GET :3015/status` sweep GREEN
- [ ] Freshness guard: stop price-ws for 15 min → **RED + Telegram alert fires**
      (this is the 20-hour-silent-stall cure — verify it once!)
- [ ] armor push OK (`GET :3016/health` → `pushes_ok` grows)
- [ ] arms refill: `.data/shadow-veto-latest.json` arms n/target rising
- [ ] snapshot ring: `.data/sentinel` backup job 3h cadence → `/tmp`→ configure
      host path; restore drill documented in scripts/backup.sh header

## 4 · Migration of DATA from the sandbox

The durable store already contains everything (armor pushes db + .data every
10 min). On the new box:

```bash
git fetch origin && git reset --hard origin/main   # latest committed state
# then restore the newest snapshot zip if it is fresher:
# decrypt with BACKUP_PASSPHRASE (see scripts/backup.sh header for the format)
```

## 5 · Honest limits (what was NOT testable in the sandbox)

- `next build` production build (sandbox forbids builds — run it on target)
- Docker image build / compose up (no docker in sandbox)
- systemd units (no systemd in sandbox)
- Ollama/vLLM backend call shape (shim is standards-compliant OpenAI format;
  try `curl $LLM_BASE_URL/chat/completions` once before wiring)

Everything else (LLM abstraction wiring, env switches, package scripts, cron
v1.3.0 freshness guard, armor self-align, watchdog contract) is lint-verified
and running in the sandbox at commit time.
