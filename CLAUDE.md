# open-mementos — Agent Guidelines

## Project Overview

`@hasna/mementos` is the persistent memory layer for AI agents. It stores, searches, and injects memories across sessions and projects. Every agent that works across multiple sessions MUST use mementos to maintain continuity.

## Standard Agent Workflow

### Session Start

```
1. Register yourself (idempotent):
   register_agent(name="<your-name>", role="<your-role>")

2. Register/confirm your project:
   register_project(name="<repo-name>", path="<absolute-path>")

3. Bind yourself to your current project:
   update_agent(id="<your-name>", active_project_id="<project-uuid>")

4. Load context into your prompt (use compact for token savings):
   memory_inject(project_id="<id>", agent_id="<id>", format="compact", max_tokens=400)

5. Recall specific keys you need:
   memory_recall(key="project-stack", project_id="<id>")
   memory_recall(key="learning-*", project_id="<id>")
```

### During Work

```
# Save every important learning, decision, or correction immediately:
memory_save(
  key="<descriptive-kebab-case-key>",
  value="<what you learned + why it matters>",
  category="knowledge",   # or: preference, fact, history
  scope="shared",         # visible to all agents on this project
  importance=7,           # 1-10; user corrections = 9-10
  agent_id="<your-id>",
  project_id="<proj-id>",
  session_id="<current-session-id>"
)

# When you correct a mistake or get corrected by user:
memory_save(key="correction-<topic>", importance=10, ...)

# When you make an architectural decision:
memory_save(category="fact", scope="shared", importance=9, ...)
```

### Session End

```
# Save session summary:
memory_save(
  key="session-<date>-summary",
  value="What was accomplished, what changed, unfinished work",
  category="history",
  scope="shared",
  importance=7,
  session_id="<current-session-id>"
)

# If using open-sessions, auto-extract from session:
session_extract(
  session_id="<id>",
  title="<session title>",
  project="<project name>",
  key_topics=["topic1", "topic2"],
  summary="<brief summary>",
  agent_id="<id>",
  project_id="<id>"
)
```

## Memory Categories

| Category | Use For | Typical Importance |
|----------|---------|-------------------|
| `preference` | User preferences, style choices | 8-9 |
| `fact` | Architecture decisions, tech stack, constraints | 8-10 |
| `knowledge` | Learnings, patterns, "how things work" | 6-8 |
| `history` | Session summaries, what happened when | 5-7 |

## Memory Scopes

| Scope | Visible To | Use For |
|-------|-----------|---------|
| `global` | All agents, all projects | Universal truths, user preferences |
| `shared` | All agents on this project | Project conventions, team decisions |
| `private` | Only this agent | Session context, drafts, notes |

## Key Naming Convention

Use lowercase kebab-case: `project-stack`, `learning-fts5`, `correction-db-path`, `session-2026-03-14-summary`

**Prefix patterns:**
- `learning-<topic>` — things discovered/debugged
- `correction-<topic>` — mistakes and the right approach
- `session-<id>-<type>` — session-linked memories (use session_id field too)
- `project-<aspect>` — project-wide facts

## Token Optimization

Always use `format="compact"` on `memory_inject` unless you need the wrapping:
- `compact`: `key: value` — ~60% smaller than xml, best for agent prompts
- `xml`: `<agent-memories>` wrapped — original format (default)
- `markdown`: `## Agent Memories` — good for human-readable docs
- `json`: array of objects — good for programmatic processing

## Development

```bash
bun test              # run all 714 tests
bun run build         # build all targets (cli, mcp, server, library)
bun run dev:serve     # start REST server on port 19428
bun run dev:mcp       # start MCP server
mementos doctor       # diagnose DB health
```

## MCP Server Install

```bash
# User scope (available in all projects)
claude mcp add --transport stdio --scope user mementos -- mementos-mcp

# Project scope (shared via .mcp.json)
claude mcp add --transport stdio --scope project mementos -- mementos-mcp
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMENTOS_DB_PATH` | Override DB location | `~/.mementos/mementos.db` |
| `MEMENTOS_DB_SCOPE` | `project` = use git root | global |
| `PORT` | REST server port | `19428` |

## Cross-Project Integration

| Integration | How |
|-------------|-----|
| **open-sessions** | `session_extract(session_id, ...)` after session ingest — auto-saves key learnings |
| **open-todos** | Include `session_id` on `memory_save` when working on a task |
| **open-economy** | `memory_save(key="cost-session-X", value="$1.23")` — track costs as memories |
| **open-conversations** | `update_agent(active_project_id)` — mementos is the canonical agent registry |
| **open-configs** | `memory_inject()` for context; saves config decisions as `fact` memories |
| **open-attachments** | Store attachment IDs as memory values for later retrieval |

## Architecture

```
src/
  cli/          Commander.js + Ink TUI — mementos CLI (15+ commands)
  mcp/          MCP server — 37+ tools (lean stubs, describe_tools/search_tools)
  server/       REST API — 37+ endpoints (Bun.serve, no framework)
  db/           SQLite layer (bun:sqlite) — memories, agents, projects, entities, relations
  lib/          search (FTS5+fuzzy), extractor, injection, retention, sync
  types/        TypeScript interfaces
sdk/            @hasna/mementos-sdk — zero-dep fetch client
dashboard/      React+Vite web UI
```
