# @hasna/mementos-sdk

Zero-dependency TypeScript client for [@hasna/mementos](https://github.com/hasna/mementos) REST API.

Works in Node.js, Bun, Deno, and browsers. No external dependencies beyond `fetch`.

## Install

```bash
bun add @hasna/mementos-sdk
# or
npm install @hasna/mementos-sdk
```

## Quick Start

```ts
import { MementosClient } from "@hasna/mementos-sdk";

const client = new MementosClient({ baseUrl: "http://localhost:19428" });

// Save a memory
await client.saveMemory({
  key: "project-stack",
  value: "Bun + TypeScript + SQLite",
  category: "fact",
  scope: "shared",
  importance: 8,
});

// Search memories
const { results } = await client.searchMemories("project stack");

// List with filters
const { memories } = await client.listMemories({
  scope: "shared",
  min_importance: 7,
  project_id: "my-project-id",
});
```

## API

### Constructor

```ts
new MementosClient({ baseUrl?: string, fetch?: typeof globalThis.fetch })
```

- `baseUrl` — URL of `mementos-serve`. Default: `http://localhost:19428`
- `fetch` — optional fetch override (useful for testing)

### Memories

| Method | Description |
|--------|-------------|
| `listMemories(filter?)` | List memories with optional filters |
| `saveMemory(input)` | Create a memory |
| `getMemory(id)` | Get memory by ID |
| `updateMemory(id, input)` | Update memory (`version` optional; server auto-fetches current version if omitted) |
| `deleteMemory(id)` | Delete a memory |
| `searchMemories(query)` | Full-text + fuzzy search |
| `getStats()` | Memory statistics |
| `exportMemories(filter?)` | Export memories |
| `importMemories(input)` | Import memories |
| `cleanExpired()` | Remove expired memories |

### Agents & Projects

| Method | Description |
|--------|-------------|
| `listAgents()` | List all registered agents |
| `registerAgent(input)` | Register an agent (idempotent by name) |
| `getAgent(idOrName)` | Get agent by ID or name |
| `listProjects()` | List all registered projects |
| `registerProject(input)` | Register a project (idempotent by name) |

### Knowledge Graph

| Method | Description |
|--------|-------------|
| `listEntities(filter?)` | List entities |
| `createEntity(input)` | Create entity |
| `getEntity(id)` | Get entity |
| `updateEntity(id, input)` | Update entity |
| `deleteEntity(id)` | Delete entity |
| `mergeEntities(input)` | Merge two entities |
| `getEntityMemories(entityId)` | Get memories linked to entity |
| `linkEntityMemory(entityId, input)` | Link memory to entity |
| `unlinkEntityMemory(entityId, memoryId)` | Unlink memory from entity |
| `getEntityRelations(entityId, filter?)` | Get entity relations |
| `createRelation(input)` | Create entity relation |
| `getRelation(id)` | Get relation |
| `deleteRelation(id)` | Delete relation |
| `getGraph(entityId, options?)` | Get knowledge graph for entity |
| `findPath(fromId, toId)` | Find shortest path between entities |
| `getGraphStats()` | Graph-wide statistics |

### Context Injection

| Method | Description |
|--------|-------------|
| `getContext(options?)` | Get formatted memory context for agent prompts |

## Error Handling

```ts
import { MementosClient, MementosError } from "@hasna/mementos-sdk";

try {
  await client.getMemory("missing-id");
} catch (e) {
  if (e instanceof MementosError) {
    console.log(e.status);  // 404
    console.log(e.message); // "Memory not found"
  }
}
```

## License

Apache-2.0
