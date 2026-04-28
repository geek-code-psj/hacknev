'use strict';
const pool = require('./pool');

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS trades (
  "tradeId"        UUID        PRIMARY KEY,
  "userId"         UUID        NOT NULL,
  "sessionId"      UUID        NOT NULL,
  asset            TEXT        NOT NULL,
  "assetClass"     TEXT        NOT NULL CHECK ("assetClass" IN ('equity','crypto','forex')),
  direction        TEXT        NOT NULL CHECK (direction IN ('long','short')),
  "entryPrice"     NUMERIC(18,8) NOT NULL,
  "exitPrice"      NUMERIC(18,8),
  quantity         NUMERIC(18,8) NOT NULL,
  "entryAt"        TIMESTAMPTZ NOT NULL,
  "exitAt"         TIMESTAMPTZ,
  status           TEXT        NOT NULL CHECK (status IN ('open','closed','cancelled')),
  outcome          TEXT        CHECK (outcome IN ('win','loss')),
  pnl              NUMERIC(18,8),
  "planAdherence"  SMALLINT    CHECK ("planAdherence" BETWEEN 1 AND 5),
  "emotionalState" TEXT        CHECK ("emotionalState" IN ('calm','anxious','greedy','fearful','neutral')),
  "entryRationale" TEXT,
  "revengeFlag"    BOOLEAN     NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_user     ON trades ("userId");
CREATE INDEX IF NOT EXISTS idx_trades_session  ON trades ("sessionId");
CREATE INDEX IF NOT EXISTS idx_trades_entry_at ON trades ("entryAt");
CREATE INDEX IF NOT EXISTS idx_trades_user_entry ON trades ("userId", "entryAt");
CREATE INDEX IF NOT EXISTS idx_trades_user_status ON trades ("userId", status, "entryAt");

-- Precomputed metrics table updated by the async worker
CREATE TABLE IF NOT EXISTS user_metrics (
  "userId"               UUID        PRIMARY KEY,
  "planAdherenceScore"   NUMERIC(5,4),
  "sessionTiltIndex"     NUMERIC(5,4),
  "winRateByEmotionalState" JSONB,
  "revengeTrades"        INTEGER     DEFAULT 0,
  "overtradingEvents"    INTEGER     DEFAULT 0,
  "updatedAt"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Metrics timeseries for the read API
CREATE TABLE IF NOT EXISTS metrics_timeseries (
  id               BIGSERIAL   PRIMARY KEY,
  "userId"         UUID        NOT NULL,
  bucket           TIMESTAMPTZ NOT NULL,
  granularity      TEXT        NOT NULL CHECK (granularity IN ('hourly','daily','rolling30d')),
  "tradeCount"     INTEGER     NOT NULL DEFAULT 0,
  "winRate"        NUMERIC(5,4),
  pnl              NUMERIC(18,8),
  "avgPlanAdherence" NUMERIC(5,4),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_timeseries_user_bucket_gran
  ON metrics_timeseries ("userId", bucket, granularity);
CREATE INDEX IF NOT EXISTS idx_timeseries_user_range
  ON metrics_timeseries ("userId", granularity, bucket);

-- Overtrading events log
CREATE TABLE IF NOT EXISTS overtrading_events (
  id        BIGSERIAL   PRIMARY KEY,
  "userId"  UUID        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  trade_count  INTEGER     NOT NULL,
  "emittedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_overtrading_user ON overtrading_events ("userId");
`;

async function migrate() {
  console.log('>>> MIGRATE: connecting to pool...');
  const client = await pool.connect();
  console.log('>>> MIGRATE: client acquired, running schema...');
  try {
    await client.query(SCHEMA);
    console.log('>>> MIGRATE: complete');
  } finally {
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
