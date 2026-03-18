# @hasna/mementos

Universal memory system for AI agents. SQLite-backed with CLI, MCP server, REST API, and TypeScript library.

Agents save, recall, search, and share memories across sessions. Memories are scoped (global/shared/private), categorized, importance-ranked, and injected into agent context on demand.

## Install

```bash
bun add -g @hasna/mementos
mementos init
```

That's it. `init` registers the MCP with Claude Code, installs the session stop hook, and configures the server to start automatically on login.

## Quick Start

```bash
# Save a memory
mementos save "project-stack" "Bun + TypeScript + SQLite" --scope shared --importance 8

# Recall it
mementos recall "project-stack"

# Search
mementos search "typescript stack"

# Inject into agent context (compact = ~60% smaller)
mementos inject --format compact --project-id <id>

# Get stats
mementos stats

# Check everything is working
mementos doctor
```

## MCP Server

### Install into Claude Code (recommended)

```bash
# One-command setup (MCP + stop hook + auto-start):
mementos init

# Or just the MCP server:
mementos mcp --claude
# Or manually:
claude mcp add --transport stdio --scope user mementos -- mementos-mcp
```

### Install into Codex / Gemini

```bash
mementos mcp --codex
mementos mcp --gemini
mementos mcp --all        # all agents at once
```

### Available Tools (40+)

**Memory:** `memory_save`, `memory_recall`, `memory_get`, `memory_list`, `memory_update`, `memory_pin`, `memory_archive`, `memory_forget`, `memory_search`, `memory_stats`, `memory_export`, `memory_import`, `memory_inject`, `memory_context`, `session_extract`

**Bulk:** `bulk_forget`, `bulk_update`

**Agents:** `register_agent`, `list_agents`, `list_agents_by_project`, `get_agent`, `update_agent`

**Projects:** `register_project`, `list_projects`, `get_project`

**Knowledge Graph:** `entity_create`, `entity_get`, `entity_list`, `entity_delete`, `entity_merge`, `entity_link`, `relation_create`, `relation_delete`, `relation_list`, `graph_query`, `graph_path`, `graph_stats`

**Meta:** `search_tools`, `describe_tools` (lean stubs — full docs on demand)

**Utility:** `clean_expired`

## CLI Reference

```bash
mementos save <key> <value>        # Save/upsert a memory
mementos recall <key>              # Get memory by key
mementos list                      # List memories (with filters)
mementos update <id>               # Update memory fields
mementos pin <key|id>              # Pin a memory
mementos forget <key|id>           # Delete a memory
mementos search <query>            # Full-text + fuzzy search
mementos stats                     # Memory statistics
mementos export                    # Export as JSON
mementos import <file>             # Import from JSON
mementos clean                     # Remove expired + enforce quotas
mementos inject                    # Output injection context
mementos init <name>               # Register agent
mementos agents                    # List agents
mementos projects                  # Manage projects
mementos bulk forget <ids>         # Batch delete
mementos bulk update <ids>         # Batch update
mementos diff <id>                 # Show memory version history
mementos doctor                    # Diagnose DB health

# Profiles — isolated DBs per context
mementos profile set work          # Switch to work profile
mementos profile list              # List all profiles
mementos profile get               # Show active profile
mementos profile unset             # Back to default
```

## Profiles

```bash
# Each profile is an isolated DB: ~/.mementos/profiles/<name>.db
mementos profile set work
MEMENTOS_PROFILE=work mementos list   # per-command
```

## REST API

```bash
mementos-serve --port 19428
```

Default port: **19428**. Binds to `127.0.0.1` (localhost only). Override with `MEMENTOS_HOST=0.0.0.0`.

### Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/memories?fields=key,value` | List memories (?fields, ?scope, ?session_id, ?status) |
| POST | `/api/memories` | Create/upsert memory |
| PATCH | `/api/memories/:id` | Update (version optional — auto-fetched) |
| DELETE | `/api/memories/:id` | Delete |
| POST | `/api/memories/search` | Full-text search |
| POST | `/api/memories/extract` | Auto-extract memories from session summary |
| POST | `/api/memories/bulk-forget` | Delete multiple |
| POST | `/api/memories/bulk-update` | Update multiple |
| GET | `/api/memories/stats` | Statistics |
| POST | `/api/memories/export` | Export with filters |
| GET | `/api/inject?format=compact` | Context injection (compact/markdown/json/xml) |
| GET/POST | `/api/agents` | Agent registry |
| PATCH | `/api/agents/:id` | Update agent (including active_project_id) |
| GET/POST | `/api/projects` | Project registry |
| GET | `/api/projects/:id/agents` | Agents active on a project |
| GET | `/api/profile` | Active profile info |
| GET | `/api/health` | Health check (includes profile, hostname) |

## SDK

```bash
bun add @hasna/mementos-sdk
```

```typescript
import { MementosClient } from "@hasna/mementos-sdk";

// Auto-configure from MEMENTOS_URL env var
const client = MementosClient.fromEnv();

// Or explicit:
const client = new MementosClient({ baseUrl: "http://localhost:19428" });

// Save memory
await client.saveMemory({ key: "db-convention", value: "snake_case", scope: "shared" });

// Search
const { results } = await client.searchMemories("database conventions");

// Context injection (compact format — 60% smaller)
const { context } = await client.getContext({ project_id: "...", format: "compact" });

// Sessions → mementos integration
await client.extractFromSession({
  session_id: "abc123",
  title: "Fix auth middleware",
  key_topics: ["jwt", "compliance"],
  project_id: "...",
});
```

## Agent-Project Binding

Track which agent is working on which project:

```typescript
// On session start
await client.updateAgent("my-agent", { active_project_id: "project-uuid" });

// Query: who's on this project?
const { agents } = await client.getProjectAgents("open-mementos");
```

## Context Injection

```bash
# 60% smaller with compact format
mementos inject --format compact --project-id <id> --max-tokens 400
```

MCP: `memory_inject(project_id="...", format="compact", max_tokens=400)`

## Sessions Integration

After ingesting a session (open-sessions):

```bash
sessions remember <session-id> --mementos-url http://localhost:19428
# Creates: session-summary (history), session-topics (knowledge), session-notes (knowledge)
```

REST:
```json
POST /api/memories/extract
{ "session_id": "abc", "title": "Fix auth", "key_topics": ["jwt"] }
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMENTOS_DB_PATH` | Override DB path (bypasses profiles) | `~/.mementos/mementos.db` |
| `MEMENTOS_PROFILE` | Named profile → `~/.mementos/profiles/<name>.db` | none |
| `MEMENTOS_DB_SCOPE` | `project` = git root `.mementos/mementos.db` | global |
| `MEMENTOS_HOST` | Server bind address | `127.0.0.1` |
| `PORT` | Server port | `19428` |
| `MEMENTOS_URL` | SDK client base URL (`MementosClient.fromEnv()`) | `http://localhost:19428` |

## Library

```typescript
import {
  createMemory, getMemoryByKey, listMemories, searchMemories,
  registerAgent, updateAgent, listAgentsByProject,
  registerProject, getProject,
  getActiveProfile, setActiveProfile,
  MemoryInjector,
} from "@hasna/mementos";
```

## Architecture

```
src/
  cli/         Commander.js + Ink TUI — 20+ commands
  mcp/         MCP server — 40+ tools (lean stubs)
  server/      REST API — 37+ endpoints (Bun.serve)
  db/          SQLite (bun:sqlite) — memories, agents, projects, entities, relations
  lib/         FTS5 search, injection, extraction, retention, config, profiles
  types/       TypeScript interfaces and errors
sdk/           @hasna/mementos-sdk — zero-dep fetch client
dashboard/     React+Vite web UI
```

## License

Apache-2.0
