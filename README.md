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

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service mementos
cloud sync pull --service mementos
```

## Data Directory

Data is stored in `~/.hasna/mementos/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
