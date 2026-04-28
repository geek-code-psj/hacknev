'use strict';
require('dotenv').config();
const { connect, QUEUE_METRICS, QUEUE_OVERTRADE } = require('./broker');
const pool = require('../db/pool');

/**
 * Compute all 5 behavioral metrics for a user after a trade closes.
 * Runs outside the write path — consumes from RabbitMQ.
 */

async function computeMetrics(userId) {
  const client = await pool.connect();
  try {
    // 1. Plan Adherence Score — rolling 10-trade average
    const paRes = await client.query(
      `SELECT AVG("planAdherence") AS score
       FROM (
         SELECT "planAdherence" FROM trades
         WHERE "userId" = $1 AND status = 'closed' AND "planAdherence" IS NOT NULL
         ORDER BY "exitAt" DESC NULLS LAST LIMIT 10
       ) sub`,
      [userId]
    );
    const planAdherenceScore = paRes.rows[0]?.score ? parseFloat(paRes.rows[0].score) : null;

    // 2. Session Tilt Index — loss-following trades / total in current session
    const sessionRes = await client.query(
      `SELECT "sessionId"
       FROM trades WHERE "userId" = $1
       ORDER BY "entryAt" DESC LIMIT 1`,
      [userId]
    );
    let sessionTiltIndex = 0;
    if (sessionRes.rows.length > 0) {
      const { sessionId } = sessionRes.rows[0];
      const tiltRes = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE "revengeFlag" = true) AS loss_following,
           COUNT(*) AS total
         FROM trades
         WHERE "sessionId" = $1 AND "userId" = $2`,
        [sessionId, userId]
      );
      const { loss_following, total } = tiltRes.rows[0];
      sessionTiltIndex = total > 0 ? parseFloat(loss_following) / parseFloat(total) : 0;
    }

    // 3. Win Rate by Emotional State
    const wrRes = await client.query(
      `SELECT "emotionalState",
              COUNT(*) FILTER (WHERE outcome = 'win') AS wins,
              COUNT(*) FILTER (WHERE outcome = 'loss') AS losses
       FROM trades
       WHERE "userId" = $1 AND status = 'closed' AND "emotionalState" IS NOT NULL
       GROUP BY "emotionalState"`,
      [userId]
    );
    const winRateByEmotionalState = {};
    for (const row of wrRes.rows) {
      const wins   = parseInt(row.wins);
      const losses = parseInt(row.losses);
      const total  = wins + losses;
      winRateByEmotionalState[row.emotionalState] = {
        wins, losses, winRate: total > 0 ? wins / total : 0
      };
    }

    // 4. Revenge Trade Count
    const rtRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM trades WHERE "userId" = $1 AND "revengeFlag" = true`,
      [userId]
    );
    const revengeTrades = parseInt(rtRes.rows[0].cnt);

    // 5. Overtrading Events Count
    const otRes = await client.query(
      `SELECT COUNT(*) AS cnt FROM overtrading_events WHERE "userId" = $1`,
      [userId]
    );
    const overtradingEvents = parseInt(otRes.rows[0].cnt);

    await client.query(
      `INSERT INTO user_metrics (
         "userId","planAdherenceScore","sessionTiltIndex",
         "winRateByEmotionalState","revengeTrades","overtradingEvents","updatedAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT ("userId") DO UPDATE SET
         "planAdherenceScore"     = EXCLUDED."planAdherenceScore",
         "sessionTiltIndex"       = EXCLUDED."sessionTiltIndex",
         "winRateByEmotionalState"= EXCLUDED."winRateByEmotionalState",
         "revengeTrades"          = EXCLUDED."revengeTrades",
         "overtradingEvents"      = EXCLUDED."overtradingEvents",
         "updatedAt"              = NOW()`,
      [userId, planAdherenceScore, sessionTiltIndex,
       JSON.stringify(winRateByEmotionalState), revengeTrades, overtradingEvents]
    );

    await updateTimeseries(client, userId);

  } finally {
    client.release();
  }
}

/**
 * Compute revenge flag asynchronously (moved from write path)
 */
async function computeRevengeFlag(userId, entryAt, emotionalState) {
  if (!['anxious', 'fearful'].includes(emotionalState)) return false;

  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM trades
       WHERE "userId" = $1
         AND status = 'closed'
         AND outcome = 'loss'
         AND "exitAt" >= $2::timestamptz - INTERVAL '90 seconds'
         AND "exitAt" <= $2::timestamptz
       LIMIT 1`,
      [userId, entryAt]
    );
    return res.rows.length > 0;
  } finally {
    client.release();
  }
}

/**
 * Update revenge flag for a trade (called when emotionalState is set/updated)
 */
async function updateRevengeFlag(tradeId, userId, entryAt, emotionalState) {
  const revengeFlag = await computeRevengeFlag(userId, entryAt, emotionalState);
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE trades SET "revengeFlag" = $1 WHERE "tradeId" = $2`,
      [revengeFlag, tradeId]
    );
  } finally {
    client.release();
  }
}

