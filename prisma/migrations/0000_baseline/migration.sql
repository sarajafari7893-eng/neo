-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" REAL NOT NULL,
    "entryZoneLow" REAL NOT NULL,
    "entryZoneHigh" REAL NOT NULL,
    "tp1" REAL NOT NULL,
    "tp2" REAL NOT NULL,
    "tp3" REAL NOT NULL,
    "stopLoss" REAL NOT NULL,
    "initialStopLoss" REAL,
    "leverage" INTEGER NOT NULL,
    "marginUsd" REAL NOT NULL,
    "confidence" INTEGER NOT NULL,
    "riskReward" REAL NOT NULL,
    "timeframe" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reachedTp" INTEGER NOT NULL DEFAULT 0,
    "pnlPercent" REAL NOT NULL DEFAULT 0,
    "maxPnlPercent" REAL NOT NULL DEFAULT 0,
    "analysis" TEXT NOT NULL,
    "tags" TEXT NOT NULL,
    "operatorNotes" TEXT NOT NULL DEFAULT '',
    "notesUpdatedAt" DATETIME,
    "engine" TEXT NOT NULL DEFAULT 'NEXUS-LIVE v4.8',
    "serial" INTEGER NOT NULL DEFAULT 0,
    "feeUsd" REAL NOT NULL DEFAULT 0,
    "swapUsd" REAL NOT NULL DEFAULT 0,
    "factorsJson" TEXT,
    "flowJson" TEXT,
    "mtfJson" TEXT,
    "afterlife" TEXT,
    "afterlifeAt" DATETIME,
    "qualityFlag" TEXT,
    "maxPostPnlPercent" REAL NOT NULL DEFAULT 0,
    "ttlMinutes" INTEGER NOT NULL,
    "ttlExtensions" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME
);

-- CreateTable
CREATE TABLE "AdvisorProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycle" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'KNOB_ADJUST',
    "knob" TEXT NOT NULL,
    "currentValue" REAL NOT NULL,
    "proposedValue" REAL NOT NULL,
    "direction" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedAt" DATETIME,
    "appliedAt" DATETIME,
    "applyNote" TEXT
);

-- CreateTable
CREATE TABLE "SignalEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "signalId" TEXT,
    "type" TEXT NOT NULL,
    "symbol" TEXT,
    "message" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignalEvent_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentThought" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "agent" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'observe',
    "thought" TEXT NOT NULL,
    "evidence" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "MarketAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "prevPrice" REAL NOT NULL,
    "change24h" REAL NOT NULL,
    "high24h" REAL NOT NULL,
    "low24h" REAL NOT NULL,
    "volume24h" REAL NOT NULL,
    "sparkline" TEXT NOT NULL,
    "exchanges" TEXT,
    "maxDevBps" REAL NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'live',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "EngineSetting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PricePoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FlowScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "tf" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "bias" TEXT NOT NULL,
    "cvdPct" REAL,
    "trend" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "sweep" BOOLEAN NOT NULL,
    "volZ" REAL,
    "atrPct" REAL,
    "funding8h" REAL,
    "oiDelta1h" REAL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VolCauseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "detectedAt" DATETIME NOT NULL,
    "rank" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "change24h" REAL NOT NULL,
    "price" REAL NOT NULL,
    "oiDelta10m" REAL,
    "oiDelta1h" REAL,
    "oiValueUsd" REAL,
    "cvdPct" REAL,
    "takerRatio" REAL,
    "crowdLS" REAL,
    "funding8h" REAL,
    "liqUsd1h" REAL,
    "onsetScore" INTEGER,
    "hourUtc" INTEGER NOT NULL,
    "session" TEXT NOT NULL,
    "causesJson" TEXT NOT NULL,
    "primaryCause" TEXT NOT NULL,
    "fwd2hPct" REAL,
    "fwd6hPct" REAL,
    "settledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FuturesSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'LIVE',
    "price" REAL NOT NULL,
    "oiBase" REAL,
    "oiUsdM" REAL,
    "priceDelta15m" REAL,
    "priceDelta1h" REAL,
    "oiDelta15m" REAL,
    "oiDelta1h" REAL,
    "quadrant15m" TEXT,
    "quadrant1h" TEXT,
    "funding8h" REAL,
    "crowdLS" REAL,
    "topLS" REAL,
    "takerLS" REAL,
    "cvd15mPct" REAL,
    "cvd1hPct" REAL,
    "vol15mUsd" REAL,
    "liqLong10mUsd" REAL,
    "liqShort10mUsd" REAL,
    "liqUsd1h" REAL,
    "fundingByb" REAL,
    "oiByb" REAL,
    "fundingOkx" REAL,
    "oiOkx" REAL,
    "fwd15mPct" REAL,
    "fwd1hPct" REAL,
    "fwd4hPct" REAL
);

