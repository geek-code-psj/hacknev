'use strict';
require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const store          = require('./memory/store');
const { authMiddleware } = require('./middleware/auth');
const memoryRouter   = require('./routes/memory');
const sessionsRouter = require('./routes/sessions');
const profileRouter  = require('./routes/profile');

const app  = express();
const PORT = parseInt(process.env.PORT || '3001');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  req.traceId   = uuidv4();
  req.startTime = Date.now();
  next();
});

app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(JSON.stringify({
      traceId:    req.traceId,
      userId:     req.user?.userId || null,
      method:     req.method,
      path:       req.path,
      latency:    Date.now() - req.startTime,
      statusCode: res.statusCode,
    }));
  });
  next();
});

// Health (public)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(authMiddleware);
app.use('/memory',                memoryRouter);
app.use('/session',               sessionsRouter);
app.use('/sessions',              sessionsRouter);
app.use('/users/:userId/profile', profileRouter);

// Hallucination audit - mount the sessionsRouter with /audit prefix
// This allows router.post('/audit', ...) to work at /audit
const { auditHandler } = require('./routes/sessions');
app.use('/audit', auditHandler);

app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found.', traceId: req.traceId });
});

app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ event: 'unhandled_error', error: err.message, traceId: req.traceId }));
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected error.', traceId: req.traceId });
});

async function start() {
  await store.init();
  console.log(JSON.stringify({ event: 'memory_store_ready' }));
  app.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'server_ready', port: PORT }));
  });
}

start().catch(err => {
  console.error(JSON.stringify({ event: 'startup_fatal', error: err.message }));
  process.exit(1);
});

module.exports = app;