async function updateTimeseries(client, userId) {
  // Daily buckets
  await client.query(
    `INSERT INTO metrics_timeseries ("userId", bucket, granularity, "tradeCount", "winRate", pnl, "avgPlanAdherence", "updatedAt")
     SELECT
       "userId",
       DATE_TRUNC('day', "exitAt") AS bucket,
       'daily',
       COUNT(*),
       COUNT(*) FILTER (WHERE outcome='win')::float / NULLIF(COUNT(*),0),
       SUM(pnl),
       AVG("planAdherence"),
       NOW()
     FROM trades
     WHERE "userId" = $1 AND status = 'closed' AND "exitAt" IS NOT NULL
     GROUP BY "userId", DATE_TRUNC('day', "exitAt")
     ON CONFLICT ("userId", bucket, granularity) DO UPDATE SET
       "tradeCount"       = EXCLUDED."tradeCount",
       "winRate"          = EXCLUDED."winRate",
       pnl                = EXCLUDED.pnl,
       "avgPlanAdherence" = EXCLUDED."avgPlanAdherence",
       "updatedAt"        = NOW()`,
    [userId]
  );

  // Hourly buckets
  await client.query(
    `INSERT INTO metrics_timeseries ("userId", bucket, granularity, "tradeCount", "winRate", pnl, "avgPlanAdherence", "updatedAt")
     SELECT
       "userId",
       DATE_TRUNC('hour', "exitAt") AS bucket,
       'hourly',
       COUNT(*),
       COUNT(*) FILTER (WHERE outcome='win')::float / NULLIF(COUNT(*),0),
       SUM(pnl),
       AVG("planAdherence"),
       NOW()
     FROM trades
     WHERE "userId" = $1 AND status = 'closed' AND "exitAt" IS NOT NULL
     GROUP BY "userId", DATE_TRUNC('hour', "exitAt")
     ON CONFLICT ("userId", bucket, granularity) DO UPDATE SET
       "tradeCount"       = EXCLUDED."tradeCount",
       "winRate"          = EXCLUDED."winRate",
       pnl                = EXCLUDED.pnl,
       "avgPlanAdherence" = EXCLUDED."avgPlanAdherence",
       "updatedAt"        = NOW()`,
    [userId]
  );
}

/**
 * Check overtrading: >10 trades in any 30-min sliding window
 * Uses DB-side window function for O(1) performance instead of O(n²) app-side
 */
async function checkOvertrading(userId) {
  const client = await pool.connect();
  try {
    // Use SQL window functions to detect overtrading in a single query
    // This replaces the O(n²) JS loop with a single DB round-trip
    const res = await client.query(
      `WITH recent_trades AS (
        SELECT "entryAt", "tradeId",
               COUNT(*) OVER (
                 ORDER BY "entryAt"
                 ROWS BETWEEN 10 PRECEDING AND CURRENT ROW
               ) AS window_count
        FROM trades
        WHERE "userId" = $1 AND "entryAt" > NOW() - INTERVAL '1 hour'
        ORDER BY "entryAt"
      )
      SELECT "entryAt", "tradeId", window_count
      FROM recent_trades
      WHERE window_count > 10
      LIMIT 1`,
      [userId]
    );

    if (res.rows.length > 0) {
      const { entryAt, window_count } = res.rows[0];
      const windowStart = new Date(entryAt.getTime() - 30 * 60 * 1000);
      const windowEnd = new Date(entryAt.getTime());

      await client.query(
        `INSERT INTO overtrading_events ("userId", window_start, window_end, trade_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [userId, windowStart.toISOString(), windowEnd.toISOString(), window_count]
      );
      console.log(JSON.stringify({ event: 'overtrading_detected', userId, count: window_count }));
    }
  } finally {
    client.release();
  }
}

async function main() {
  const broker = await connect();

  broker.prefetch(10);

  // Consumer for trade.closed events (metrics computation)
  broker.consume(QUEUE_METRICS, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      const { userId, tradeId, entryAt } = payload;

      // Compute revenge flag asynchronously when emotionalState might be set
      if (payload.eventType === 'trade.closed') {
        // Get the trade's emotionalState from DB for revenge flag computation
        const tradeRes = await pool.query(
          `SELECT "emotionalState" FROM trades WHERE "tradeId" = $1`,
          [tradeId]
        );
        if (tradeRes.rows.length > 0) {
          const { emotionalState } = tradeRes.rows[0];
          await updateRevengeFlag(tradeId, userId, entryAt, emotionalState);
        }
      }

      await computeMetrics(userId);
      broker.ack(msg);
      console.log(JSON.stringify({ event: 'metrics_computed', userId }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'worker_error', error: err.message }));
      broker.nack(msg, false, false);
    }
  }, { noAck: false });

  // Consumer for trade.opened events (overtrading detection)
  broker.consume(QUEUE_OVERTRADE, async (msg) => {
    if (!msg) return;
    try {
      const payload = JSON.parse(msg.content.toString());
      const { userId } = payload;
      await checkOvertrading(userId);
      broker.ack(msg);
      console.log(JSON.stringify({ event: 'overtrading_checked', userId }));
    } catch (err) {
      console.error(JSON.stringify({ event: 'overtrading_worker_error', error: err.message }));
      broker.nack(msg, false, false);
    }
  }, { noAck: false });

  console.log(JSON.stringify({ event: 'worker_started', queues: [QUEUE_METRICS, QUEUE_OVERTRADE] }));
}

main().catch(err => {
  console.error(JSON.stringify({ event: 'worker_fatal', error: err.message }));
  process.exit(1);
});
