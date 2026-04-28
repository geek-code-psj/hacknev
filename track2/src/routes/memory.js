'use strict';
const express = require('express');
const { validate: isUUID } = require('uuid');
const store   = require('../memory/store');
const { tenancyCheck } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

/**
 * PUT /memory/:userId/sessions/:sessionId
 * Persist a session summary after a session ends.
 */
router.put('/:userId/sessions/:sessionId', tenancyCheck, (req, res) => {
  const { traceId } = req;
  const { userId, sessionId } = req.params;

  if (!isUUID(userId) || !isUUID(sessionId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid UUID', traceId });
  }

  const { summary, metrics, tags } = req.body;
  if (!summary || !metrics) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'summary and metrics are required', traceId });
  }

  store.putSession(userId, sessionId, { summary, metrics, tags: tags || [] });

  return res.json({
    userId, sessionId,
    storedAt: new Date().toISOString(),
    message: 'Session memory stored successfully',
  });
});

/**
 * GET /memory/:userId/context?relevantTo={signal}
 * Query memory for context before generating a coaching message.
 */
router.get('/:userId/context', tenancyCheck, (req, res) => {
  const { userId }    = req.params;
  const { relevantTo } = req.query;
  const context = store.getContext(userId, relevantTo || '');
  return res.json(context);
});

/**
 * GET /memory/:userId/sessions/:sessionId
 * Retrieve a specific session for hallucination audit.
 * Returns raw session record exactly as stored.
 */
router.get('/:userId/sessions/:sessionId', tenancyCheck, (req, res) => {
  const { traceId } = req;
  const { userId, sessionId } = req.params;

  if (!isUUID(userId) || !isUUID(sessionId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid UUID', traceId });
  }

  const session = store.getSession(userId, sessionId);
  if (!session) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Session not found in memory.', traceId });
  }
  return res.json(session);
});

module.exports = router;
