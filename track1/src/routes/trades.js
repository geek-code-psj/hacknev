'use strict';
const express = require('express');
const { v4: uuidv4, validate: isUUID } = require('uuid');
const pool   = require('../db/pool');
const broker = require('../queue/broker');
const { tenancyCheck } = require('../middleware/auth');

const router = express.Router();

// ─── Validation helpers ─────────────────────────────────────────────────────

function validateTradeInput(body) {
  const errors = [];
  const required = ['tradeId','userId','sessionId','asset','assetClass','direction','entryPrice','quantity','entryAt','status'];
  for (const f of required) {
    if (body[f] == null || body[f] === '') errors.push(`${f} is required`);
  }
  if (!['equity','crypto','forex'].includes(body.assetClass)) errors.push('invalid assetClass');
  if (!['long','short'].includes(body.direction))              errors.push('invalid direction');
  if (!['open','closed','cancelled'].includes(body.status))   errors.push('invalid status');
  if (body.emotionalState && !['calm','anxious','greedy','fearful','neutral'].includes(body.emotionalState))
    errors.push('invalid emotionalState');
  if (body.planAdherence != null && (body.planAdherence < 1 || body.planAdherence > 5))
    errors.push('planAdherence must be 1-5');
  if (body.entryRationale && body.entryRationale.length > 500)
    errors.push('entryRationale too long (max 500)');
  if (!isUUID(body.tradeId))  errors.push('tradeId must be UUIDv4');
  if (!isUUID(body.userId))   errors.push('userId must be UUIDv4');
  if (!isUUID(body.sessionId)) errors.push('sessionId must be UUIDv4');
  return errors;
}

// ─── POST /trades — idempotent create ───────────────────────────────────────

router.post('/', async (req, res) => {
  const { traceId } = req;
  const errors = validateTradeInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: errors.join('; '), traceId });
  }

  // Tenancy: userId in body must match JWT sub
  if (req.user.userId !== req.body.userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  const client = await pool.connect();
  try {
    // Atomic idempotent insert - no race condition
    // If tradeId exists, DO UPDATE just returns the existing row (no actual change)
    const { rows } = await client.query(
      `INSERT INTO trades (
        "tradeId","userId","sessionId",asset,"assetClass",direction,
        "entryPrice","exitPrice",quantity,"entryAt","exitAt",status,
        outcome,pnl,"planAdherence","emotionalState","entryRationale","revengeFlag"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT ("tradeId") DO UPDATE SET "tradeId" = EXCLUDED."tradeId"
      RETURNING *`,
      [
        req.body.tradeId, req.body.userId, req.body.sessionId,
        req.body.asset, req.body.assetClass, req.body.direction,
        req.body.entryPrice,
        req.body.exitPrice ?? null,
        req.body.quantity,
        req.body.entryAt,
        req.body.exitAt ?? null,
        req.body.status,
        req.body.outcome ?? null,
        req.body.pnl ?? null,
        req.body.planAdherence ?? null,
        req.body.emotionalState ?? null,
        req.body.entryRationale ?? null,
        false, // Revenge flag computed asynchronously in worker
      ]
    );

    const trade = rows[0];

    // Publish to async pipeline — fire and forget, never blocks write
    // Worker will compute revenge flag and check overtrading
    if (trade.status === 'closed') {
      broker.publish('trade.closed', { eventType: 'trade.closed', tradeId: trade.tradeId, userId: trade.userId, entryAt: trade.entryAt });
    } else {
      broker.publish('trade.opened', { eventType: 'trade.opened', tradeId: trade.tradeId, userId: trade.userId, entryAt: trade.entryAt });
    }

    return res.status(200).json(formatTrade(trade));
  } finally {
    client.release();
  }
});

// ─── GET /trades/:tradeId ───────────────────────────────────────────────────

router.get('/:tradeId', async (req, res) => {
  const { traceId } = req;
  const { tradeId } = req.params;

  if (!isUUID(tradeId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid tradeId', traceId });
  }

  const { rows } = await pool.query('SELECT * FROM trades WHERE "tradeId" = $1', [tradeId]);
  if (rows.length === 0) {
    return res.status(404).json({ error: 'TRADE_NOT_FOUND', message: 'Trade not found.', traceId });
  }

  const trade = rows[0];
  // Tenancy
  if (req.user.userId !== trade.userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  return res.json(formatTrade(trade));
});

// ─── PATCH /trades/:tradeId — update (close a trade) ───────────────────────

router.patch('/:tradeId', async (req, res) => {
  const { traceId } = req;
  const { tradeId } = req.params;

  if (!isUUID(tradeId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid tradeId', traceId });
  }

  const { rows } = await pool.query('SELECT * FROM trades WHERE "tradeId" = $1', [tradeId]);
  if (rows.length === 0) {
    return res.status(404).json({ error: 'TRADE_NOT_FOUND', message: 'Trade not found.', traceId });
  }

  const trade = rows[0];
  if (req.user.userId !== trade.userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  const allowed = ['exitPrice','exitAt','status','outcome','pnl','planAdherence','emotionalState','entryRationale'];
  const updates = [];
  const values  = [];
  let idx = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`"${key}" = $${idx++}`);
      values.push(req.body[key]);
    }
  }
  if (updates.length === 0) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'No updatable fields provided.', traceId });
  }
  updates.push(`"updatedAt" = NOW()`);
  values.push(tradeId);

  const { rows: updated } = await pool.query(
    `UPDATE trades SET ${updates.join(', ')} WHERE "tradeId" = $${idx} RETURNING *`,
    values
  );

  if (updated[0].status === 'closed') {
    broker.publish('trade.closed', { eventType: 'trade.closed', tradeId: updated[0].tradeId, userId: updated[0].userId });
  }

  return res.json(formatTrade(updated[0]));
});

function formatTrade(row) {
  // Return numeric values as strings to preserve PostgreSQL NUMERIC(18,8) precision
  // Clients can parse as needed; this avoids IEEE 754 float precision loss for crypto
  return {
    tradeId:        row.tradeId,
    userId:         row.userId,
    sessionId:      row.sessionId,
    asset:          row.asset,
    assetClass:     row.assetClass,
    direction:      row.direction,
    entryPrice:     String(row.entryPrice),
    exitPrice:      row.exitPrice != null ? String(row.exitPrice) : null,
    quantity:       String(row.quantity),
    entryAt:        row.entryAt,
    exitAt:         row.exitAt ?? null,
    status:         row.status,
    outcome:        row.outcome ?? null,
    pnl:            row.pnl != null ? String(row.pnl) : null,
    planAdherence:  row.planAdherence ?? null,
    emotionalState: row.emotionalState ?? null,
    entryRationale: row.entryRationale ?? null,
    revengeFlag:    row.revengeFlag,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

module.exports = router;
