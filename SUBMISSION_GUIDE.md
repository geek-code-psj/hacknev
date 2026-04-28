# NevUp Hackathon 2026 — Submission Guide

This repository contains implementations for **Track 1** (System of Record) and **Track 2** (System of AI Engine) of the NevUp Hackathon.

## Repository Structure

```
.
├── track1/               # Backend trade journal engine with behavioral analytics
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── package.json
│   ├── README.md
│   ├── DECISIONS.md
│   ├── nevup_openapi.yaml
│   ├── src/
│   │   ├── index.js        # Express server entry point
│   │   ├── db/             # PostgreSQL migrations and connection pool
│   │   ├── middleware/     # Auth, logging middleware
│   │   ├── queue/          # RabbitMQ broker and worker for async metrics
│   │   └── routes/         # API endpoints
│   ├── load-test/          # k6 load testing script
│   ├── tests/              # Jest unit tests
│   └── data/               # Seed data (CSV format)
│
├── track2/               # AI coaching engine with persistent memory
│   ├── docker-compose.yml
│   ├── Dockerfile
│   ├── package.json
│   ├── README.md
│   ├── DECISIONS.md
│   ├── nevup_openapi.yaml
│   ├── src/
│   │   ├── index.js        # Express server entry point
│   │   ├── memory/         # SQLite memory store
│   │   ├── coaching/       # Coaching generation logic
│   │   ├── profiler/       # Behavioral profiler
│   │   ├── middleware/     # Auth middleware
│   │   ├── routes/         # API endpoints
│   │   ├── eval/           # Evaluation harness
│   │   └── data/           # Seed data (JSON, CSV)
│
├── nevup_openapi.yaml    # Shared OpenAPI 3.0 specification
├── nevup_seed_dataset.csv  # 388 trades across 10 traders
└── nevup_seed_dataset.json # Same data in JSON format
```

## Quick Start: Running Both Tracks

### Prerequisites
- Docker and Docker Compose installed
- Ports 3000 (Track 1) and 3001 (Track 2) available

### Track 1 — System of Record

```bash
cd track1
docker compose up
```

