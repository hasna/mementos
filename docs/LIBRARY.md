# Library and SDK APIs

This repository ships three related TypeScript surfaces:

| Import/package | Runtime style | Intended use |
| --- | --- | --- |
| `@hasna/mementos` | Synchronous Bun domain/database API | Embedded local or server-side use |
| `@hasna/mementos/sdk` | Zero-dependency async fetch client bundled with the main package | Authenticated `/v1` REST clients |
| `@hasna/mementos-sdk` | Separately versioned zero-dependency fetch client in `sdk/` | Legacy/standalone `/api` clients |

Do not confuse the subpath export with the separate package. Their method sets,
environment handling, and authentication support differ.

## Direct library: `@hasna/mementos`

The main export is built from `src/index.ts` and requires Bun because local
storage uses `bun:sqlite`.

```ts
import {
  createMemory,
  getMemoryByKey,
  listMemories,
  searchMemories,
  closeDatabase,
} from "@hasna/mementos";

const saved = createMemory({
  key: "project-stack",
  value: "Bun + TypeScript + SQLite",
  category: "fact",
  scope: "shared",
  importance: 8,
});

const recalled = getMemoryByKey(saved.key, "shared");
const results = searchMemories("TypeScript", { scope: "shared" });
closeDatabase();
```

### Export groups

- Types and errors: memories, filters, agents, projects, entities, relations,
  tasks, sync inputs, optimistic-version and not-found errors.
- Database lifecycle: `getDatabase`, `closeDatabase`, `resetDatabase`,
  `getDbPath`, ID resolution, UUID/time helpers.
- Memory CRUD/history: create/get/list/update/delete, bulk delete, touch,
  expiry cleanup, version history, recall counts.
- Agents, projects, machines, focus, resource locks, and memory write locks.
- Search and prompt injection (`searchMemories`, `MemoryInjector`).
- Retention, legacy agent sync, and compatibility storage sync.
- Knowledge graph entities, relations, entity-memory links, paths, and graph
  queries.
- Auto-memory providers, deduplication, consolidation, reflection, and training
  data gathering.
- Tasks, comments, and the task-runner registration API.
- Secret redaction and project-panel contract formatting.

The complete export list is the named export block in `src/index.ts`. Functions
which accept an optional database adapter/path can be isolated with an explicit
SQLite store. In client API mode, code paths without an HTTP implementation fail
closed instead of opening a split-brain local database. Use the fetch client for
a general remote application.

### Storage subpath

`@hasna/mementos/storage` exposes adapters and storage diagnostics, including
`SqliteAdapter`, `PgAdapter`, `PgAdapterAsync`, status/config resolution, and
legacy incremental sync helpers.

Direct PostgreSQL runtime access is server-only. `getStorageConnectionString()`
throws outside a `mementos-serve` server context; ordinary remote consumers use
the REST SDK.

## Bundled REST client: `@hasna/mementos/sdk`

```ts
import { MementosClient, MementosError } from "@hasna/mementos/sdk";

const client = new MementosClient({
  baseUrl: "https://mementos.example.com",
  apiKey: process.env.MEMENTOS_API_KEY,
  // prefix defaults to "/v1"; use "/api" only for a legacy deployment
});

try {
  await client.saveMemory({
    key: "release-process",
    value: "Run typecheck, tests, then build",
    category: "procedural",
    scope: "shared",
  });
} catch (error) {
  if (error instanceof MementosError) {
    console.error(error.status, error.message, error.details);
  }
}
```

Constructor options are `baseUrl`, a custom `fetch`, `apiKey`, and `prefix`.
When an API key is supplied it is sent as both `Authorization: Bearer` and
`x-api-key`.

`MementosClient.fromEnv()` reads `MEMENTOS_API_URL`, then `MEMENTOS_URL`, with
`http://localhost:19428` as the URL fallback. It reads `MEMENTOS_API_KEY` for
authentication. Unlike the CLI transport resolver, this helper does not read
the `HASNA_MEMENTOS_API_*` names; pass them explicitly if those are the only
variables in the process.

### Bundled client methods

| Area | Methods |
| --- | --- |
| Memories and service | `listMemories`, `getStats`, `getHealth`, `getReady`, `getVersion`, `getReport`, `getStaleMemories`, `getActivity`, `searchMemories`, `exportMemories`, `importMemories`, `cleanExpired`, `extractFromSession`, `saveMemory`, `getMemory`, `getMemoryVersions`, `updateMemory`, `deleteMemory` |
| Agents and projects | `listAgents`, `registerAgent`, `getAgent`, `updateAgent`, `listAgentsByProject`, `listProjects`, `registerProject`, `getProject`, `getProjectAgents` |
| Knowledge graph | `listEntities`, `createEntity`, `mergeEntities`, `getEntity`, `updateEntity`, `deleteEntity`, `getEntityMemories`, `linkEntityMemory`, `unlinkEntityMemory`, `getEntityRelations`, `createRelation`, `getRelation`, `deleteRelation`, `getGraph`, `findPath`, `getGraphStats` |
| Locks | `acquireLock`, `checkLock`, `releaseLock`, `listAgentLocks`, `releaseAllAgentLocks`, `cleanExpiredLocks` |
| Tasks | `createTask`, `listTasks`, `getTaskStats`, `getTask`, `updateTask`, `deleteTask`, `listTaskComments`, `addTaskComment`, `deleteTaskComment` |
| Context and extraction | `getContext`, `processConversationTurn`, `getAutoMemoryStatus`, `configureAutoMemory`, `testExtraction` |
| Hooks | `listHooks`, `getHookStats`, `listWebhooks`, `createWebhook`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `enableWebhook`, `disableWebhook` |
| Synthesis | `runSynthesis`, `listSynthesisRuns`, `getSynthesisStatus`, `rollbackSynthesis` |
| Session jobs | `ingestSession`, `getSessionJob`, `listSessionJobs`, `getSessionQueueStats` |

The bundled client currently does not expose `consolidateMemories` or `reflect`
convenience methods even though those REST endpoints exist. Call the endpoints
directly or use the standalone client if its other tradeoffs fit.

## Standalone client: `@hasna/mementos-sdk`

The package in `sdk/` is versioned independently and works in Node.js, Bun,
Deno, and browsers. Its current constructor accepts only `baseUrl` and a custom
`fetch`; it does not add an API key or versioned-prefix routing. It calls legacy
`/api` paths directly. `fromEnv()` reads only `MEMENTOS_URL`.

It includes `consolidateMemories` and `reflect`, but it does not include the
bundled client's readiness/version probes, task methods, namespace fields, or
expanded procedural/resource category types. Use it against a local/open server
or supply an authenticated custom `fetch` wrapper when the deployment requires
headers.

See [the standalone SDK README](../sdk/README.md) for its exact method table and
examples.
