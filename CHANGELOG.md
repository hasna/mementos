# Changelog

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
