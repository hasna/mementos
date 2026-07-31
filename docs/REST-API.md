# REST API reference

`mementos-serve` provides the HTTP API used by the TypeScript SDK and client
cloud mode. It can use local SQLite or, in server context only, PostgreSQL.

## Start the server

```bash
mementos-serve
mementos-serve --port 19428
```

`PORT` takes precedence over `--port`; the default is 19428. The host defaults
to `127.0.0.1` and can be changed with `MEMENTOS_HOST`. If the requested port is
busy, the server probes successive ports and prints the selected one.

The request body ceiling is 1 MiB. CORS defaults to
`http://localhost:19428`; set `MEMENTOS_CORS_ORIGIN` to the one allowed browser
origin. When `dashboard/dist` is present, non-API GET/HEAD requests serve the
dashboard with an SPA fallback.

## Prefixes and contract

`/v1` is canonical. Every registered `/v1/...` route is also served under the
legacy `/api/...` alias. The generated OpenAPI 3.1 document is available at:

```text
GET /openapi.json
GET /v1/openapi.json
GET /api/openapi.json
```

The document is built from the live route registry. The inline profile and SSE
routes are documented below but are not part of that registry-generated path
list.

## Authentication

Operational probes and the OpenAPI document are unauthenticated. All other
`/v1` and `/api` routes pass through one authentication gate.

Production/self-hosted mode uses a Foundation HMAC signing key. The first
configured value wins:

1. `API_KEY_SIGNING_SECRET`
2. `HASNA_MEMENTOS_API_SIGNING_KEY`
3. `HASNA_API_SIGNING_KEY`

Signed `hasna_mementos_...` tokens are checked statelessly, with database-backed
revocation when the cloud database is available. Clients send the token as a
bearer token and may also send `x-api-key`:

```bash
curl -H "Authorization: Bearer $MEMENTOS_API_KEY" \
  http://127.0.0.1:19428/v1/memories
```

When no signing secret exists, the server falls back to the static
`MEMENTOS_API_KEY`. That legacy mode requires the `Authorization: Bearer ...`
header. When neither signing nor static key is configured, API access is open;
this is suitable only for a trusted local listener.

## Operational endpoints

| Method and path | Behavior |
| --- | --- |
| `GET /health` | Liveness plus memory, agent, and project counts |
| `GET /ready` | Runs `SELECT 1` against the selected backing store; returns 503 when unavailable |
| `GET /version` | Package version and `local`/`cloud` mode |

The same probes also answer at `/v1/...` and `/api/...` without authentication.

## Memories

| Method | Canonical path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/memories` | List/filter memories |
| `POST` | `/v1/memories` | Create or upsert a memory |
| `GET` | `/v1/memories/{id}` | Get one memory |
| `PATCH` | `/v1/memories/{id}` | Update one memory; `version` may be omitted |
| `DELETE` | `/v1/memories/{id}` | Delete one memory |
| `GET` | `/v1/memories/{id}/versions` | Version history |
| `POST` | `/v1/memories/bulk-forget` | Delete a list of IDs |
| `POST` | `/v1/memories/bulk-update` | Update a list of IDs |
| `POST` | `/v1/memories/bulk-upsert` | Import/upsert multiple records with reference provisioning |
| `POST` | `/v1/memories/export` | Export a filtered set |
| `POST` | `/v1/memories/import` | Import records |
| `POST` | `/v1/memories/clean` | Delete expired memories |
| `POST` | `/v1/maintenance/cleanup` | Run configured expiry/quota/stale maintenance |
| `POST` | `/v1/memories/extract` | Convert a session summary into memories |
| `GET` | `/v1/memories/briefing` | New/updated/expired delta briefing |
| `GET` | `/v1/memories/audit` | Low-trust memory audit list |
| `GET` | `/v1/inject` | Prompt-ready memory injection |

List filters include scope, category, status, tags, project/agent/session,
namespace, minimum importance, pin state, temporal `as_of`, fields, limit, and
offset. The accepted enum values come from `src/types/index.ts`:

- scopes: `global`, `shared`, `private`, `working`;
- categories: `preference`, `fact`, `knowledge`, `history`, `procedural`,
  `resource`;
- sources: `user`, `agent`, `system`, `auto`, `imported`;
- statuses: `active`, `archived`, `expired`.

Create/upsert identity is the tuple of key, scope, agent, project, and session.
Updates use optimistic versions internally; if a REST update omits `version`,
the handler fetches the current version before applying the patch.

## Search and analytics

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/memories/search` | Full-text/fuzzy search |
| `POST` | `/v1/memories/search/semantic` | Embedding search |
| `POST` | `/v1/memories/search/hybrid` | Reciprocal-rank fusion search |
| `POST` | `/v1/memories/search/bm25` | BM25/FTS search |
| `POST` | `/v1/memories/recall/deep` | Multi-agent deep recall |
| `GET` | `/v1/memories/stats` | Aggregate active-memory statistics |
| `GET` | `/v1/memories/stale` | Stale-memory report |
| `GET` | `/v1/memories/history` | Recently accessed memories |
| `GET` | `/v1/memories/health` | Memory health summary |
| `GET` | `/v1/activity` | Daily creation activity, up to 365 days |
| `GET` | `/v1/report` | Rich activity/top-memory report |
| `GET` | `/v1/metrics` | Text metrics for monitoring |

