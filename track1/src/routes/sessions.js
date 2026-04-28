'use strict';
const express = require('express');
const { validate: isUUID } = require('uuid');
const pool = require('../db/pool');

const router = express.Router();

// GET /sessions/:sessionId
router.get('/:sessionId', async (req, res) => {
  const { traceId } = req;
  const { sessionId } = req.params;

  if (!isUUID(sessionId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid sessionId', traceId });
  }

  const tradesRes = await pool.query(
    `SELECT * FROM trades WHERE "sessionId" = $1 ORDER BY "entryAt"`,
    [sessionId]
  );

  if (tradesRes.rows.length === 0) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Session not found.', traceId });
  }

  const trades = tradesRes.rows;
  const userId = trades[0].userId;

  if (req.user.userId !== userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  const wins    = trades.filter(t => t.outcome === 'win').length;
  const closed  = trades.filter(t => t.status === 'closed').length;
  const totalPnl = trades.reduce((s, t) => s + (parseFloat(t.pnl) || 0), 0);

  return res.json({
    sessionId,
    userId,
    date:       trades[0].entryAt,
    notes:      null,
    tradeCount: trades.length,
    winRate:    closed > 0 ? wins / closed : 0,
    totalPnl:   parseFloat(totalPnl.toFixed(2)),
    trades:     trades.map(formatTrade),
  });
});

// POST /sessions/:sessionId/debrief
router.post('/:sessionId/debrief', async (req, res) => {
  const { traceId } = req;
  const { sessionId } = req.params;

  if (!isUUID(sessionId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid sessionId', traceId });
  }

  const { overallMood, planAdherenceRating, keyMistake, keyLesson, willReviewTomorrow } = req.body;
  if (!overallMood || !planAdherenceRating) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'overallMood and planAdherenceRating are required', traceId });
  }

  // Verify session belongs to user
  const check = await pool.query(
    `SELECT "userId" FROM trades WHERE "sessionId" = $1 LIMIT 1`, [sessionId]
  );
  if (check.rows.length === 0) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Session not found.', traceId });
  }
  if (req.user.userId !== check.rows[0].userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  return res.status(200).json({
    sessionId,
    userId: req.user.userId,
    overallMood,
    planAdherenceRating,
    keyMistake:          keyMistake ?? null,
    keyLesson:           keyLesson ?? null,
    willReviewTomorrow:  willReviewTomorrow ?? false,
    submittedAt:         new Date().toISOString(),
  });
});

function formatTrade(row) {
  return {
    tradeId:        row.tradeId,
    userId:         row.userId,
    sessionId:      row.sessionId,
    asset:          row.asset,
    assetClass:     row.assetClass,
    direction:      row.direction,
    entryPrice:     parseFloat(row.entryPrice),
    exitPrice:      row.exitPrice != null ? parseFloat(row.exitPrice) : null,
    quantity:       parseFloat(row.quantity),
    entryAt:        row.entryAt,
    exitAt:         row.exitAt ?? null,
    status:         row.status,
    outcome:        row.outcome ?? null,
    pnl:            row.pnl != null ? parseFloat(row.pnl) : null,
    planAdherence:  row.planAdherence ?? null,
    emotionalState: row.emotionalState ?? null,
    entryRationale: row.entryRationale ?? null,
    revengeFlag:    row.revengeFlag,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

module.exports = router;