-- CreateTable
CREATE TABLE "PumpTrack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'ONSET',
    "outcome" TEXT,
    "anchorPrice" REAL NOT NULL,
    "peakPrice" REAL NOT NULL,
    "vel1mPct" REAL,
    "vel5mPct" REAL,
    "volBurstX" REAL,
    "oiDelta10m" REAL,
    "cvdUsd60s" REAL,
    "takerRatio" REAL,
    "funding8h" REAL,
    "whaleUsd5m" REAL,
    "liqUsd10m" REAL,
    "score" INTEGER NOT NULL,
    "metricsJson" TEXT,
    "mfePct" REAL NOT NULL DEFAULT 0,
    "maePct" REAL NOT NULL DEFAULT 0,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "successNote" TEXT,
    "signalId" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Signal_serial_key" ON "Signal"("serial");

-- CreateIndex
CREATE INDEX "Signal_status_idx" ON "Signal"("status");

-- CreateIndex
CREATE INDEX "Signal_symbol_idx" ON "Signal"("symbol");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE INDEX "Signal_expiresAt_idx" ON "Signal"("expiresAt");

-- CreateIndex
CREATE INDEX "AdvisorProposal_status_createdAt_idx" ON "AdvisorProposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AdvisorProposal_knob_createdAt_idx" ON "AdvisorProposal"("knob", "createdAt");

-- CreateIndex
CREATE INDEX "SignalEvent_createdAt_idx" ON "SignalEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SignalEvent_signalId_createdAt_idx" ON "SignalEvent"("signalId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentThought_createdAt_idx" ON "AgentThought"("createdAt");

-- CreateIndex
CREATE INDEX "AgentThought_agent_createdAt_idx" ON "AgentThought"("agent", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MarketAsset_symbol_key" ON "MarketAsset"("symbol");

-- CreateIndex
CREATE INDEX "PricePoint_symbol_createdAt_idx" ON "PricePoint"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "FlowScan_updatedAt_idx" ON "FlowScan"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlowScan_symbol_tf_key" ON "FlowScan"("symbol", "tf");

-- CreateIndex
CREATE INDEX "VolCauseEvent_symbol_detectedAt_idx" ON "VolCauseEvent"("symbol", "detectedAt");

-- CreateIndex
CREATE INDEX "VolCauseEvent_settledAt_idx" ON "VolCauseEvent"("settledAt");

-- CreateIndex
CREATE INDEX "FuturesSnapshot_symbol_ts_idx" ON "FuturesSnapshot"("symbol", "ts");

-- CreateIndex
CREATE INDEX "FuturesSnapshot_fwd1hPct_idx" ON "FuturesSnapshot"("fwd1hPct");

-- CreateIndex
CREATE UNIQUE INDEX "FuturesSnapshot_symbol_ts_source_key" ON "FuturesSnapshot"("symbol", "ts", "source");

-- CreateIndex
CREATE INDEX "PumpTrack_symbol_detectedAt_idx" ON "PumpTrack"("symbol", "detectedAt");

-- CreateIndex
CREATE INDEX "PumpTrack_outcome_idx" ON "PumpTrack"("outcome");

-- CreateIndex
CREATE INDEX "PumpTrack_phase_idx" ON "PumpTrack"("phase");

-- CreateIndex
CREATE INDEX "PumpTrack_signalId_idx" ON "PumpTrack"("signalId");

