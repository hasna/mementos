# @hasna/mementos-sdk

Zero-dependency TypeScript client for the
[@hasna/mementos](https://github.com/hasna/mementos) REST API. It works in
Node.js, Bun, Deno, and browsers and requires only `fetch`.

This package is the separately versioned standalone client in `sdk/`. It is not
the same API as the `@hasna/mementos/sdk` subpath export; see
[the repository comparison](../docs/LIBRARY.md).

## Install

```bash
bun add @hasna/mementos-sdk
# or
npm install @hasna/mementos-sdk
```

## Quick start

```ts
import { MementosClient } from "@hasna/mementos-sdk";

const client = new MementosClient({ baseUrl: "http://localhost:19428" });

await client.saveMemory({
  key: "project-stack",
  value: "Bun + TypeScript + SQLite",
  category: "fact",
  scope: "shared",
  importance: 8,
});

const { results } = await client.searchMemories("project stack");

const { memories } = await client.listMemories({
  scope: "shared",
  min_importance: 7,
  project_id: "my-project-id",
});
```

## Configuration

```ts
new MementosClient({
  baseUrl?: string,                 // default: http://localhost:19428
  fetch?: typeof globalThis.fetch,  // optional override
})
```

`MementosClient.fromEnv()` reads `MEMENTOS_URL` and otherwise uses the local
default. This standalone version calls `/api` routes and has no built-in API-key
option. For an authenticated deployment, supply a `fetch` wrapper which adds the
required header, or use the `@hasna/mementos/sdk` client, which supports
`apiKey` and canonical `/v1` routing.

## Methods

### Memories and analytics

| Method | Description |
| --- | --- |
| `listMemories(filter?)` | List memories with scope/category/tag/importance/pin/agent/project/session/status/paging/field filters |
| `saveMemory(input)` | Create or upsert a memory |
| `getMemory(id)` | Get memory by ID |
| `getMemoryVersions(id)` | Get stored versions and current version number |
| `updateMemory(id, input)` | Update a memory; `version` is optional because the server can fetch it |
| `deleteMemory(id)` | Delete a memory |
| `searchMemories(inputOrQuery)` | Full-text and fuzzy search |
| `getStats()` | Aggregate memory statistics |
| `getHealth()` | Server health and counts |
| `getReport(options?)` | Activity, breakdowns, and top memories |
| `getStaleMemories(options?)` | Find stale memories |
| `getActivity(options?)` | Daily creation activity |
| `exportMemories(filter?)` | Export memories |
| `importMemories(input)` | Import memories |
| `consolidateMemories(input?)` | Plan/apply deduplication, promotion, summaries, and decay cleanup |
| `reflect(input)` | Reflect on a session, task, or range and save lessons |
| `cleanExpired()` | Delete expired memories |
| `extractFromSession(input)` | Save summary/topic memories from session data |

### Agents and projects

| Method | Description |
| --- | --- |
| `listAgents()` | List registered agents |
| `registerAgent(input)` | Register an agent |
| `getAgent(idOrName)` | Resolve an agent |
| `updateAgent(idOrName, updates)` | Update metadata or active project |
| `listAgentsByProject(projectId)` | List agents focused on a project |
| `listProjects()` | List projects |
| `registerProject(input)` | Register a project |
| `getProject(idOrName)` | Resolve a project |
| `getProjectAgents(idOrName)` | List a project's agents |

### Knowledge graph

| Method | Description |
| --- | --- |
| `listEntities(filter?)` | List entities |
| `createEntity(input)` | Create an entity |
| `getEntity(id)` | Get an entity |
| `updateEntity(id, input)` | Update an entity |
| `deleteEntity(id)` | Delete an entity |
| `mergeEntities(input)` | Merge a source entity into a target |
| `getEntityMemories(entityId)` | Get linked memories |
| `linkEntityMemory(entityId, input)` | Link a memory |
| `unlinkEntityMemory(entityId, memoryId)` | Unlink a memory |
| `getEntityRelations(entityId, filter?)` | Get entity relations |
| `createRelation(input)` | Create a relation |
| `getRelation(id)` | Get a relation |
| `deleteRelation(id)` | Delete a relation |
| `getGraph(entityId, options?)` | Traverse the graph |
| `findPath(fromId, toId)` | Find a shortest path |
| `getGraphStats()` | Graph-wide counts |

### Locks

`acquireLock`, `checkLock`, `releaseLock`, `listAgentLocks`,
`releaseAllAgentLocks`, and `cleanExpiredLocks` expose resource-lock endpoints.

### Context, automation, and sessions

| Area | Methods |
| --- | --- |
| Context/auto-memory | `getContext`, `processConversationTurn`, `getAutoMemoryStatus`, `configureAutoMemory`, `testExtraction` |
| Hooks/webhooks | `listHooks`, `getHookStats`, `listWebhooks`, `createWebhook`, `getWebhook`, `updateWebhook`, `deleteWebhook`, `enableWebhook`, `disableWebhook` |
| Synthesis | `runSynthesis`, `listSynthesisRuns`, `getSynthesisStatus`, `rollbackSynthesis` |
| Session jobs | `ingestSession`, `getSessionJob`, `listSessionJobs`, `getSessionQueueStats` |

The standalone package's compile-time memory categories are `preference`,
`fact`, `knowledge`, and `history`; scopes are `global`, `shared`, `private`, and
`working`. The current server also supports `procedural` and `resource`, which
are typed in the main package's bundled SDK.

## Error handling

```ts
import { MementosClient, MementosError } from "@hasna/mementos-sdk";

const client = new MementosClient();

try {
  await client.getMemory("missing-id");
} catch (error) {
  if (error instanceof MementosError) {
    console.log(error.status);
    console.log(error.message);
    console.log(error.details);
  }
}
```

## Development

```bash
bun test
bun run typecheck
bun run build
```

## License

Apache-2.0
