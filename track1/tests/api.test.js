'use strict';
/**
 * Track 1 — Automated Tests
 * Tests: idempotency, cross-tenant 403, auth validation
 *
 * Run: npm test
 * (Requires running Postgres — set TEST_DB_* env vars or run inside docker-compose)
 */
const request = require('supertest');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ── JWT helpers ──────────────────────────────────────────────────────────────
const SECRET = '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function mintToken(userId, name = 'Test User') {
  const now = Math.floor(Date.now() / 1000);
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + 86400, role: 'trader', name }));
  const sig = crypto.createHmac('sha256', SECRET)
    .update(`${header}.${payload}`).digest('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${header}.${payload}.${sig}`;
}

// ── App ──────────────────────────────────────────────────────────────────────
// In CI the app is already running — use supertest against the live process.
// For unit tests, we can import the app if the DB is reachable.
let app;

beforeAll(async () => {
  // Set test DB env (fallback to defaults if running inside docker)
  process.env.DB_HOST     = process.env.DB_HOST     || 'localhost';
  process.env.DB_NAME     = process.env.DB_NAME     || 'nevup';
  process.env.DB_USER     = process.env.DB_USER     || 'nevup';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'nevup_secret';
  process.env.RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://nevup:nevup_secret@localhost:5672';

  // Lazy import to respect env overrides
  app = require('../src/index');
  // Give startup a moment
  await new Promise(r => setTimeout(r, 2000));
}, 15000);

// ── Test data ────────────────────────────────────────────────────────────────
const USER_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

function makeTrade(userId, overrides = {}) {
  return {
    tradeId:        uuidv4(),
    userId,
    sessionId:      uuidv4(),
    asset:          'AAPL',
    assetClass:     'equity',
    direction:      'long',
    entryPrice:     150.00,
    quantity:       10,
    entryAt:        new Date().toISOString(),
    status:         'open',
    emotionalState: 'calm',
    entryRationale: 'Test trade',
    ...overrides,
  };
}

// ── Auth Tests ────────────────────────────────────────────────────────────────
describe('Authentication', () => {
  test('rejects request with no Authorization header → 401', async () => {
    const res = await request(app).post('/trades').send(makeTrade(USER_A));
    expect(res.status).toBe(401);
    expect(res.body.traceId).toBeDefined();
  });

  test('rejects expired token → 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: USER_A, iat: now - 90000, exp: now - 3600, role: 'trader' }));
    const sig = crypto.createHmac('sha256', SECRET)
      .update(`${header}.${payload}`).digest('base64')
      .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
    const token = `${header}.${payload}.${sig}`;

    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${token}`)
      .send(makeTrade(USER_A));
    expect(res.status).toBe(401);
  });

  test('rejects malformed token → 401', async () => {
    const res = await request(app)
      .post('/trades')
      .set('Authorization', 'Bearer not.a.jwt')
      .send(makeTrade(USER_A));
    expect(res.status).toBe(401);
  });
});

// ── Multi-tenancy Tests ───────────────────────────────────────────────────────
describe('Multi-tenancy (cross-tenant 403)', () => {
  let tradeIdOfUserA;

  beforeAll(async () => {
    // Create a trade for User A
    const trade = makeTrade(USER_A, { status: 'closed', exitPrice: 160, exitAt: new Date().toISOString(), outcome: 'win', pnl: 100 });
    tradeIdOfUserA = trade.tradeId;
    await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${mintToken(USER_A)}`)
      .send(trade);
  });

  test('User B cannot read User A trade → 403', async () => {
    const res = await request(app)
      .get(`/trades/${tradeIdOfUserA}`)
      .set('Authorization', `Bearer ${mintToken(USER_B)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(res.body.traceId).toBeDefined();
  });

  test('User B cannot read User A metrics → 403', async () => {
    const res = await request(app)
      .get(`/users/${USER_A}/metrics`)
      .set('Authorization', `Bearer ${mintToken(USER_B)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  test('User A cannot post trade with User B userId in body → 403', async () => {
    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${mintToken(USER_A)}`)
      .send(makeTrade(USER_B));  // body has USER_B's id but token is USER_A
    expect(res.status).toBe(403);
  });
});

// ── Idempotency Tests ─────────────────────────────────────────────────────────
describe('POST /trades idempotency', () => {
  test('duplicate tradeId returns 200 with existing record', async () => {
    const trade = makeTrade(USER_A);
    const token = mintToken(USER_A);

    const res1 = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${token}`)
      .send(trade);
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${token}`)
      .send(trade);
    expect(res2.status).toBe(200);
    expect(res2.body.tradeId).toBe(trade.tradeId);
  });
});

// ── Validation Tests ──────────────────────────────────────────────────────────
describe('Input validation', () => {
  test('missing required fields → 400', async () => {
    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${mintToken(USER_A)}`)
      .send({ userId: USER_A, asset: 'AAPL' });  // missing many fields
    expect(res.status).toBe(400);
  });

  test('invalid assetClass → 400', async () => {
    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${mintToken(USER_A)}`)
      .send(makeTrade(USER_A, { assetClass: 'nft' }));
    expect(res.status).toBe(400);
  });

  test('planAdherence out of range → 400', async () => {
    const res = await request(app)
      .post('/trades')
      .set('Authorization', `Bearer ${mintToken(USER_A)}`)
      .send(makeTrade(USER_A, { planAdherence: 7 }));
    expect(res.status).toBe(400);
  });
});

// ── Metrics Read API ──────────────────────────────────────────────────────────
describe('GET /users/:userId/metrics', () => {
  test('returns metrics shape for seeded user', async () => {
    // Alex Mercer's userId from seed
    const alexId = 'f412f236-4edc-47a2-8f54-8763a6ed2ce8';
    const res = await request(app)
      .get(`/users/${alexId}/metrics?granularity=daily`)
      .set('Authorization', `Bearer ${mintToken(alexId)}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(alexId);
    expect(Array.isArray(res.body.timeseries)).toBe(true);
    expect(typeof res.body.winRateByEmotionalState).toBe('object');
  });

  test('responds in <200ms for seeded dataset', async () => {
    const alexId = 'f412f236-4edc-47a2-8f54-8763a6ed2ce8';
    const start = Date.now();
    const res = await request(app)
      .get(`/users/${alexId}/metrics?granularity=daily&from=2025-01-01T00:00:00Z&to=2025-03-31T23:59:59Z`)
      .set('Authorization', `Bearer ${mintToken(alexId)}`);
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(200);
  });
});

// ── Health ────────────────────────────────────────────────────────────────────
describe('GET /health', () => {
  test('returns ok status', async () => {
    const res = await request(app).get('/health');
    expect([200, 503]).toContain(res.status);
    expect(['ok','degraded']).toContain(res.body.status);
    expect(res.body.timestamp).toBeDefined();
  });
});
