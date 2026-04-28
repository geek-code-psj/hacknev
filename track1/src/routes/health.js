'use strict';
const express = require('express');
const pool    = require('../db/pool');
const broker  = require('../queue/broker');

const router = express.Router();

router.get('/', async (req, res) => {
  let dbConnection = 'disconnected';
  let queueLag     = -1;

  try {
    await pool.query('SELECT 1');
    dbConnection = 'connected';
  } catch {}

  try {
    const ch = broker.getChannel();
    if (ch) {
      const q = await ch.checkQueue(broker.QUEUE_METRICS);
      queueLag = q.messageCount || 0;
    }
  } catch {
    queueLag = -1;
  }

  const status = dbConnection === 'connected' ? 'ok' : 'degraded';

  return res.status(status === 'ok' ? 200 : 503).json({
    status,
    dbConnection,
    queueLag,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
