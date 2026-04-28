'use strict';
const request = require('supertest');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');

const SECRET = '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';

function b64url(s) {
  return Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

function mintToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + 86400, role: 'trader' }));
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64')
    .replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  return `${h}.${p}.${sig}`;
}

let app;

beforeAll(async () => {
  process.env.DB_HOST = process.env.DB_HOST || 'localhost';
  process.env.SQLITE_PATH = '/tmp/nevup_test_memory.db';
  app = require('../src/index');
  await new Promise(r => setTimeout(r, 500));
}, 10000);

afterAll(() => {
  const fs   = require('fs');
  try { fs.unlinkSync('/tmp/nevup_test_memory.db'); } catch {}
});

const ALEX = 'f412f236-4edc-47a2-8f54-8763a6ed2ce8';
const USER_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

describe('Memory Contract', () => {
  const sessionId = uuidv4();

  test('PUT /memory/:userId/sessions/:sessionId stores session', async () => {
    const res = await request(app)
      .put(`/memory/${ALEX}/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`)
      .send({
        summary: 'Solid session with some revenge trades early on',
        metrics: { planAdherenceScore: 3.2, sessionTiltIndex: 0.2 },
        tags:   ['revenge_trading', 'pattern:tilt'],
      });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
  });

  test('GET /memory/:userId/sessions/:sessionId returns exact stored record', async () => {
    const res = await request(app)
      .get(`/memory/${ALEX}/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`);
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(sessionId);
    expect(res.body.summary).toBe('Solid session with some revenge trades early on');
    expect(res.body.metrics.planAdherenceScore).toBe(3.2);
  });

  test('GET /memory/:userId/context returns relevant sessions', async () => {
    const res = await request(app)
      .get(`/memory/${ALEX}/context?relevantTo=revenge_trading`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(Array.isArray(res.body.patternIds)).toBe(true);
  });

  test('cross-tenant: User B cannot read User A memory → 403', async () => {
    const res = await request(app)
      .get(`/memory/${ALEX}/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${mintToken(USER_B)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  test('missing session returns 404', async () => {
    const res = await request(app)
      .get(`/memory/${ALEX}/sessions/${uuidv4()}`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`);
    expect(res.status).toBe(404);
  });
});

describe('Behavioral Profile', () => {
  test('GET /users/:userId/profile returns evidence-cited profile', async () => {
    const res = await request(app)
      .get(`/users/${ALEX}/profile`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(ALEX);
    expect(Array.isArray(res.body.dominantPathologies)).toBe(true);
    // Every pathology must have evidenceSessions
    for (const p of res.body.dominantPathologies) {
      expect(Array.isArray(p.evidenceSessions)).toBe(true);
      expect(p.evidenceSessions.length).toBeGreaterThan(0);
    }
  });
});

describe('Anti-Hallucination Audit', () => {
  test('POST /audit flags invented sessionIds as notfound', async () => {
    const fakeSession = uuidv4();
    const res = await request(app)
      .post('/audit')
      .set('Authorization', `Bearer ${mintToken(ALEX)}`)
      .send({
        userId: ALEX,
        coachingResponse: `Based on your session ${fakeSession}, I noticed revenge trading patterns.`,
      });
    expect(res.status).toBe(200);
    expect(res.body.hallucinationCount).toBeGreaterThan(0);
    expect(res.body.referencedSessionIds[0].status).toBe('notfound');
    expect(res.body.isClean).toBe(false);
  });

  test('POST /audit marks real stored sessions as found', async () => {
    const sessionId = uuidv4();
    // Store it first
    await request(app)
      .put(`/memory/${ALEX}/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${mintToken(ALEX)}`)
      .send({
        summary: 'Test session for audit',
        metrics: { planAdherenceScore: 4 },
        tags: [],
      });

    const res = await request(app)
      .post('/audit')
      .set('Authorization', `Bearer ${mintToken(ALEX)}`)
      .send({
        userId: ALEX,
        coachingResponse: `In session ${sessionId}, you traded well.`,
      });
    expect(res.status).toBe(200);
    const found = res.body.referencedSessionIds.find(r => r.sessionId === sessionId);
    expect(found?.status).toBe('found');
  });
});

describe('Session Events', () => {
  test('POST /session/events detects signals from trade stream', async () => {
    const now     = Date.now();
    const session = uuidv4();
    const trades  = [
      { tradeId: uuidv4(), userId: ALEX, sessionId: session, status: 'closed', outcome: 'loss',
        entryAt: new Date(now).toISOString(), exitAt: new Date(now + 300000).toISOString(),
        emotionalState: 'calm', planAdherence: 4 },
      { tradeId: uuidv4(), userId: ALEX, sessionId: session, status: 'open',
        entryAt: new Date(now + 310000).toISOString(), exitAt: null,
        emotionalState: 'anxious', planAdherence: null },
    ];

    const res = await request(app)
      .post('/session/events')
      .set('Authorization', `Bearer ${mintToken(ALEX)}`)
      .send({ sessionId: session, userId: ALEX, trades });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.signals)).toBe(true);
    // The second trade opens within 90s of a loss while anxious → revenge trading
    const rt = res.body.signals.find(s => s.type === 'revenge_trading');
    expect(rt).toBeDefined();
  });
});

describe('Health', () => {
  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
