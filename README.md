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

## MCP Server

```bash
mementos-mcp
```

116 tools available.

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
