'use strict';
const { Pool } = require('pg');
const dns = require('dns');
const { promisify } = require('util');
const resolve4 = promisify(dns.resolve4);

// Parse DATABASE_URL if provided (Railway, etc.)
console.log('>>> DB CONFIG: DATABASE_URL set:', !!process.env.DATABASE_URL);

async function resolveHostToIPv4(hostname) {
  try {
    const addresses = await resolve4(hostname);
    console.log('>>> DNS: resolved ' + hostname + ' -> ' + addresses[0]);
    return addresses[0];
  } catch (e) {
    console.log('>>> DNS: resolution failed, using original:', e.message);
    return hostname;
  }
}

async function initPool() {
  let pgConfig = {};

  if (process.env.DATABASE_URL) {
    try {
      const url = new URL(process.env.DATABASE_URL);
      const hostname = url.hostname;
      // Force IPv4 to avoid Supabase IPv6 routing issues on Railway
      const resolvedHost = await resolveHostToIPv4(hostname);
      pgConfig = {
        host: resolvedHost,
        port: parseInt(url.port || '5432'),
        database: url.pathname.replace('/', ''),
        user: url.username,
        password: url.password,
      };
    } catch (e) {
      console.error('>>> DB URL PARSE ERROR:', e.message);
    }
  } else {
    pgConfig = {
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME     || 'nevup',
      user:     process.env.DB_USER     || 'nevup',
      password: process.env.DB_PASSWORD || 'nevup_secret',
    };
  }

  console.log('>>> DB CONFIG: host=' + pgConfig.host + ', port=' + pgConfig.port + ', db=' + pgConfig.database);

  const pool = new Pool({
    ...pgConfig,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('>>> PG POOL ERROR:', err.message);
  });

  return pool;
}

module.exports = { initPool };