**Services started:**
- PostgreSQL (port 5432, internal)
- RabbitMQ (port 15672, management UI)
- API Server (port 3000, http://localhost:3000)
- Worker (async metrics computation)

**Available immediately after startup:**
- `GET /health` — Returns service status
- All trade endpoints with JWT auth

**Seeded dataset:** 388 trades, 10 traders, 52 sessions automatically loaded

### Track 2 — System of AI Engine

```bash
cd track2
docker compose up
```

**Services started:**
- AI Engine (port 3001, http://localhost:3001)
- SQLite memory persistence (survives restarts)

**Available immediately:**
- `GET /health` — Returns service status
- Memory, coaching, and profiling endpoints with JWT auth

**Note:** Requires `ANTHROPIC_API_KEY` in `.env` for Claude coaching. Set to placeholder for testing.

## Authentication

All protected endpoints require JWT Bearer token:

```bash
Authorization: Bearer <token>
```

**Dev token for testing:**
```bash
# User: Alex Mercer (f412f236-4edc-47a2-8f54-8763a6ed2ce8)
# Valid for 24 hours
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmNDEyZjIzNi00ZWRjLTQ3YTItOGY1NC04NzYzYTZlZDJjZTgiLCJpYXQiOjE3MzYxNTYwMDAsImV4cCI6MTczNjI0MjQwMCwicm9sZSI6InRyYWRlciIsIm5hbWUiOiJBbGV4IE1lcmNlciJ9.tN0VQPRM2e2e5kPQW0sT0aBqC0qJ8dLxRPRQ9jKqM1E
```

## Submission Requirements Checklist

### Track 1 ✓
- ✓ Live deployment ready (docker compose up)
- ✓ Public GitHub repository
- ✓ OpenAPI 3.0 specification
- ✓ Load test script (k6) included
- ✓ DECISIONS.md with architectural rationale
- ✓ docker-compose.yml with single-command startup
- ✓ DB migrations in repo
- ✓ Seed data loads automatically
- ✓ No ORM (raw pg queries)
- ✓ Multi-tenant auth (JWT row-level checks)
- ✓ Async pipeline (RabbitMQ)
- ✓ Five behavioral metrics computed

### Track 2 ✓
- ✓ Live deployment ready (docker compose up)
- ✓ Public GitHub repository
- ✓ OpenAPI 3.0 specification
- ✓ DECISIONS.md with architectural rationale
- ✓ docker-compose.yml
- ✓ SQLite memory persistence
- ✓ Deterministic profiling (rule-based)
- ✓ Anti-hallucination audit endpoint
- ✓ JWT authentication
- ✓ Evaluation harness included

## Key Design Decisions

### Track 1
1. **PostgreSQL** for ACID compliance and JSON support
2. **RabbitMQ** for async behavioral metrics computation
3. **Atomic idempotency** on POST /trades using INSERT ... ON CONFLICT
4. **Precomputed metrics** tables updated by worker
5. **Connection pooling** at 10 max connections
6. **Numeric strings** for decimal precision on crypto trades
7. **Row-level tenancy** enforced on every endpoint

See [track1/DECISIONS.md](track1/DECISIONS.md) for full architectural rationale.

### Track 2
1. **SQLite** for persistence without infrastructure dependencies
2. **Claude Sonnet 4-6** for behavioral reasoning
3. **Deterministic profiling** (rule-based, no LLM call)
4. **Anti-hallucination** architecture with audit endpoint
5. **Session buffers** with userId for tenancy
6. **Timeout + fallback** (2.5s timeout, deterministic response on failure)

See [track2/DECISIONS.md](track2/DECISIONS.md) for full architectural rationale.

## Testing

### Track 1

**Unit tests:**
```bash
cd track1
docker compose run api npm test
```

**Load test (k6):**
```bash
cd track1
k6 run load-test/k6_load.js --out json=results.json
# HTML dashboard: k6 run load-test/k6_load.js --out web-dashboard
```

### Track 2

**Eval harness (reproducible pathology detection):**
```bash
cd track2
docker compose run ai-engine node src/eval/run_eval.js
```

## API Specifications

Both tracks expose OpenAPI 3.0 specs:
- `track1/nevup_openapi.yaml` — Trade journal API
- `track2/nevup_openapi.yaml` — AI coaching API
- `nevup_openapi.yaml` — Shared/mock server spec (Prism)

## Environment Variables

### Track 1
```env
NODE_ENV=production
PORT=3000
DB_HOST=postgres
DB_PORT=5432
DB_NAME=nevup
DB_USER=nevup
DB_PASSWORD=nevup_secret
RABBITMQ_URL=amqp://nevup:nevup_secret@rabbitmq:5672
JWT_SECRET=97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02
```

### Track 2
```env
NODE_ENV=production
PORT=3001
SQLITE_PATH=/data/memory.db
JWT_SECRET=97791d4db2aa5f689c3cc39356ce35762f0a73aa70923039d8ef72a2840a1b02
ANTHROPIC_API_KEY=<your_api_key>  # For Claude coaching
```

## Performance Targets

### Track 1
- **Throughput:** 200 concurrent trade-close events/sec for 60s
- **Write latency (p95):** ≤ 150ms
- **Read latency (p95):** ≤ 200ms for behavioral metrics queries
- **Error rate:** < 1%

### Track 2
- **Coaching response:** < 3s (p99)
- **Anti-hallucination audit:** < 500ms
- **Memory queries:** < 100ms

## Troubleshooting

### Docker daemon not responding
```bash
# Restart Docker Desktop
# On Windows, use: "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```

### Port already in use
```bash
# Track 1 uses 3000, 5432 (PostgreSQL), 15672 (RabbitMQ)
# Track 2 uses 3001
# Check and free ports as needed
```

### Database connection errors
```bash
# Wait 10-15 seconds for PostgreSQL to initialize
# Check logs: docker compose logs postgres
```

### Missing seed data
```bash
# Seed runs automatically on startup
# If not loaded, manually run: docker compose run api node src/db/seed.js
```

## Deployment Notes

Both services are containerized and ready for deployment to any Docker-compatible platform (Heroku, Railway, AWS ECS, etc.). Ensure:
- Environment variables are set via platform secrets manager
- PostgreSQL and RabbitMQ are provisioned externally (or use containers)
- Volumes are persistent for Track 2 SQLite data

## Contact & Attribution

- **Hackathon:** NevUp Hackathon 2026
- **Implementation Date:** April 2026
- **OpenAPI Spec:** Provided by hackathon organizers
- **Seed Data:** 388 trades, 10 traders (seeded dataset)

---

**Ready for review.** Both tracks are fully functional, tested, and production-ready.
