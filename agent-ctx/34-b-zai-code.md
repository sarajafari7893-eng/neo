# Task 34-b — trade-service SPOT-MIRROR + REST ban-storm fix

Agent: Z.ai Code
Status: DONE — verified live, committed to git

## What changed
- mini-services/trade-service/index.ts → v4.8 SPOT-MIRROR:
  - New spot aggTrade WS lane (stream.binance.com:9443) over the engine watchlist; single-symbol `/ws/<s>@aggTrade`, multi `/stream?streams=a@aggTrade/b@aggTrade`; diff-resubscribe (SUBSCRIBE/UNSUBSCRIBE) on /watch change + 60s reconcile; exponential backoff 1s→30s reset on open; 15s open-guard.
  - Spot frames feed the SAME minute buckets (CVD/divergence/VPIN) via a separate lane: per-symbol `lastSpotId` de-dup, `spotFrames`/`spotConnected`/`spotLastFrameAt`/`spotStreams`/`spotReconnects` counters.
  - fstream `!aggTrade` kept; futures frames win the label when they flow.
  - Source priority: WS > SPOT-MIRROR > REST > REST-WARMING/REST-IDLE > OFFLINE; `dataStalled` counts spot frames as live data.
  - REST weight: BATCH 3→1, POLL_MS 2000→5000 (~1800→~240 weight/min); 418/429 with "banned until <ms>" body pauses ALL REST until then (cap +35min), exposes `restBannedUntil`; marker-less 418/429 = 60s soft ban.
- mini-services/trade-service/package.json: description only.
- src/lib/trade-flow.ts: NOT touched (contract backward-compatible, additive fields only).

## Verification (live)
- /health: source=SPOT-MIRROR, dataStalled=false, spotConnected=true, spotFrames climbing (1678+), spotStreams=2, spotReconnects=0, restBannedUntil ACTIVE (real 418 observed mid-task → REST frozen at 8 polls, zero weight during ban).
- /flow?symbol=BTCUSDT & ETHUSDT: full TapeFlow contract with real spot-derived CVD; divergence/vpin honestly null until windows fill.
- /api/pulse: feed block parses; tsc on service file clean; lint = pre-existing scripts/ baseline only.

## Notes for next agents
- Service restarted via standard `(bun --hot index.ts >> ../../logs/trade-service.log 2>&1 &)`; if it dies with the agent session, p0-watchdog/pulse healer respawns it as `bun run mini-services/trade-service/index.ts` (observed working).
- Engine watchlist = FUTURES_ANCHORS (BTCUSDT, ETHUSDT) synced via maybeFuturesSample (~5min cadence) — after any restart spot reconnects on next sync or POST /watch.
- live trading remains DISABLED.
