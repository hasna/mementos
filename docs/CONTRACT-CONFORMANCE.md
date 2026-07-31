# Service Contract conformance — current state

Run the gate:

```bash
bun run contract:check      # bun run build && contracts repo-conformance .
```

Against `@hasna/contracts` 0.8.5 this repo passes every check except one, and
that one is recorded here so nobody closes it by writing something untrue into
`hasna.contract.json`.

## The open failure

```
fail surface_bindings: serviceSurfaces[1].generatedFrom is required for a supported service SDK
```

`mementos` is `class: cli-with-store` and ships a `mementos-serve` bin, which
sets the kit's `requiresGeneratedServiceSdk`. That flag makes `generatedFrom`
mandatory on the supported SDK surface, and no surface waiver is eligible for
this class (`waivedSurfaces` is only honoured for `library`, or under the
`non-node-monorepo` waiver profile — neither describes this repo).

`generatedFrom` asserts the client is generated from the API's OpenAPI
document. It is not:

- `src/sdk/index.ts` is a hand-written TypeScript client (`MementosClient`)
  with no code-generation marker, and it is a published public export
  (`@hasna/mementos/sdk`).
- `src/server/openapi.ts` builds the document from the live `routes[]` table.
  That makes it accurate about paths and methods, but it carries no request or
  response schemas for any of the ~102 routes — so nothing typed could be
  generated from it today.
- `@hasna/contracts` ships no SDK generator (`contracts --help`).

So the field is left off deliberately. Declaring it would make the manifest
assert a code-generation pipeline that does not exist.

## What closing it honestly would take

Either of these, in this order of preference:

1. Give the OpenAPI document real request/response schemas per route, add a
   generator that emits the client from it, and regenerate `src/sdk` from that
   generator (with a CI `--check` so the checked-in client cannot drift). This
   changes a published public API surface and is a product decision, not a
   manifest edit.
2. A kit-level change to `@hasna/contracts` that distinguishes "generated from"
   from "verified against" for service SDKs, with a mechanical check that the
   hand-written client covers exactly the routes the document declares.

## What is already satisfied, and how

- **Storage.** `storage.engines` declares `sqlite` and `postgres` because both
  are real: `PgAdapterAsync` in `src/storage.ts`, the migration set in
  `src/db/pg-migrations.ts`, and the vendored pool/query/TLS kit under
  `src/generated/storage-kit/`. A postgres *waiver* is not available to this
  repo anyway — the kit refuses one for a `cli-with-store` shipping
  `<name>-serve`.
- **The live-PG proof gate.** `storage.pgTestGate` names
  `MEMENTOS_TEST_DATABASE_URL` and `bun run test:pg`
  (`scripts/pg-test-gate.ts`): applies the PG schema, then writes, reads back
  and deletes a row through the real adapter. It exits non-zero when the DSN is
  unset rather than skipping, so it cannot report success without having run.
  The variable is test-only and distinct from `HASNA_MEMENTOS_DATABASE_URL`.
- **The published-artifact gate.** `metadata.release.artifactScan.script` names
  `scan-artifact`, `prepack` reaches it, and `scripts/scan-artifact.ts` packs
  the tarball (`--ignore-scripts`, so packing from inside `prepack` does not
  re-enter it) and scans **the archive**, never `src/`. The scanner is the
  pinned `node_modules/.bin/contracts` binary rather than `bunx`, because an
  unpinned runner resolves to whatever is newest at publish time and a
  resolution failure becomes a silent non-run.
