'use strict';
const { Pool } = require('pg');

// Parse DATABASE_URL if provided (Railway, etc.)
let pgConfig = {};
console.log(JSON.stringify({ event: 'db_config', DATABASE_URL: !!process.env.DATABASE_URL }));

if (process.env.DATABASE_URL) {
  try {
    const url = new URL(process.env.DATABASE_URL);
    pgConfig = {
      host: url.hostname,
      port: parseInt(url.port || '5432'),
      database: url.pathname.replace('/', ''),
      user: url.username,
      password: url.password,
    };
    console.log(JSON.stringify({ event: 'db_config', host: pgConfig.host, port: pgConfig.port, database: pgConfig.database }));
  } catch (e) {
    console.error(JSON.stringify({ event: 'db_url_parse_error', error: e.message, stack: e.stack }));
  }
} else {
  pgConfig = {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'nevup',
    user:     process.env.DB_USER     || 'nevup',
    password: process.env.DB_PASSWORD || 'nevup_secret',
  };
  console.log(JSON.stringify({ event: 'db_config', host: pgConfig.host, port: pgConfig.port, using: 'env_vars' }));
}

const pool = new Pool({
  ...pgConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ event: 'pg_pool_error', error: err.message, stack: err.stack }));
});

module.exports = pool;
