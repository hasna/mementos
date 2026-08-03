# Changelog

## 0.14.73 — `save` refuses an unresolvable `--agent`/`--project`

**Behaviour change.** `mementos save` no longer discards a scoping flag it
cannot resolve.

- `save` now exits `1` when `--agent` or `--project` names something that does
  not resolve, instead of dropping the flag and writing at rc=0. Both flags are
  fixed at the same site, because repairing one leaves the mechanism live on the
  other. A row owned by a real agent was already protected by the existing fork
  guard; the damage was confined to the **unowned** bucket — 826 of 1185 active
  rows, 69.7% — where the save silently overwrote and misattributed. (#43)
- `save` now **warns** when the global `--session` flag receives a scope word
  (`shared`/`private`/`global`) — the guard `update` already had. Warn rather
  than throw, deliberately: roughly 80 live call sites depend on rc=0 today, and
  throwing would convert a documentation bug into a fleet outage. Those sites
  write `session_id="shared"` with scope left private and record the opposite of
  what they claim; fleet-wide, 96 of 1142 active rows carry a session_id that is
  literally a scope word. (#42)
- The fork-refusal message compared four columns and printed three, omitting
  `agent`. Where agent was the sole difference the message was self-contradictory
  — identical scope, project and session on both sides, and a refusal anyway. It
  now names the column that actually differs. (#42)

### Upgrade note

`--agent` and `--project` change from fail-open to fail-closed, so a caller
passing an unregistered name now fails loudly where it previously succeeded and
misfiled. Measured before merge: zero of 74–85 `mementos save` call sites across
the skill homes pass either flag. Seats passing one by hand will be told to run
`mementos register-agent <name>` — 347 of 500 live conversations identities are
absent from the mementos registry.

Already-damaged rows are **unrecoverable**: `createMemory` writes the same value
to both `agent_id` and `created_by_agent`, so an overwritten row is
indistinguishable from a legitimately unowned one.

### Also carried by this release

- Test-only: the two subprocess-heavy CLI tests in `src/cli/index.test.ts` now
  carry an explicit 60000ms budget. Each spawns a CLI subprocess per assertion
  setup step (27 and 14 spawns) and costs 19.00s and 11.22s against the suite's
  10s default, so `list compact` failed deterministically on a contended box.
  Read as flakiness for a long time because a timed-out test reports the
  **budget**, not the duration. No assertion is relaxed. This also unblocked
  `npm publish`, whose `prepublishOnly` runs the same suite — two publish
  attempts of 0.14.72 aborted on that one test. (#41)

## 0.14.72 — `recall` matches exactly; fuzzy fallback is opt-in

**Behaviour change.** `mementos recall <key>` no longer substitutes a different
record when the requested key is absent.

- `recall` now matches the exact key and exits `1` when it is missing, printing
  no record at all. The fuzzy fallback moves behind `--fuzzy`, which returns the
  nearest record and exits `2` — distinct from `1`, so a shell `if` reads it as a
  miss while a caller that cares can still tell a neighbour from an empty result.
  `--json` substitutions carry `fuzzy_match`, `requested_key` and `returned_key`.
- `get` is registered as an alias of `recall`. It previously did not exist and
  exited `1` with `unknown command`, which is indistinguishable from a genuine
  miss to anything reading only the exit status.
- The exact path now asserts that the returned record's key equals the requested
  key before treating it as a hit, so the guarantee holds in the command rather
  than depending on both store backends keeping an exact filter.

The previous behaviour failed **closed** on an invented key (exit `1`) and
**open** on a near miss (exit `0`, different record). Every negative control
built from an invented string therefore passed while the command was
substituting records, which is why this survived so long; the regression suite
added here exercises the near-miss arm specifically.

### Exit codes, stated plainly because callers script against them

| case | before | 0.14.72 |
| --- | --- | --- |
| exact key present | `0` | `0` (unchanged) |
| near-miss key, no `--fuzzy` | `0` + a different record | `1`, no record printed |
| key absent entirely | `1` | `1` (unchanged) |
| near-miss key, with `--fuzzy` | n/a | `2` + the neighbour |

A caller that treats any non-zero as "not found" keeps working. A caller that
relied on a bare `recall <key>` returning a neighbour must now pass `--fuzzy`.

### Also carried by this release

These landed on `main` after 0.14.71 was published and ship here for the first
time; they are unrelated to the `recall` change.

- Stop destroying the global config file when it is unparseable (#27).
- Align with `@hasna/contracts` conformance (moderate) for iapp-mementos (#18).
- Add mementos project-panel contract fixtures.

## 0.14.68 — Harden storage cloud-runtime diagnostics

Adds an explicit, fail-closed cloud-runtime status contract and safe migration
diagnostics for the storage subsystem (rebased onto the reconciled `main`).

- `getStorageStatus()` now publishes a structured `runtime`
  (`mementos-cloud-runtime-v1`) contract describing the local SQLite primary
  runtime, unsupported local file sync, PostgreSQL/RDS remote adapter, and
  unsupported S3/AWS mutation, with fail-closed flags and redacted URLs.
- Remote PostgreSQL/RDS configuration fails closed for missing, invalid, or
  non-Postgres connection strings via `validatePostgresConnectionString`, and
  `redactDatabaseUrl` now redacts credential-bearing URL userinfo **and**
  secret-like query parameters (password/token/secret/api_key/…).
- Adds `mementos storage migrate --dry-run` (CLI + MCP) safe diagnostics via
  `getPgMigrationDiagnostics`: no network, no AWS/production mutation,
  credentials redacted; live apply still validates and requires approval.
- README and regression coverage updated for env precedence, redaction,
  fail-closed behavior, and CLI/MCP parity.

## 0.14.67 — Reconcile `main` with the published npm line

`main` (0.14.52) had diverged from the deployed/published npm line: it was
5 commits ahead and 21 commits behind `npm/mementos/v0.14.66`, so fixes based
on `main` were targeting stale code. This release reconciles the two by merging
the published release tag `npm/mementos/v0.14.66` into `main`, preserving both
histories via a true merge commit, then re-applying the genuine `main`-only
fixes on top of the published (source-of-truth) code.

### Reconciliation

- Merged the published release tag `npm/mementos/v0.14.66` into `main`. All
  runtime conflicts were resolved in favor of the published line (the source of
  truth for deployed behavior): the full cloud/self-hosted api-mode routing
  series, bulk-upsert + FK auto-provision server route, RDS DSN confinement,
  Postgres-safe server fixes (INSTR→STRPOS, int8 parsing,
  COALESCE(accessed_at, updated_at), entity merge/partial-id), URL-decoded route
  params, and cloud-aware doctor/clean.

### Preserved / re-applied `main`-only fixes

- **fix(completions):** derive the subcommand list from the commander registry
  instead of a hand-maintained string (#11).
- **fix(cli):** honor `--json` in
  hooks/synthesis/session/profile/auto-memory/brains/get-focus (#13).
- **fix(stats):** `by_status` buckets partition `total` instead of
  double-counting (#12). The published line had consolidated the three stats
  surfaces into a shared `getMemoryStats()` (`src/db/analytics.ts`) that still
  used `GROUP BY status` without the active filter, so this fix was re-applied
  in that single shared source (`WHERE status = 'active' GROUP BY status`) —
  cleaner than the original three-site patch.

### Dropped (superseded)

- **feat(client): self_hosted cloud-store routing (#8)** and
  **fix(client): fall through when mode=cloud but no API URL+key (#9)** — the
  `src/db/cloud-store.ts` approach was fully superseded by the published line's
  more complete `src/db/api-mode.ts` routing (with dedicated
  api-mode-guard/api-mode-routing/cloud-mode test suites). The orphaned
  `cloud-store.ts` (+ tests), its `resolvePartialId` hook in `database.ts`, the
  `src/mcp/http.ts` changes, and the `@hasna/mcp-harness` `file:` dependency it
  introduced were removed so no api-mode split-brain is re-introduced.
