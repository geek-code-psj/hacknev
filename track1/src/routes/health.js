'use strict';
const express = require('express');
const { initPool } = require('../db/pool');
const broker  = require('../queue/broker');

const router = express.Router();

let _pool = null;

async function getPool() {
  if (!_pool) {
    _pool = await initPool();
  }
  return _pool;
}

router.get('/', async (req, res) => {
  let dbConnection = 'disconnected';
  let queueLag     = -1;

  try {
    const p = await getPool();
    await p.query('SELECT 1');
    dbConnection = 'connected';
  } catch {
    dbConnection = 'disconnected';
  }

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