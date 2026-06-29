# @hasna/mementos

Universal memory system for AI agents - CLI + MCP server + library API

[![npm](https://img.shields.io/npm/v/@hasna/mementos)](https://www.npmjs.com/package/@hasna/mementos)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/mementos
```

## CLI Usage

```bash
mementos --help
```

CLI output is compact by default so agent terminals do not fill with full
records. List/search/history commands show capped rows, truncated values, and a
hint for the next page or detail path.

```bash
mementos list                         # compact page, default 20 rows
mementos list --cursor 20 --limit 20  # next page
mementos search "deploy"              # compact results, no highlights
mementos search "deploy" --verbose    # include match highlights
mementos show <id>                    # full memory detail
mementos --json list                  # stable machine-readable objects
```

## Shared Event Webhooks

`mementos` exposes the shared `@hasna/events` commands so memory events can
trigger deterministic or agentic automation without custom glue scripts. To
route mementos events into an OpenLoops worker/verifier template, register a
command webhook:

```bash
mementos webhooks add loops \
  --id openloops-mementos-events \
  --transport command \
  --source mementos \
  --type "*" \
  --arg=events \
  --arg=handle \
  --arg=generic \
  --arg=--provider \
  --arg=codewith \
  --arg=--auth-profile \
  --arg=account005 \
  --arg=--permission-mode \
  --arg=bypass \
  --arg=--sandbox \
  --arg=danger-full-access \
  --timeout-ms 900000 \
  --json
```

`@hasna/events` sends the event envelope on stdin and in `HASNA_EVENT_JSON`.
OpenLoops can then create a deduped one-shot workflow for the event. Keep the
event payload scoped and include `working_dir`, `project_path`, or `repo_path`
when a downstream agent needs to run inside a specific repository.

## MCP Server

```bash
mementos-mcp
```

116 tools available.

MCP list/status tools also default to compact text. Use tool-specific
`limit`/`offset` arguments for paging and `full=true` or `format="json"` on tools
that expose it when a complete object dump is required.

## HTTP mode

Run a shared Streamable HTTP MCP server (stateless, `127.0.0.1` only):

```bash
mementos-mcp --http
# or: MCP_HTTP=1 mementos-mcp
# default port: 8824 (override with --port or MCP_HTTP_PORT)
```

Endpoints: `GET /health`, `POST /mcp` (Streamable HTTP).

## REST API

```bash
mementos-serve
```

## Storage Sync

Mementos owns its local and remote storage path. Local data stays in the
SQLite database under `~/.hasna/mementos/` by default. Remote sync uses the
native `mementos storage` commands and the `HASNA_MEMENTOS_DATABASE_URL` or
`MEMENTOS_DATABASE_URL` environment variable when PostgreSQL storage is
configured.

```bash
mementos storage status
mementos storage push
mementos storage pull
mementos storage sync
```

## Data Directory

Data is stored in `~/.hasna/mementos/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
