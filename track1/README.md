# NevUp Track 1 — System of Record

Trade journal engine with behavioral analytics.

## Quick Start

```bash
docker compose up
```

The API is live at `http://localhost:3000` once all three services are healthy.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /trades | Create/idempotent trade write |
| GET  | /trades/:tradeId | Fetch a single trade |
| PATCH | /trades/:tradeId | Update a trade (e.g., close it) |
| GET  | /sessions/:sessionId | Session summary + trades |
| POST | /sessions/:sessionId/debrief | Submit debrief |
| GET  | /users/:userId/metrics | Behavioral metrics (timeseries) |
| GET  | /users/:userId/profile | Behavioral profile |
| GET  | /health | DB + queue health |

## Auth

All endpoints (except `/health`) require a Bearer JWT. Generate a dev token:

```bash
node -e "
const crypto = require('crypto');
const S = '97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02';
const b = s => Buffer.from(s).toString('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const h = b(JSON.stringify({alg:'HS256',typ:'JWT'}));
const now = Math.floor(Date.now()/1000);
const p = b(JSON.stringify({sub:'f412f236-4edc-47a2-8f54-8763a6ed2ce8',iat:now,exp:now+86400,role:'trader',name:'Alex Mercer'}));
const sig = crypto.createHmac('sha256',S).update(h+'.'+p).digest('base64').replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
console.log(h+'.'+p+'.'+sig);
"
```

## Tests

```bash
# In docker-compose context
docker compose run api npm test
```

## Load Test

```bash
# Install k6: https://k6.io/docs/get-started/installation/
export TEST_TOKEN="<your-minted-token>"
export TEST_USER="f412f236-4edc-47a2-8f54-8763a6ed2ce8"
k6 run load-test/k6_load.js
```

## Seed Data

388 trades across 10 traders are seeded automatically on `docker compose up`. No manual steps.