Semantic features require embedding provider configuration and may degrade or
be unavailable when embeddings/pgvector are not present. Standard search
continues to use FTS/LIKE and fuzzy scoring.

## Agents, projects, and locks

```text
GET    /v1/agents
POST   /v1/agents
GET    /v1/agents/{id}
PATCH  /v1/agents/{id}
GET    /v1/agents/{id}/locks
DELETE /v1/agents/{id}/locks

GET  /v1/projects
POST /v1/projects
GET  /v1/projects/{id}
GET  /v1/projects/{id}/agents

POST   /v1/locks
GET    /v1/locks
DELETE /v1/locks/{id}
POST   /v1/locks/clean
```

Agent and project path parameters resolve IDs and supported names/paths in the
domain layer. Path parameters are URL-decoded before lookup.

## Knowledge graph

```text
GET    /v1/entities
POST   /v1/entities
POST   /v1/entities/merge
GET    /v1/entities/{id}
PATCH  /v1/entities/{id}
DELETE /v1/entities/{id}
GET    /v1/entities/{id}/memories
POST   /v1/entities/{id}/memories
DELETE /v1/entities/{entityId}/memories/{memoryId}
GET    /v1/entities/{id}/relations
GET    /v1/entities/{id}/related

POST   /v1/relations
GET    /v1/relations/{id}
DELETE /v1/relations/{id}

GET /v1/graph/path?from=...&to=...
GET /v1/graph/stats
GET /v1/graph/traverse/{entityId}
GET /v1/graph/{entityId}
```

## Tasks

```text
POST   /v1/tasks
GET    /v1/tasks
GET    /v1/tasks/stats
GET    /v1/tasks/{id}
PATCH  /v1/tasks/{id}
DELETE /v1/tasks/{id}
GET    /v1/tasks/{id}/comments
POST   /v1/tasks/{id}/comments
DELETE /v1/tasks/{id}/comments/{commentId}
```

Task statuses are `pending`, `in_progress`, `completed`, `failed`, and
`cancelled`; priorities are `critical`, `high`, `medium`, and `low`.

## Automation and system routes

```text
POST  /v1/auto-memory/process
GET   /v1/auto-memory/status
GET   /v1/auto-memory/config
PATCH /v1/auto-memory/config
POST  /v1/auto-memory/test

GET    /v1/hooks
GET    /v1/hooks/stats
GET    /v1/webhooks
POST   /v1/webhooks
GET    /v1/webhooks/{id}
PATCH  /v1/webhooks/{id}
DELETE /v1/webhooks/{id}

POST /v1/sessions/ingest
GET  /v1/sessions/jobs
GET  /v1/sessions/jobs/{id}
GET  /v1/sessions/queue/stats

POST /v1/synthesis/run
GET  /v1/synthesis/runs
GET  /v1/synthesis/status
POST /v1/synthesis/rollback/{run_id}
GET  /v1/profile/synthesize

POST /v1/consolidate
POST /v1/reflect
GET  /v1/chains/{sequence_group}

POST /v1/subscriptions
GET  /v1/subscriptions/notifications
DELETE /v1/subscriptions/{id}

POST /v1/tool-events
GET  /v1/tool-events
GET  /v1/tool-insights/{tool_name}
POST /v1/feedback
```

Two additional inline routes are available: `GET /v1/profile` reports the
active local profile and `GET /v1/memories/stream` emits server-sent memory
updates. Both pass through API authentication.

## TypeScript client

The main package client uses `/v1` by default and supports API keys:

```ts
import { MementosClient } from "@hasna/mementos/sdk";

const client = new MementosClient({
  baseUrl: "https://mementos.example.com",
  apiKey: process.env.MEMENTOS_API_KEY,
});

await client.saveMemory({
  key: "project-stack",
  value: "Bun + TypeScript",
  category: "fact",
  scope: "shared",
});
```

See [Library and SDK APIs](LIBRARY.md) for the bundled and standalone SDK
differences.
