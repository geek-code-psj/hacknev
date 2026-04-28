'use strict';
require('dotenv').config();

const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const { v4: uuidv4 } = require('uuid');

const { migrate }        = require('./db/migrate');
const { seed }           = require('./db/seed');
const broker             = require('./queue/broker');
const { authMiddleware } = require('./middleware/auth');
const { logger }         = require('./middleware/logger');

const tradesRouter  = require('./routes/trades');
const sessionsRouter = require('./routes/sessions');
const usersRouter   = require('./routes/users');
const healthRouter  = require('./routes/health');

const app  = express();
const PORT = parseInt(process.env.PORT || '3000');

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Assign traceId before auth so it's available in all responses
app.use((req, _res, next) => {
  req.traceId  = uuidv4();
  req.startTime = Date.now();
  next();
});

app.use(logger);

// Public
app.use('/health', healthRouter);

// Protected
app.use(authMiddleware);
app.use('/trades',                  tradesRouter);
app.use('/sessions',                sessionsRouter);
app.use('/users/:userId/metrics',   usersRouter);
app.use('/users/:userId/profile',   (req, res, next) => {
  // mount the profile sub-route
  req.params.userId = req.params.userId;
  next();
}, usersRouter);

// 404 catch-all
app.use((req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found.', traceId: req.traceId });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({ event: 'unhandled_error', error: err.message, traceId: req.traceId }));
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', traceId: req.traceId });
});

async function start() {
  try {
    console.log(JSON.stringify({ event: 'startup', step: 'migrate' }));
    await migrate();

    console.log(JSON.stringify({ event: 'startup', step: 'seed' }));
    await seed();

    // RabbitMQ is optional - continue without it if unavailable
    if (process.env.RABBITMQ_URL !== 'none') {
      console.log(JSON.stringify({ event: 'startup', step: 'broker' }));
      try {
        await broker.connect();
      } catch (brokerErr) {
        console.error(JSON.stringify({ event: 'broker_skip', error: brokerErr.message }));
      }
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(JSON.stringify({ event: 'server_ready', port: PORT }));
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'startup_fatal', error: err.message, stack: err.stack }));
    process.exit(1);
  }
}

start();

module.exports = app; // for tests
