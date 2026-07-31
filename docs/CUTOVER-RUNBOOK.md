# Mementos cloud cutover runbook

This runbook moves `@hasna/mementos` from per-machine SQLite to the self-hosted
PostgreSQL-backed REST service implemented by the current branch.

> Mementos flips last. Memory recall and prompt injection are on the hot path of
> agent sessions. Prove the service, database, authentication, and network path
> before changing clients.

## 1. Current architecture

The runtime has a strict server/client boundary:

```text
CLI / MCP / SDK client
  HASNA_MEMENTOS_API_URL + HASNA_MEMENTOS_API_KEY
                    |
                    | HTTPS /v1, bearer API key
                    v
              mementos-serve
  HASNA_MEMENTOS_STORAGE_MODE=cloud
  HASNA_MEMENTOS_DATABASE_URL=postgres://...
                    |
                    v
             PostgreSQL / RDS
```

- `local` is the default and uses SQLite.
- `cloud` is pure remote on `mementos-serve`: reads and writes go directly to
  PostgreSQL. There is no SQLite cache or merge layer.
- `remote` and `hybrid` are deprecated input aliases for `cloud`.
- Raw database credentials are server/administrative secrets. Fleet clients
  must use the authenticated API and must not receive the DSN.
- The compatibility `storage push`, `pull`, and `sync` paths are not the cutover
  architecture.

## 2. Prerequisites

- A private PostgreSQL 16/RDS-compatible database and an application role.
- A schema-owner/admin role available only during migration.
- Network reachability from `mementos-serve` to PostgreSQL.
- TLS policy and, for `verify-ca`/`verify-full`, the required CA bundle.
- A deployed `mementos-serve` endpoint reachable from clients over HTTPS.
- One of the signing secrets supported by the server:
  `API_KEY_SIGNING_SECRET`, `HASNA_MEMENTOS_API_SIGNING_KEY`, or
  `HASNA_API_SIGNING_KEY`.
- Issued mementos API keys for clients. The server also supports a legacy static
  `MEMENTOS_API_KEY` for local/dev deployments.
- A dated backup/export of every authoritative SQLite store that will be
  backfilled or retired.

Never print or commit a database URL, signing secret, or client API key.

## 3. Apply the PostgreSQL schema

The schema is defined by `PG_MIGRATIONS` in `src/db/pg-migrations.ts` and tracked
by zero-based array index in `_pg_migrations`. The current source contains 36
migration blocks. Use the command's reported `total_migrations` in automation so
future additions do not make a copied count stale.

Dry-run is local validation only: it does not connect or mutate a database and
redacts credentials.

```bash
mementos storage migrate --dry-run \
  --connection-string 'postgres://owner:REDACTED@db.internal/mementos?sslmode=require' \
  --json
```

Run the live migration from an approved, database-reachable administrative
environment:

```bash
mementos storage migrate \
  --connection-string 'postgres://owner:REDACTED@db.internal/mementos?sslmode=require' \
  --json
```

The explicit connection-string option is an administrative override. A normal
CLI client cannot construct the server DSN. The top-level `migrate-pg` command
is a legacy equivalent. Applying is idempotent: already recorded array indexes
are skipped, and execution stops on the first failing block.

Keep real credentials out of shell history and process inspection. Prefer an
ephemeral administrative runner or another approved secret-injection wrapper.

### pgvector

The current schema stores embeddings as text, so pgvector is not required for
the basic cutover. Standard FTS/LIKE and fuzzy search remain available without
it. Native vector support is an optional follow-up and must be enabled by an
authorized database owner if the target exposes the extension.

## 4. Readiness proof

`scripts/cloud-readiness-proof.ts` uses the repository's PostgreSQL adapter and
migration code. It applies migrations, checks pgvector availability, performs a
save/recall round trip which it cleans up, and reports latency as JSON. It does
not print the connection string.

```bash
HASNA_MEMENTOS_DATABASE_URL='postgres://...' \
  bun run scripts/cloud-readiness-proof.ts
```

Run this from the same network class as the deployed server, not from an
unrelated laptop or loopback PostgreSQL. Record p50 and worst-case latency and
confirm `ok: true`, no migration errors, and `saveRecall.recalled: true`.

Also verify the deployed service:

```bash
curl -fsS https://mementos.example.com/version
curl -fsS https://mementos.example.com/ready
curl -fsS https://mementos.example.com/health
```

