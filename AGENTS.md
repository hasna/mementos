# AGENTS.md — @hasna/mementos for AI Agents

This document explains how AI agents (Claude, Codex, Gemini, custom) should use `@hasna/mementos` for persistent memory.

## Quick Setup

```
# 1. Install the MCP server
mementos mcp --claude       # Claude Code (uses claude mcp add)
mementos mcp --codex        # Codex
mementos mcp --all          # All agents

# 2. Start REST server (optional — for SDK/HTTP access)
mementos-serve --port 19428  # Default port
```

## Session Start Protocol

Run at the beginning of every agent session:

```
1. register_agent(name="<your-roman-name>", role="<role>")
2. register_project(name="<git-repo-name>", path="<absolute-path>")
3. update_agent(id="<your-name>", active_project_id="<project-uuid>")  -- bind to project
4. memory_inject(project_id="<id>", format="compact", max_tokens=400)  -- load context
```

## During Work

Save memories immediately when:
- User corrects you → importance 9-10
- You learn something unexpected → importance 7-8
- You make an architectural decision → importance 8-9
- You finish a task → importance 5-7

```
memory_save(
  key="<descriptive-kebab-key>",
  value="<what + why it matters>",
  category="knowledge",     # preference | fact | knowledge | history
  scope="shared",           # global | shared | private
  importance=8,
  agent_id="<your-id>",
  project_id="<project-id>",
  session_id="<current-session>"
)
```

## Session End Protocol

```
1. session_extract(session_id="<id>", title="...", key_topics=[...], project_id="...")
2. memory_save(key="session-<date>-summary", category="history", ...)
```

## MCP Tool Profiles

Use `search_tools("keyword")` to find tools, `describe_tools(["name"])` for full docs.

### Minimal (token-sensitive contexts)
```
memory_save      -- save/upsert
memory_recall    -- get by key
memory_inject    -- load context (format=compact)
memory_forget    -- delete
```

### Standard (most sessions)
All minimal tools, plus:
```
memory_list      -- browse with filters
memory_search    -- full-text + fuzzy search
memory_update    -- update fields (version optional)
memory_pin       -- pin without version
memory_archive   -- archive without version
memory_get       -- get by ID
memory_stats     -- aggregate stats
memory_activity  -- daily creation trend
session_extract  -- auto-extract from session summary
register_agent   -- register yourself
register_project -- register project
update_agent     -- bind to project (active_project_id)
list_agents      -- who's registered
list_projects    -- registered projects
```

### Full (research, auditing, knowledge graph)
All standard tools, plus:
```
memory_versions   -- version history for a memory
memory_export     -- bulk export
memory_import     -- bulk import
bulk_forget       -- delete multiple
bulk_update       -- update multiple
memory_context    -- raw context list
clean_expired     -- maintenance
entity_create     -- knowledge graph entities
entity_list       -- browse entities
entity_get        -- get entity
entity_link       -- link memory to entity
relation_create   -- entity relationships
graph_query       -- traverse knowledge graph
list_agents_by_project  -- who's on a project
get_project       -- project details
```

## Token Optimization

**Critical**: use `format="compact"` on `memory_inject` — saves ~60% tokens.

| Format | Output | Size |
|--------|--------|------|
| `compact` | `key: value` | Smallest (~60% less than xml) |
| `xml` | `<agent-memories>` wrapped | Default, backward compat |
| `markdown` | `## Agent Memories` | Human-readable |
| `json` | JSON array | Machine processing |

## Key Naming Convention

```
project-stack          -- project facts
learning-<topic>       -- discovered patterns
correction-<topic>     -- mistakes + right approach (importance 10)
session-<id>-summary   -- session history
agent-workflow-<name>  -- process knowledge
```

## Memory Scopes

| Scope | Visible To | When |
|-------|-----------|------|
| `global` | ALL agents, all projects | Universal truths, user preferences |
| `shared` | All agents on this project | Project decisions, conventions |
| `private` | Only this agent session | Drafts, per-session notes |

**Default to `shared`** for most memories — other agents on the project benefit.

## Cross-Project Integrations

| Tool | Integration |
|------|------------|
| **@hasna/sessions** | `session_extract()` after session ingest → auto-save learnings |
| **@hasna/todos** | Include `session_id` in memory_save when working on a task |
| **@hasna/attachments** | Store attachment IDs as memory values |
| **@hasna/conversations** | `update_agent(active_project_id)` → mementos as agent registry |
| **@hasna/configs** | `memory_inject()` for context; config decisions as `fact` memories |
| **open-brains** | `GET /api/memories?scope=shared&min_importance=6` for training data |

## Common Patterns

### Pattern: correction memory (highest priority)
When user says "that's wrong, it should be X":
```
memory_save(key="correction-<topic>", value="WRONG: <what>. CORRECT: <fix>. WHY: <reason>", importance=10, scope="shared")
```

### Pattern: version-free updates (no 2-round-trips needed)
```
memory_update(id="<id>", importance=9)           -- version auto-fetched
memory_pin(key="project-stack")                  -- no version needed
memory_archive(key="old-pattern")                -- no version needed
```

### Pattern: query session learnings
```
GET /api/memories?session_id=<id>                -- everything this session produced
memory_list(session_id="<id>")                   -- same via MCP
```

### Pattern: who's on a project
```
list_agents_by_project(project_id="<id>")        -- active agents for a project
GET /api/projects/<name>/agents                  -- same via REST
GET /api/agents?project_id=<id>                  -- same via REST
```

### Pattern: daily activity trend
```
memory_activity(days=7, project_id="<id>")       -- how fast is the agent learning?
GET /api/activity?days=14                         -- same via REST
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MEMENTOS_PROFILE` | Named profile (`~/.mementos/profiles/<name>.db`) | none |
| `MEMENTOS_DB_PATH` | Override DB path | `~/.mementos/mementos.db` |
| `MEMENTOS_DB_SCOPE` | `project` = use git root DB | global |
| `MEMENTOS_HOST` | Server bind address | `127.0.0.1` |

## Ports

Default REST server port: **19428**

```
MEMENTOS_URL=http://localhost:19428   # for SDK clients
```

## Constraints

- Memory keys are unique per (key, scope, agent_id, project_id, session_id)
- Duplicate keys with same scope → **upsert** (value updated, version incremented)
- `version` field in `memory_update` is **optional** — auto-fetched if not provided
- Expired memories are hidden but not deleted until `clean_expired` is called
- Max 365 days in `memory_activity` query
- `memory_inject` token budget: 500 tokens default, `max_tokens` param to override
