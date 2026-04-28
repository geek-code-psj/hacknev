'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'nevup',
  user:     process.env.DB_USER     || 'nevup',
  password: process.env.DB_PASSWORD || 'nevup_secret',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ event: 'pg_pool_error', error: err.message }));
});

module.exports = pool;