`/ready` must report `ready` in `cloud` mode before clients move.

## 5. Configure the server

The service environment is:

```bash
HASNA_MEMENTOS_STORAGE_MODE=cloud
HASNA_MEMENTOS_DATABASE_URL=postgres://app-role:REDACTED@db.internal/mementos?sslmode=require
API_KEY_SIGNING_SECRET=REDACTED
MEMENTOS_HOST=0.0.0.0
PORT=19428
```

The public listener should be behind the deployment's TLS/reverse-proxy layer;
the built-in server is HTTP. `MEMENTOS_CORS_ORIGIN` should name the one browser
origin allowed to use the dashboard/API.

Database URL precedence is `HASNA_MEMENTOS_DATABASE_URL`, then
`MEMENTOS_DATABASE_URL`. Mode precedence is the matching `HASNA_...` variable,
then the fallback, then `~/.hasna/mementos/storage/config.json`. A database URL
without an explicit mode auto-promotes the server from local to cloud, but set
the mode explicitly during a cutover.

Cloud startup and requests fail closed when the URL is missing, malformed,
non-PostgreSQL, or unreachable. Status output redacts the URL.

## 6. Backfill existing memories

Take a dated local backup before migration:

```bash
mementos backup ~/.hasna/mementos/backups/pre-cloud-cutover.db
mementos export > ~/.hasna/mementos/backups/pre-cloud-cutover.json
```

Use the authenticated `POST /v1/memories/bulk-upsert` endpoint for a faithful,
idempotent backfill which preserves IDs and archived status. The route reports
`rejected` separately from already-present `skipped` rows and returns HTTP 400
if anything failed to persist. Fix rejected rows and rerun the same payload.

Do not use the old peer-to-peer `storage sync` path as the fleet migration
mechanism.

## 7. Cut over clients

On each client, remove every direct database selector and configure the API:

```bash
unset HASNA_MEMENTOS_DATABASE_URL MEMENTOS_DATABASE_URL
unset HASNA_MEMENTOS_STORAGE_MODE MEMENTOS_STORAGE_MODE

export HASNA_MEMENTOS_API_URL=https://mementos.example.com
export HASNA_MEMENTOS_API_KEY=REDACTED
```

Both API variables are required. A lingering database URL disables API mode,
so validate before any write:

```bash
mementos storage mode --json
```

Expected fields include:

```json
{
  "backend": "cloud-api",
  "api_mode": true,
  "api_key_present": true
}
```

For command-based MCP hosts, include stdio explicitly because
`mementos-mcp` now defaults to Streamable HTTP:

```text
command = "mementos-mcp"
args = ["--stdio"]
```

The shared HTTP MCP server is instead available at `127.0.0.1:8867/mcp` by
default.

## 8. Smoke test

Use a unique key and remove it when complete:

```bash
mementos save cutover-smoke "cloud write $(date -u +%FT%TZ)" \
  --scope shared --category history --dedupe create
mementos recall cutover-smoke --scope shared
mementos search cutover-smoke
mementos forget cutover-smoke --scope shared --all
```

Then verify the MCP tools `memory_save`, `memory_recall`, and `memory_forget`
from a real client, and make one SDK request with a bearer key. Confirm the rows
land in PostgreSQL and no local SQLite file changes during the test.

## 9. Rollback

There are two separate rollback decisions:

1. **Client rollback:** remove the API URL/key and restore the client-local
   SQLite backup/path. This returns that client to its pre-cutover snapshot;
   cloud writes made after cutover remain in PostgreSQL.
2. **Service rollback:** deploy a known-good server version or switch its mode
   to local only if the service has an intentionally provisioned authoritative
   local database. Do not silently make an empty container-local SQLite file
   authoritative.

Keep the PostgreSQL data and pre-cutover backups until reconciliation is
complete. Because pure-remote mode has no bidirectional cache, rollback never
automatically merges post-cutover cloud writes into old local files.

## 10. Final checklist

- [ ] Schema migration reports no errors.
- [ ] Readiness proof succeeds from the server network.
- [ ] `/ready` reports `cloud` and `ready`.
- [ ] Authentication rejects missing/invalid credentials.
- [ ] Backfill has zero rejected records.
- [ ] Every client reports `backend: cloud-api` before writing.
- [ ] CLI, MCP, and SDK smoke tests pass and are cleaned up.
- [ ] Latency and error-rate monitoring are in place.
- [ ] Rollback owners and backup retention are recorded.
