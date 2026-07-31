# @hasna/mementos

Persistent memory for AI agents, available as a CLI, MCP server, REST service,
and TypeScript library. Mementos stores memories in local SQLite by default and
can route clients to a self-hosted PostgreSQL-backed service over an authenticated
HTTP API.

[![npm](https://img.shields.io/npm/v/@hasna/mementos)](https://www.npmjs.com/package/@hasna/mementos)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

Mementos requires [Bun](https://bun.sh/) 1.0 or newer at runtime.

```bash
npm install -g @hasna/mementos
# or
bun add -g @hasna/mementos
```

The package installs three binaries:

| Binary | Purpose |
| --- | --- |
| `mementos` | Memory, agent, project, graph, session, and maintenance CLI |
| `mementos-mcp` | MCP server; Streamable HTTP by default, stdio on request |
| `mementos-serve` | REST API and dashboard server |

## Quick start

Local mode needs no service or database configuration. The first command creates
and migrates `~/.hasna/mementos/mementos.db`.

```bash
mementos save project-stack "Bun, TypeScript, SQLite" \
  --scope shared --category fact
mementos recall project-stack
mementos search "TypeScript"
mementos list --scope shared
```

Register an agent and project when memories need explicit ownership:

```bash
mementos projects --add --name my-project --path "$PWD"
mementos register-agent marcus --role coding-agent
mementos inject --project "$PWD" --agent marcus --format compact
```

Memory scopes are `global`, `shared`, `private`, and `working`. `working` is
transient session scratch space and defaults to a one-hour lifetime. Categories
are `preference`, `fact`, `knowledge`, `history`, `procedural`, and `resource`.

## CLI

```bash
mementos --help
mementos <command> --help
```

Human-readable list and search commands are compact and paginated by default.
Use `--limit` with `--cursor` or `--offset`, `--verbose` for wider snippets, and
`mementos show <id>` for a full record. Use global `--json` or a supported
`--format json|csv|yaml` option for structured output.

```bash
mementos list --limit 20 --cursor 20
mementos search "deploy" --verbose
mementos --json list
mementos storage mode --json
```

The complete command tree and option conventions are in the
[CLI reference](docs/CLI.md).

## MCP

`mementos-mcp` defaults to a shared, stateless Streamable HTTP server bound to
`127.0.0.1:8867`:

```bash
mementos-mcp
# explicit equivalent
mementos-mcp --http --port 8867
```

Endpoints are `GET /health` and `POST /mcp`. Set `MCP_HTTP_PORT` to change the
port. For an MCP host that launches a child process over stdio, opt in explicitly:

```bash
mementos-mcp --stdio
# or: MCP_STDIO=1 mementos-mcp
```

Cursor, Codex, Claude, and other command-based MCP host entries should use
`command = "mementos-mcp"` with `args = ["--stdio"]`.

The server exposes its live tools plus `mementos://memories`,
`mementos://agents`, and `mementos://projects`. MCP `tools/list` is the complete
schema source; the convenience `search_tools` and `describe_tools` calls cover
the smaller registered utility discovery catalog. See the [MCP
reference](docs/MCP.md) for installation examples and the full tool inventory.

## REST API

```bash
mementos-serve --port 19428
```

The server binds to `127.0.0.1` unless `MEMENTOS_HOST` is set. `/v1` is the
canonical API prefix and `/api` is a backward-compatible alias. Operational
probes and the generated contract are available without authentication:

```text
GET /health
GET /ready
GET /version
GET /openapi.json
```

API routes use bearer/API-key authentication when configured. See the
[REST API reference](docs/REST-API.md).

## Storage modes

### Local clients

SQLite is authoritative by default. Database selection order is:

1. `HASNA_MEMENTOS_DB_PATH` or `MEMENTOS_DB_PATH`.
2. The nearest existing `.mementos/mementos.db` walking up from the current directory.
3. Git-root `.mementos/mementos.db` when `MEMENTOS_DB_SCOPE=project`.
4. `~/.hasna/mementos/mementos.db`.

Legacy `~/.mementos` data is copied to `~/.hasna/mementos` when the new directory
does not yet exist.

### Self-hosted cloud

Raw PostgreSQL credentials are server-only. Configure `mementos-serve` with
`HASNA_MEMENTOS_STORAGE_MODE=cloud` and `HASNA_MEMENTOS_DATABASE_URL`. Configure
CLI and MCP clients with the HTTPS API endpoint and API key instead:

```bash
# mementos-serve environment
HASNA_MEMENTOS_STORAGE_MODE=cloud
HASNA_MEMENTOS_DATABASE_URL=postgres://...

# client environment; do not distribute the database URL to clients
HASNA_MEMENTOS_API_URL=https://mementos.example.com
HASNA_MEMENTOS_API_KEY=...
```

Both API variables must be present to select client API mode, and a database URL
on the same client disables API mode. `mementos storage mode` reports the chosen
backend without opening a database or making a network request.

The old `storage push`, `pull`, and `sync` commands remain for compatibility;
they are not the cloud cutover architecture. See [Configuration and
storage](docs/CONFIGURATION.md) and the [cloud cutover runbook](docs/CUTOVER-RUNBOOK.md).

## TypeScript APIs

The main package exports the synchronous database/domain API from
`@hasna/mementos` and an authenticated fetch client from `@hasna/mementos/sdk`.
The repository also contains the separately published zero-dependency
`@hasna/mementos-sdk` client. See [Library and SDK APIs](docs/LIBRARY.md) and
the [standalone SDK README](sdk/README.md).

## Shared event webhooks

The CLI includes the `events` and `webhooks` command groups supplied by
`@hasna/events`, allowing memory events to trigger command or HTTP automation.
Inspect their installed-version help before configuring a webhook:

```bash
mementos events --help
mementos webhooks --help
```

Event command handlers receive the envelope on stdin and in
`HASNA_EVENT_JSON`. Include `working_dir`, `project_path`, or `repo_path` when a
downstream agent must run in a particular repository.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

Development entry points are `bun run dev:cli`, `bun run dev:mcp`, and
`bun run dev:serve`.

## Documentation

- [CLI reference](docs/CLI.md)
- [MCP reference](docs/MCP.md)
- [REST API reference](docs/REST-API.md)
- [Configuration and storage](docs/CONFIGURATION.md)
- [Library and SDK APIs](docs/LIBRARY.md)
- [Cloud cutover runbook](docs/CUTOVER-RUNBOOK.md)

## License

Apache-2.0 — see [LICENSE](LICENSE).
