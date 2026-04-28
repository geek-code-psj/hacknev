'use strict';
const express = require('express');
const { validate: isUUID } = require('uuid');
const pool = require('../db/pool');
const { tenancyCheck } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

/**
 * GET /users/:userId/metrics
 * Query params: from, to, granularity (hourly|daily|rolling30d)
 *
 * p95 latency target: <= 200ms — served from precomputed tables + indexed queries.
 */
router.get('/', tenancyCheck, async (req, res) => {
  const { traceId } = req;
  const { userId }  = req.params;

  if (!isUUID(userId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid userId', traceId });
  }

  const { from, to, granularity = 'daily' } = req.query;
  if (!['hourly','daily','rolling30d'].includes(granularity)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'granularity must be hourly|daily|rolling30d', traceId });
  }

  // Fetch precomputed summary
  const metaRes = await pool.query(
    `SELECT * FROM user_metrics WHERE "userId" = $1`, [userId]
  );
  const meta = metaRes.rows[0] || {};

  // Fetch timeseries with date filtering
  let tsQuery, tsParams;
  if (granularity === 'rolling30d') {
    // rolling30d: one bucket per day over the last 30 days
    tsQuery = `
      SELECT bucket, "tradeCount", "winRate", pnl, "avgPlanAdherence"
      FROM metrics_timeseries
      WHERE "userId" = $1
        AND granularity = 'daily'
        AND bucket >= NOW() - INTERVAL '30 days'
      ORDER BY bucket`;
    tsParams = [userId];
  } else {
    const conditions = [`"userId" = $1`, `granularity = $2`];
    tsParams = [userId, granularity];
    if (from) { tsParams.push(from); conditions.push(`bucket >= $${tsParams.length}`); }
    if (to)   { tsParams.push(to);   conditions.push(`bucket <= $${tsParams.length}`); }
    tsQuery = `
      SELECT bucket, "tradeCount", "winRate", pnl, "avgPlanAdherence"
      FROM metrics_timeseries
      WHERE ${conditions.join(' AND ')}
      ORDER BY bucket`;
  }

  const tsRes = await pool.query(tsQuery, tsParams);

  return res.json({
    userId,
    granularity,
    from: from ?? null,
    to:   to ?? null,
    planAdherenceScore:      meta.planAdherenceScore != null ? parseFloat(meta.planAdherenceScore) : null,
    sessionTiltIndex:        meta.sessionTiltIndex   != null ? parseFloat(meta.sessionTiltIndex)   : null,
    winRateByEmotionalState: meta.winRateByEmotionalState ?? {},
    revengeTrades:           meta.revengeTrades   ?? 0,
    overtradingEvents:       meta.overtradingEvents ?? 0,
    timeseries: tsRes.rows.map(r => ({
      bucket:           r.bucket,
      tradeCount:       r.tradeCount,
      winRate:          r.winRate != null ? parseFloat(r.winRate) : null,
      pnl:              r.pnl     != null ? parseFloat(r.pnl)     : null,
      avgPlanAdherence: r.avgPlanAdherence != null ? parseFloat(r.avgPlanAdherence) : null,
    })),
  });
});

/**
 * GET /users/:userId/profile
 */
router.get('/profile', tenancyCheck, async (req, res) => {
  const { traceId } = req;
  const { userId }  = req.params;

  if (!isUUID(userId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid userId', traceId });
  }

  // Compute basic behavioral profile from trades
  const dominantRes = await pool.query(
    `SELECT "emotionalState",
            COUNT(*) FILTER (WHERE outcome='win') AS wins,
            COUNT(*) FILTER (WHERE outcome='loss') AS losses,
            COUNT(*) AS total
     FROM trades
     WHERE "userId" = $1 AND status='closed'
     GROUP BY "emotionalState"`,
    [userId]
  );

  // Revenge trading evidence
  const revengeRes = await pool.query(
    `SELECT "sessionId", "tradeId" FROM trades
     WHERE "userId" = $1 AND "revengeFlag" = true`,
    [userId]
  );

  // Peak performance window
  const peakRes = await pool.query(
    `SELECT EXTRACT(HOUR FROM "entryAt") AS hr,
            COUNT(*) FILTER (WHERE outcome='win')::float / NULLIF(COUNT(*),0) AS wr,
            COUNT(*) AS cnt
     FROM trades
     WHERE "userId" = $1 AND status='closed'
     GROUP BY hr ORDER BY wr DESC NULLS LAST LIMIT 1`,
    [userId]
  );

  const peak = peakRes.rows[0];

  const pathologies = [];
  if (revengeRes.rows.length >= 2) {
    pathologies.push({
      pathology:        'revenge_trading',
      confidence:       Math.min(revengeRes.rows.length / 5, 1.0),
      evidenceSessions: [...new Set(revengeRes.rows.map(r => r.sessionId))],
      evidenceTrades:   revengeRes.rows.map(r => r.tradeId),
    });
  }

  const strengths = dominantRes.rows
    .filter(r => r.wins / r.total > 0.6)
    .map(r => `Strong win rate when ${r.emotionalState} (${Math.round(r.wins/r.total*100)}%)`);

  return res.json({
    userId,
    generatedAt: new Date().toISOString(),
    dominantPathologies: pathologies,
    strengths,
    peakPerformanceWindow: peak ? {
      startHour: parseInt(peak.hr),
      endHour:   parseInt(peak.hr) + 1,
      winRate:   parseFloat(parseFloat(peak.wr).toFixed(4)),
    } : null,
  });
});

module.exports = router;
