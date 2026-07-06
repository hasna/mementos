# Mementos Cloud Cutover Runbook

Cutover of `@hasna/mementos` from local SQLite to the shared cloud PostgreSQL
(RDS) backend, per the OSS cloud-runtime plan (STORAGE AMENDMENT A1: **pure
`cloud` / remote** — reads AND writes go directly to cloud Postgres; no sync
engine, no local cache-as-mode, no merge logic).

> **Mementos flips LAST.** Memory recall is on the hot path of every agent
> session (auto-inject, briefings, semantic recall). Cut mementos over only
> after the lower-risk stores (knowledge, conversations, todos) are proven, so a
> latency or availability regression cannot silently degrade every session.

---

## 1. Storage-mode contract (aligned with the shared standard)

Runtime enum: **`local | cloud`** (env `HASNA_MEMENTOS_STORAGE_MODE`).

| Value      | Meaning                                                        |
| ---------- | -------------------------------------------------------------- |
| `local`    | SQLite on disk (default). Unchanged behavior.                  |
| `cloud`    | Pure remote: reads and writes go directly to cloud Postgres.   |
| `remote`   | **Deprecated alias** → normalizes to `cloud` (emits warning).  |
| `hybrid`   | **Deprecated alias** → normalizes to `cloud` (emits warning).  |

- Canonical value is `cloud`. `remote` and `hybrid` remain accepted as input
  (env or `~/.hasna/mementos/storage/config.json`) for full back-compat, but
  each emits a one-time `DeprecationWarning` (to **stderr**, never stdout) with
  code `MEMENTOS_STORAGE_MODE_ALIAS`.
- The legacy local↔remote **sync engine** (`storage-sync.ts`) is the old
  "hybrid" path. It is retained only for back-compat and is **NOT** the fleet
  cutover mechanism. The fleet uses pure `cloud` (direct remote reads/writes).
  If a hot path is slow on DERP-relayed machines, the fix is network (subnet
  router / direct Tailscale paths / read replica) — never a re-introduced sync
  layer.
- Env var precedence (both databaseUrl and mode): `HASNA_MEMENTOS_*` canonical,
  `MEMENTOS_*` accepted as fallback. A configured database URL with no explicit
  mode auto-promotes `local → cloud`.

---

## 2. Prerequisites

- **Shared RDS**: `hasna-xyz-infra-apps-prod-postgres` (pg16, MultiAZ) in account
  `789877399345` (`hasna-xyz-infra`). Never public.
- **Database**: `mementos` on that instance (app role + owner role bootstrapped
  by the AWS foundation lane).
- **Secrets** (Secrets Manager, `789877399345`, names only — never print values):
  - `hasna/oss/mementos/database-url` — app role DSN (runtime).
  - `hasna/oss/mementos/database-url-owner` — owner role DSN (schema/DDL only).
- **Network reachability**: RDS is private. Cutover and schema steps must run
  from a machine on the VPC / Tailscale path to the instance (a fleet host or a
  bastion), NOT from an arbitrary dev laptop. See §5.

---

## 3. Apply the schema (owner role)

The PG schema lives in `src/db/pg-migrations.ts` (35 migrations, tracked in
`_pg_migrations` with an idempotent version ledger). Apply with the owner DSN:

```bash
# Owner DSN injected from Secrets Manager into the env — never echoed.
export HASNA_MEMENTOS_DATABASE_URL="$(aws secretsmanager get-secret-value \
  --secret-id hasna/oss/mementos/database-url-owner \
  --query SecretString --output text)"

mementos migrate-pg --json     # or: bun run src/cli/commands ... during dev
```

`migrate-pg` creates `_pg_migrations`, applies pending migrations in order, and
stops on the first error. Re-running is safe (already-applied migrations are
skipped). Expected clean result: `applied: 35, errors: []` on a fresh DB;
`applied: 0, alreadyApplied: 35` on re-run.

### pgvector (embeddings foundation)

The current schema stores embeddings as **TEXT** (`memory_embeddings.embedding
TEXT`), so pgvector is **not required** for cutover. For future native vector
search, enable it once on the mementos database with the owner role:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Check availability first:

