/**
 * k6 Load Test — NevUp Track 1
 * Target: 200 concurrent trade-close events/sec for 60s, p95 write latency <= 150ms
 *
 * Run: k6 run load-test/k6_load.js --out json=results.json
 * HTML report: k6 run load-test/k6_load.js --out web-dashboard
 * Or with custom token: k6 run load-test/k6_load.js --env TEST_TOKEN=your_token
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Pre-minted valid token for Alex Mercer (f412f236-4edc-47a2-8f54-8763a6ed2ce8)
// Generated with HS256 and secret 97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02
// Valid for 24 hours from issuance
const TOKEN = __ENV.TEST_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmNDEyZjIzNi00ZWRjLTQ3YTItOGY1NC04NzYzYTZlZDJjZTgiLCJpYXQiOjE3MzYxNTYwMDAsImV4cCI6MTczNjI0MjQwMCwicm9sZSI6InRyYWRlciIsIm5hbWUiOiJBbGV4IE1lcmNlciJ9.tN0VQPRM2e2e5kPQW0sT0aBqC0qJ8dLxRPRQ9jKqM1E';
const TEST_USER = __ENV.TEST_USER || 'f412f236-4edc-47a2-8f54-8763a6ed2ce8';

export const options = {
  scenarios: {
    trade_writes: {
      executor: 'constant-arrival-rate',
      rate: 200,          // 200 iterations/sec
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 250,
      maxVUs: 500,
    },
  },
  thresholds: {
    'http_req_duration{name:post_trade}': ['p(95)<150'],  // p95 write latency
    'http_req_failed':                     ['rate<0.01'],  // <1% error rate
    'checks':                              ['rate>0.99'],
  },
};

const writeLatency = new Trend('write_latency_ms', true);
const errorRate    = new Rate('trade_errors');

export default function () {
  const tradeId   = uuidv4();
  const sessionId = uuidv4();
  const now       = new Date().toISOString();
  const exitAt    = new Date(Date.now() + 3600000).toISOString();

  const payload = JSON.stringify({
    tradeId,
    userId:         TEST_USER,
    sessionId,
    asset:          'AAPL',
    assetClass:     'equity',
    direction:      'long',
    entryPrice:     150.00,
    exitPrice:      155.00,
    quantity:       10,
    entryAt:        now,
    exitAt,
    status:         'closed',
    outcome:        'win',
    pnl:            50.00,
    planAdherence:  4,
    emotionalState: 'calm',
    entryRationale: 'k6 load test trade',
  });

  const res = http.post(`${BASE_URL}/trades`, payload, {
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    tags: { name: 'post_trade' },
  });

  writeLatency.add(res.timings.duration);
  errorRate.add(res.status >= 400 && res.status !== 409);

  const ok = check(res, {
    'status is 200':              r => r.status === 200,
    'has tradeId in body':        r => {
      try { return JSON.parse(r.body).tradeId === tradeId; } catch { return false; }
    },
  });

  if (!ok) {
    console.error(`FAIL ${res.status}: ${res.body.slice(0, 200)}`);
  }
}
