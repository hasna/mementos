# MCP reference

`mementos-mcp` exposes the memory system through the Model Context Protocol.
The current server registers 123 tools and three resources from the live source
tree.

## Transport modes

Streamable HTTP is the default:

```bash
mementos-mcp
mementos-mcp --http
MCP_HTTP_PORT=9000 mementos-mcp
```

It binds only to `127.0.0.1`. The default port is 8867, `POST /mcp` is the MCP
endpoint, and `GET /health` returns the service liveness response. `--port`
overrides `MCP_HTTP_PORT`.

Stdio is opt-in:

```bash
mementos-mcp --stdio
# or
MCP_STDIO=1 mementos-mcp
```

Command-based MCP host configuration must include `--stdio`; launching
`mementos-mcp` with no arguments starts HTTP and will not speak MCP on stdin.
For example:

```bash
claude mcp add --transport stdio --scope user mementos -- mementos-mcp --stdio
```

```toml
[mcp_servers.mementos]
command = "mementos-mcp"
args = ["--stdio"]
```

The `mementos mcp` CLI command manages Claude, Codex, and Gemini config files.
Because transport defaults changed to HTTP, inspect command-based entries it
creates and ensure their argument list contains `--stdio`.

## Runtime behavior

Before serving, the entry point performs best-effort startup checks, loads
persisted webhook hooks, and ensures the local REST service is available.
Stdio mode also starts contextual auto-injection and advertises the experimental
`claude/channel` capability. HTTP mode creates a stateless MCP server/transport
for each request and supports concurrent clients in one process.

Storage selection is shared with the CLI:

- local mode uses SQLite;
- client API mode uses `HASNA_MEMENTOS_API_URL` plus
  `HASNA_MEMENTOS_API_KEY` (fallback aliases without `HASNA_` are accepted);
- raw PostgreSQL database URLs belong only on `mementos-serve` or an explicit
  administrative migration path.

See [Configuration and storage](CONFIGURATION.md).

## Output conventions

List and status tools generally return compact text by default. The exact
controls are part of each schema, but common arguments are:

- `limit` and `offset` for paging;
- `verbose` for wider text;
- `full: true` for complete objects;
- `format: "json"` where the tool advertises a format argument.

`memory_inject` supports `xml`, `markdown`, `compact`, and `json`. It also
supports default or smart selection, full or hint output, task activation, and
machine visibility. `compact` is the smallest prompt-ready format; hint mode
returns topic/count summaries which can be followed by targeted
`memory_recall` calls.

MCP `tools/list` is authoritative for all names and Zod-derived input schemas.
The convenience `search_tools` and `describe_tools` tools currently index only
the seven utility discovery schemas registered in `utility-tools.ts`, not all
123 live tools.

## Tool inventory

### Core memories (29)

```text
memory_save
memory_recall
memory_get
memory_list
memory_update
memory_versions
memory_diff
memory_chain_get
memory_health
memory_check_contradiction
memory_invalidate
memory_search
memory_search_semantic
memory_search_hybrid
memory_search_bm25
memory_recall_deep
memory_pin
memory_archive
memory_forget
memory_stale
memory_flag
memory_stats
memory_activity
memory_report
memory_audit_trail
memory_audit_export
memory_export
memory_import
memory_inject
```

`memory_save` supports the four scopes and six categories documented in the
[CLI reference](CLI.md), conflict strategies, semantic/LLM deduplication,
machine-local memories, activation guidance, and ordered sequence groups.
`memory_recall` supports `as_of` temporal recall; list also accepts `as_of`.

### Agents, projects, focus, and machines (16)

```text
register_agent
list_agents
get_agent
update_agent
list_agents_by_project
register_project
list_projects
get_project
register_machine
list_machines
rename_machine
set_primary_machine
set_focus
heartbeat
get_focus
unfocus
```

Use stable agent and project IDs in memory calls after registration. A primary
machine controls fallback visibility/synchronization behavior; startup warns
when no primary machine is configured.

### Knowledge graph (19)

```text
entity_create
entity_get
entity_list
entity_delete
entity_merge
entity_link
entity_update
entity_unlink
entity_disambiguate
relation_get
relation_create
relation_list
relation_delete
graph_query
graph_path
graph_stats
graph_traverse
build_file_dep_graph
memory_tool_insights
```

### Locks and bulk operations (10)

```text
bulk_forget
bulk_update
memory_lock
memory_unlock
memory_check_lock
resource_lock
resource_unlock
resource_check_lock
list_agent_locks
clean_expired_locks
```

Memory write locks are short-lived coordination primitives. Resource locks
support advisory/exclusive ownership for projects, memories, entities, agents,
connectors, and files.

### Hooks, sessions, and synthesis (21)

```text
hook_list
hook_stats
webhook_create
webhook_list
webhook_delete
webhook_update
memory_synthesize
memory_synthesis_status
memory_synthesis_history
memory_synthesis_rollback
memory_auto_process
memory_auto_status
memory_auto_config
memory_auto_test
memory_autoinject_config
memory_autoinject_status
memory_autoinject_test
memory_ingest_session
memory_session_status
memory_session_list
session_extract
```

Auto-memory and synthesis require a configured provider. Supported provider
names are `anthropic`, `openai`, `cerebras`, and `grok`; the corresponding keys
are described in [Configuration and storage](CONFIGURATION.md).

### Context, discovery, and maintenance (7)

```text
clean_expired
memory_briefing
memory_context
memory_context_layered
memory_profile
search_tools
describe_tools
```

### Events and administration (13)

```text
memory_subscribe
memory_unsubscribe
memory_save_tool_event
send_feedback
migrate_pg
memory_audit
memory_rate
memory_gdpr_erase
memory_acl_set
memory_acl_list
memory_evict
memory_save_image
memory_compress
```

`migrate_pg` is a remote database mutation unless called with `dry_run: true`.
Image description can use `OPENAI_API_KEY` when an image URL is supplied without
a description.

### Storage, consolidation, and reflection (8)

```text
mementos_storage_status
mementos_storage_push
mementos_storage_pull
mementos_storage_sync
mementos_storage_migrate_dry_run
mementos_storage_feedback
memory_consolidate
memory_reflect
```

The push/pull/sync tools are retained compatibility paths, not the self-hosted
cloud cutover architecture. The migration MCP surface is deliberately dry-run
only; a live migration is an explicit administrative CLI/server operation.

## Resources

| URI | Contents |
| --- | --- |
| `mementos://memories` | Up to 1,000 active memories as JSON |
| `mementos://agents` | All registered agents as JSON |
| `mementos://projects` | All registered projects as JSON |

Resource reads use the selected store and therefore obey the same local/API
mode boundary as tools.