```sql
SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'vector';
```

If the shared RDS instance does not expose `vector` in
`pg_available_extensions`, that is a **foundation follow-up** (RDS parameter
group / instance capability), not a mementos code change.

---

## 4. Readiness proof

`scripts/cloud-readiness-proof.ts` exercises the repo's **own remote code path**
(same `PgAdapterAsync` + SQL translation the cloud path uses) against a Postgres
target: applies migrations, checks pgvector, runs a save→recall round-trip
(cleaned up afterward), and measures round-trip latency. It prints JSON only and
never prints the connection string.

```bash
HASNA_MEMENTOS_DATABASE_URL="postgres://..." bun run scripts/cloud-readiness-proof.ts
```

Proof result on a throwaway **pg16** DB (validating the code path; run this
against the real RDS from a VPC-reachable host before the flip):

```json
{
  "ok": true,
  "steps": {
    "migrations": { "total": 35, "applied": 35, "alreadyApplied": 0, "errors": [] },
    "pgvector":   { "available": false, "default_version": null, "installed_version": null },
    "saveRecall": { "recalled": true },
    "latencyMs":  { "samples": 20, "min": 0.13, "p50": 0.16, "max": 0.55, "avg": 0.19 }
  }
}
```

---

## 5. Latency note (why mementos flips last)

Recall is on the hot path, so cloud latency directly taxes every session. Record
**measured** query latency from the fleet before the flip.

- **From this preparation run**: the shared RDS endpoint was **unreachable on
  TCP/5432** from the build machine (connection timeout) — expected and correct,
  because the instance is private and the machine is not on the VPC/Tailscale
  path. The `latencyMs.p50 ≈ 0.16ms` figure above is a **loopback proof against
  a local pg16** and is NOT representative of fleet latency.
- **Required before flip**: run the readiness script (or `SELECT 1` timing) from
  a VPC/Tailscale-reachable fleet host and record p50/p95 round-trip. Budget
  guidance: if p95 for a simple query exceeds a few ms on DERP-relayed machines,
  fix the network path (subnet router / direct Tailscale / read replica) — do
  not add a sync/cache layer.

---

## 6. Cutover steps

1. Confirm knowledge / conversations / todos are already cut over and healthy.
2. Apply schema to RDS (§3) with the owner DSN; verify `errors: []`.
3. Enable pgvector if the instance supports it (§3) — optional, non-blocking.
4. Run the readiness proof from a fleet host (§4) and record latency (§5).
5. Point runtime at cloud (app role DSN, not owner):
   ```bash
   export HASNA_MEMENTOS_DATABASE_URL="<app-role DSN from hasna/oss/mementos/database-url>"
   export HASNA_MEMENTOS_STORAGE_MODE=cloud
   ```
6. Back up the local SQLite as a **dated one-time backup** (never read again):
   ```bash
   cp ~/.hasna/mementos/mementos.db ~/.hasna/mementos/mementos.local-backup-$(date +%Y%m%d).db
   ```
7. Smoke test: `mementos memory save`, `mementos memory recall`, and an MCP
   `memory_recall` against the cloud DB.

---

## 7. Rollback

Cutover is reversible until the local backup is discarded:

```bash
unset HASNA_MEMENTOS_STORAGE_MODE HASNA_MEMENTOS_DATABASE_URL   # back to local SQLite
```

The dated SQLite backup remains authoritative for pre-cutover state. Because the
fleet path is pure remote (no sync), rolling back returns to the local snapshot;
memories written to cloud after cutover stay in cloud.

---

## 8. Open follow-ups (blocked at prep time)

- **Owner secret**: `hasna/oss/mementos/database-url-owner` did not exist at prep
  time (no `hasna/oss/*` secrets published yet). Foundation lane to create the
  mementos database, app + owner roles, and both secrets.
- **RDS reachability**: schema apply + real latency measurement must run from a
  VPC/Tailscale-reachable host (blocked from the prep machine).
- **pgvector on RDS**: verify `vector` is available in the instance's
  `pg_available_extensions`; if not, a parameter-group / instance follow-up.
