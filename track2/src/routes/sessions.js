'use strict';
const express  = require('express');
const { validate: isUUID } = require('uuid');
const { streamCoaching, generateCoaching } = require('../coaching');
const { detectSignals } = require('../profiler');
const store    = require('../memory/store');
const { tenancyCheck } = require('../middleware/auth');

const router = express.Router();

// In-memory session trade buffer (keyed by sessionId)
// Stores { userId, trades[] } to enforce tenancy
const sessionBuffer = new Map();

/**
 * POST /session/events
 * Accept a stream of sequential trades during a live session.
 * Detects behavioral signals and stores them.
 */
router.post('/events', async (req, res) => {
  const { traceId } = req;
  const { sessionId, userId, trades } = req.body;

  if (!sessionId || !userId || !Array.isArray(trades)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'sessionId, userId, and trades[] are required', traceId });
  }

  if (req.user.userId !== userId) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Cross-tenant access denied.', traceId });
  }

  // Get existing buffer or create new
  const existing = sessionBuffer.get(sessionId);
  const existingTrades = existing?.userId === userId ? existing.trades : [];
  const merged = [...existingTrades, ...trades].sort((a, b) => new Date(a.entryAt) - new Date(b.entryAt));

  // Store with userId for tenancy verification
  sessionBuffer.set(sessionId, { userId, trades: merged });

  const signals = detectSignals(merged);

  return res.json({ sessionId, tradeCount: merged.length, signals });
});

/**
 * GET /sessions/:sessionId/coaching  (SSE endpoint)
 * Streams coaching tokens as they arrive from Claude.
 * Degrades gracefully on connection drop.
 *
 * Note: userId is taken from JWT (req.user.userId), not from params.
 * The session buffer is keyed by sessionId and stores userId with the trades,
 * so we verify ownership by checking if the session belongs to the authenticated user.
 */
router.get('/:sessionId/coaching', async (req, res) => {
  const { sessionId } = req.params;
  const userId = req.user.userId;

  if (!isUUID(sessionId)) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Invalid sessionId', traceId: req.traceId });
  }

  // Get trades from buffer - must belong to this user
  const bufferEntry = sessionBuffer.get(sessionId);
  const trades = bufferEntry?.userId === userId ? bufferEntry.trades : [];

  // Handle client disconnect
  req.on('close', () => {
    // Clean up if client disconnects
  });

  try {
    await streamCoaching(res, userId, trades, sessionId);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: 'COACHING_UNAVAILABLE', message: err.message, traceId: req.traceId });
    } else {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      } catch {}
    }
  }
});

/**
 * POST /audit
 * Accepts a coaching response body and returns each referenced sessionId
 * with a found|notfound flag. Anti-hallucination endpoint.
 */
router.post('/audit', async (req, res) => {
  const { traceId } = req;
  const { userId, coachingResponse } = req.body;

  if (!userId || !coachingResponse) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'userId and coachingResponse are required', traceId });
  }

  // Extract UUID references from the coaching response text
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const referenced  = [...new Set(coachingResponse.match(uuidPattern) || [])];

  const results = referenced.map(sessionId => {
    const found = store.getSession(userId, sessionId) !== null;
    return { sessionId, status: found ? 'found' : 'notfound' };
  });

  const hallucinations = results.filter(r => r.status === 'notfound');

  return res.json({
    userId,
    referencedSessionIds: results,
    hallucinationCount:   hallucinations.length,
    isClean:              hallucinations.length === 0,
  });
});

// Simple audit router for mounting at /audit
const auditRouter = express.Router();
auditRouter.post('/', async (req, res) => {
  const { traceId } = req;
  const { userId, coachingResponse } = req.body;

  if (!userId || !coachingResponse) {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'userId and coachingResponse are required', traceId });
  }

  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const referenced  = [...new Set(coachingResponse.match(uuidPattern) || [])];

  const results = referenced.map(sessionId => {
    const found = store.getSession(userId, sessionId) !== null;
    return { sessionId, status: found ? 'found' : 'notfound' };
  });

  const hallucinations = results.filter(r => r.status === 'notfound');

  return res.json({
    userId,
    referencedSessionIds: results,
    hallucinationCount:   hallucinations.length,
    isClean:              hallucinations.length === 0,
  });
});

module.exports = router;
module.exports.auditHandler = auditRouter;
