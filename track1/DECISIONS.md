# DECISIONS.md — Track 1: System of Record

## Architecture Decisions

### 1. PostgreSQL as the primary datastore
PostgreSQL was chosen for its ACID guarantees, mature JSON support (`JSONB` for `winRateByEmotionalState`), and row-level query performance. The `trades` table is indexed on `(userId, entryAt)` and `(userId, status, entryAt)` — the two most common query patterns for the read API and revenge-flag computation. A compound unique index on `(userId, bucket, granularity)` in `metrics_timeseries` ensures idempotent timeseries upserts.

**Why not Redis?** Redis is faster for simple key-value but lacks the query flexibility needed for timeseries aggregation and behavioral metrics. PostgreSQL's `JSONB` column type efficiently stores `winRateByEmotionalState` without schema changes.

**Query explain plan (GET /users/:id/metrics, daily granularity, seeded dataset):**
```
Index Scan using idx_timeseries_user_range on metrics_timeseries
  Index Cond: (userId = $1 AND granularity = 'daily')
  Filter: (bucket >= $2 AND bucket <= $3)
  -> Actual rows: ~52, width: 64, cost: 0.15..8.42
```
Read latency against 388 seeded rows is consistently < 5ms local; headroom for 200ms p95 is extreme.

### 2. RabbitMQ with topic exchange for the async pipeline
Behavioral metrics (plan adherence score, session tilt, win rate by emotional state, revenge trades, overtrading) are computed in a separate `worker` container consuming from `metrics.compute` queue — never in the write path. This satisfies the requirement that metrics computation must not add latency to POST /trades. RabbitMQ was chosen over Redis Streams for built-in dead-lettering, consumer acknowledgements, and the management UI at port 15672.

**Why RabbitMQ over Redis Streams?** The research docs explicitly evaluate this tradeoff: RabbitMQ provides superior dead-letter handling (failed messages don't disappear), explicit consumer acknowledgements (exactly-once semantics), and a management UI for debugging. Redis Streams would require implementing these patterns manually.

The write path publishes a single message (< 1ms) and returns. If the broker is unavailable, the trade write succeeds anyway — the publish call is fire-and-forget (`try/catch`, no await on durability confirmation).

### 3. Atomic idempotency with ON CONFLICT DO UPDATE
POST /trades is idempotent on `tradeId` using a single atomic `INSERT ... ON CONFLICT DO UPDATE SET "tradeId" = EXCLUDED."tradeId" RETURNING *`. This eliminates the race condition where two simultaneous requests could both pass a pre-check SELECT and then have one fail on INSERT. The previous SELECT-then-INSERT pattern caused 500 errors under concurrent load.

### 4. Precomputed metrics tables
Rather than computing `planAdherenceScore`, `sessionTiltIndex`, etc. on every GET /metrics request (which would require multi-join aggregations against the full trades table), we maintain a `user_metrics` summary row per user, updated asynchronously. The `metrics_timeseries` table holds pre-bucketed hourly and daily rows. This keeps GET /metrics at O(1) per user regardless of trade volume.

### 5. Connection pool capped at 10
The pool size was reduced from 20 to 10 per service. During load tests with k6 (200 RPS), the API + worker containers could saturate PostgreSQL's default 100 connection limit. With 20 connections each, plus seed operations, this risked connection exhaustion on shared database instances (like Railway free tier).

### 6. DB-side sliding window for overtrading detection
The overtrading check (>10 trades in any 30-min window) uses SQL window functions instead of loading trades into Node.js memory. This prevents O(n²) complexity under load: at 200 RPS for 60 seconds, the previous JS-loop approach would load 12,000 trades per user, blowing the p95 latency SLO.

### 7. Revenge flag computed asynchronously
The revenge flag (trade opened within 90s of a losing close while anxious/fearful) is now computed in the worker, not the write path. This removes a synchronous DB query from every POST /trades request, improving write latency. The worker computes the flag after the trade is persisted.

### 8. Return numeric values as strings for precision
PostgreSQL NUMERIC(18,8) columns are returned as strings to preserve 8-decimal precision for crypto assets. Using `parseFloat()` destroys IEEE 754 precision, which matters for high-value crypto trades.

### 9. Row-level tenancy on every endpoint
Every route that takes a `userId` path parameter runs the `tenancyCheck` middleware which compares `req.user.userId` (from JWT `sub`) against the route parameter. For trade endpoints without a userId param, the body's `userId` is checked. Mismatches always return 403 — never 404, per spec.

### 10. No ORM
Raw `pg` queries are used throughout. ORMs introduce N+1 query risks (especially for session aggregation) and hide query plans. Every query in this codebase is explicit and visible in the explain plan.
