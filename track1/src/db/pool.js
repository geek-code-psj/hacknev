'use strict';
const { Pool } = require('pg');
const dns = require('dns');
const { promisify } = require('util');
const resolve4 = promisify(dns.resolve4);

// Parse DATABASE_URL if provided (Railway, etc.)
console.log('>>> DB CONFIG: DATABASE_URL set:', !!process.env.DATABASE_URL);

const resolve6 = promisify(dns.resolve6);

async function resolveHost(hostname) {
  // Try IPv4 first
  try {
    const addresses = await resolve4(hostname);
    console.log('>>> DNS: resolved ' + hostname + ' (A) -> ' + addresses[0]);
    return addresses[0];
  } catch (e) {
    console.log('>>> DNS: A record failed, trying AAAA:', e.message);
  }
  // Try IPv6
  try {
    const addresses = await resolve6(hostname);
    console.log('>>> DNS: resolved ' + hostname + ' (AAAA) -> ' + addresses[0]);
    return addresses[0];
  } catch (e) {
    console.log('>>> DNS: AAAA record failed:', e.message);
  }
  return hostname;
}

async function initPool() {
  let pgConfig = {};

  if (process.env.DATABASE_URL) {
    try {
      // URL may have special chars - try to parse, fallback to manual parsing
      let url;
      try {
        url = new URL(process.env.DATABASE_URL);
      } catch {
        // Manual parse as fallback
        console.log('>>> DB: using manual parse');
        const match = process.env.DATABASE_URL.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
        if (match) {
          pgConfig = {
            host: match[3],
            port: parseInt(match[4]),
            database: match[5],
            user: match[1],
            password: match[2],
          };
        } else {
          throw new Error('Cannot parse DATABASE_URL');
        }
      }
      if (url) {
        pgConfig = {
          host: url.hostname,
          port: parseInt(url.port || '5432'),
          database: url.pathname.replace('/', ''),
          user: url.username,
          password: url.password,
        };
      }
    } catch (e) {
      console.error('>>> DB URL PARSE ERROR:', e.message, 'URL:', process.env.DATABASE_URL?.substring(0, 50));
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
    ssl: { rejectUnauthorized: false },
    // Force IPv4 only
    family: 4,
  });

  pool.on('error', (err) => {
    console.error('>>> PG POOL ERROR:', err.message);
  });

  return pool;
}

module.exports = { initPool };