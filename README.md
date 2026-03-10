# @hasna/mementos

Universal memory system for AI agents. SQLite-backed with CLI, MCP server, and library API.

Agents can save, recall, search, and share memories across sessions. Memories are scoped (global, shared, private), categorized, importance-ranked, and automatically injected into agent context.

## Installation

```bash
bun add -g @hasna/mementos
```

## Quick Start

```bash
# Save a memory
mementos save "preferred-language" "TypeScript" --scope global --importance 8

# Recall it
mementos recall "preferred-language"

# Search across all memories
mementos search "typescript"

# List memories with filters
mementos list --scope global --importance-min 5

# Get stats
mementos stats
```

## Memory Scopes

| Scope | Visibility | Use Case |
|-------|-----------|----------|
| `global` | All agents, all projects | Org-wide preferences, facts |
| `shared` | All agents in a project | Project conventions, decisions |
| `private` | Single agent only | Agent-specific context, history |

## Memory Categories

| Category | Description |
|----------|------------|
| `preference` | Settings, choices, style preferences |
| `fact` | Verified truths, known information |
| `knowledge` | Learned patterns, insights, techniques |
| `history` | Session context, conversation summaries |

## CLI Reference

### Global Options

```
--project <path>   Project context
--json             Output as JSON
--agent <name>     Agent identifier
--session <id>     Session context
```

### Commands

```bash
mementos save <key> <value>     # Save a memory
  -s, --scope <scope>           # global|shared|private (default: private)
  -c, --category <cat>          # preference|fact|knowledge|history
  --importance <1-10>           # Importance score (default: 5)
  --tags <t1,t2>                # Comma-separated tags
  --summary <text>              # Brief summary
  --ttl <ms>                    # Time-to-live in milliseconds
  --source <src>                # user|agent|system|auto|imported

mementos recall <key>           # Get memory by key
mementos list                   # List memories (with filters)
mementos update <id>            # Update memory fields
mementos forget <key|id>        # Delete a memory
mementos search <query>         # Full-text search
mementos stats                  # Memory statistics
mementos export                 # Export as JSON
mementos import <file>          # Import from JSON
mementos clean                  # Remove expired + enforce quotas
mementos inject                 # Output injection context
mementos init <name>            # Register agent
mementos agents                 # List agents
mementos projects               # Manage projects
mementos bulk <action> <ids>    # Batch operations
```

## MCP Server

### Setup for Claude Code

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "mementos": {
      "command": "mementos-mcp",
      "args": []
    }
  }
}
```

### Setup for Codex

Add to `.codex/mcp.json`:

```json
{
  "mcpServers": {
    "mementos": {
      "command": "mementos-mcp"
    }
  }
}
```

### Available Tools (19)

**Memory:** `memory_save`, `memory_recall`, `memory_list`, `memory_update`, `memory_forget`, `memory_search`, `memory_stats`, `memory_export`, `memory_import`, `memory_inject`

**Agents:** `register_agent`, `list_agents`, `get_agent`

**Projects:** `register_project`, `list_projects`

**Bulk:** `bulk_forget`, `bulk_update`

**Utility:** `clean_expired`, `memory_context`

### Resources

- `mementos://memories` — All active memories
- `mementos://agents` — Registered agents
- `mementos://projects` — Registered projects

## Library API

```typescript
import {
  createMemory,
  getMemoryByKey,
  listMemories,
  searchMemories,
  MemoryInjector,
} from "@hasna/mementos";

// Save a memory
const memory = createMemory({
  key: "db-convention",
  value: "Always use snake_case for column names",
  scope: "shared",
  category: "preference",
  importance: 8,
  tags: ["database", "conventions"],
});

// Recall
const recalled = getMemoryByKey("db-convention", "shared");

// Search
const results = searchMemories("database");

// List with filters
const memories = listMemories({
  scope: "global",
  category: "fact",
  min_importance: 5,
  limit: 20,
});

// Inject into agent context
const injector = new MemoryInjector();
const context = injector.getInjectionContext({
  agent_id: "my-agent",
  project_id: "my-project",
  max_tokens: 500,
});
```

## REST API

Start the server:

```bash
mementos-serve --port 19428
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memories` | List memories |
| POST | `/api/memories` | Create memory |
| GET | `/api/memories/:id` | Get memory |
| PATCH | `/api/memories/:id` | Update memory |
| DELETE | `/api/memories/:id` | Delete memory |
| POST | `/api/memories/search` | Search |
| GET | `/api/memories/stats` | Statistics |
| POST | `/api/memories/export` | Export |
| POST | `/api/memories/import` | Import |
| POST | `/api/memories/clean` | Cleanup |
| GET/POST | `/api/agents` | Agents |
| GET/POST | `/api/projects` | Projects |
| GET | `/api/inject` | Injection context |

## Configuration

Config file: `~/.mementos/config.json`

```json
{
  "default_scope": "private",
  "default_category": "knowledge",
  "default_importance": 5,
  "max_entries": 1000,
  "max_entries_per_scope": {
    "global": 500,
    "shared": 300,
    "private": 200
  },
  "injection": {
    "max_tokens": 500,
    "min_importance": 5,
    "categories": ["preference", "fact"],
    "refresh_interval": 5
  },
  "sync_agents": ["claude", "codex", "gemini"],
  "auto_cleanup": {
    "enabled": true,
    "expired_check_interval": 3600
  }
}
```

### Environment Variables

| Variable | Description |
|----------|------------|
| `MEMENTOS_DB_PATH` | Override database path |
| `MEMENTOS_DB_SCOPE` | Set to `project` for project-level DB |
| `MEMENTOS_DEFAULT_SCOPE` | Default memory scope |

## Database

SQLite with WAL mode. Path resolution:

1. `MEMENTOS_DB_PATH` environment variable
2. Nearest `.mementos/mementos.db` (walking up from cwd)
3. `~/.mementos/mementos.db` (global fallback)

## Architecture

```
src/
├── types/index.ts      # Type definitions, enums, errors
├── db/
│   ├── database.ts     # SQLite setup, migrations, utilities
│   ├── memories.ts     # Memory CRUD with optimistic locking
│   ├── agents.ts       # Agent registration (8-char UUIDs)
│   └── projects.ts     # Project registry
├── lib/
│   ├── config.ts       # Configuration loading
│   ├── search.ts       # Full-text search engine
│   ├── injector.ts     # Context injection system
│   ├── retention.ts    # Auto-cleanup & quota enforcement
│   └── sync.ts         # Multi-agent memory sync
├── cli/index.tsx       # CLI (Commander.js + chalk)
├── mcp/index.ts        # MCP server (19 tools, 3 resources)
├── server/index.ts     # REST API server
└── index.ts            # Library exports
```

## License

Apache-2.0
