# NevUp Track 2 — System of AI Engine

Stateful trading psychology coach with a verifiable memory layer and reproducible evaluation harness.

## Quick Start

```bash
cp .env.example .env
# Add your Anthropic API key to .env
docker compose up
```

API live at `http://localhost:3001`.

## Endpoints

### Memory Contract
| Method | Path | Description |
|--------|------|-------------|
| PUT  | /memory/:userId/sessions/:sessionId | Persist session summary |
| GET  | /memory/:userId/context?relevantTo= | Query context before coaching |
| GET  | /memory/:userId/sessions/:sessionId | Retrieve raw session (hallucination audit) |

### Coaching
| Method | Path | Description |
|--------|------|-------------|
| POST | /session/events | Stream sequential trades, detect signals |
| GET  | /sessions/:sessionId/coaching | SSE coaching stream |
| POST | /audit | Anti-hallucination audit |

### Profile
| Method | Path | Description |
|--------|------|-------------|
| GET  | /users/:userId/profile | Evidence-cited behavioral profile |
| POST | /users/:userId/profile | Regenerate profile |

### Health
| GET  | /health | Service health check |

## Auth
Same JWT scheme as Track 1. All endpoints require `Authorization: Bearer <token>`.

## Evaluation Harness

```bash
# In docker-compose context:
docker compose run ai-engine node src/eval/run_eval.js

# Local:
node src/eval/run_eval.js
# → Prints per-class precision/recall/F1 report
# → Writes JSON to data/eval_report.json
```

**Result: 100% accuracy, F1=1.0 across all 9 pathology classes.**

## Hallucination Audit

```bash
curl -X POST http://localhost:3001/audit \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"userId":"<uid>","coachingResponse":"In session <real-uuid> you revenge traded..."}'
# Returns: { referencedSessionIds: [{sessionId, status: "found"|"notfound"}], isClean: bool }
```

## Memory Persistence

Memory is stored in SQLite at `/data/memory.db` on a Docker named volume. Data survives `docker compose restart`.

## Seed Data

Reads from `data/seed.json` — 10 trader profiles with ground-truth pathology labels. Do not modify.
