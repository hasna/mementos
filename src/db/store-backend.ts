// ============================================================================
// Resolved-store reporting — "which store am I about to hit?"
//
// mementos has TWO independent notions of "mode" that can disagree, which is
// how a process ends up writing somewhere nobody intended:
//
//   - `getStorageMode()` (src/storage.ts) — local | cloud, from the storage
//     config file plus HASNA_MEMENTOS_STORAGE_MODE. Governs the DIRECT Postgres
//     path, which is server-only.
//   - `isApiMode()` (src/db/api-mode.ts) — the HTTPS client transport, selected
//     by the mere PRESENCE of an API URL + key. Governs every client read/write.
//
// On a client, `isApiMode()` wins: the memory paths route to HTTP before
// `getDatabase()` is ever consulted, so `getStorageMode()` can cheerfully report
// `local` while every write goes to the shared cloud store. Reading either value
// alone is therefore misleading — this module composes the single answer.
//
// It resolves from the environment ONLY: no SQLite file is opened, no HTTP
// request is made, no credential value is read into the report. That makes it
// safe to call from an operator's shell, from a health check, and (critically)
// from a test harness that needs to prove it is isolated BEFORE it writes
// anything. See src/test-support/store-isolation.ts.
// ============================================================================

import { getDbPath } from "./database.js";
import { getApiConfig, getApiModeEnvSources, isApiMode } from "./api-mode.js";
import { MEMENTOS_STORAGE_ENV, MEMENTOS_STORAGE_FALLBACK_ENV, getStorageMode } from "../storage.js";

/**
 * The transport that reads and writes will actually use.
 *
 * - `local-sqlite`   — the on-disk SQLite file at `db_path` is authoritative.
 * - `cloud-api`      — authed HTTPS to the self-hosted server (the shared store).
 * - `cloud-postgres` — a direct Postgres DSN; server-only, never a client.
 */
export type StoreBackend = "local-sqlite" | "cloud-api" | "cloud-postgres";

export interface StoreBackendReport {
  /** Machine-readable contract for scripts and test guards. */
  schema: "mementos.store_backend.v1";
  backend: StoreBackend;
  /** True when the HTTPS client transport is engaged (client reads AND writes). */
  api_mode: boolean;
  /** The `getStorageMode()` value — reported for diagnosis, NOT the answer. */
  storage_mode: string;
  /** The SQLite path that WOULD be used. Meaningful only for `local-sqlite`. */
  db_path: string;
  /** Cloud endpoint origin + prefix. Not a secret; the key is never included. */
  api_endpoint: string | null;
  /** Whether an API key is configured. The value is never read or reported. */
  api_key_present: boolean;
  /** Env key NAMES that produced this backend, or `"default"`. Names only. */
  selected_by: string;
}

/**
 * Resolve the effective store backend from the environment.
 *
 * Pure with respect to storage: touches no database, makes no network call, and
 * never places a credential value in the returned report.
 */
export function resolveStoreBackend(): StoreBackendReport {
  const apiMode = isApiMode();
  const apiConfig = getApiConfig();
  const storageMode = getStorageMode();
  const sources = getApiModeEnvSources();

  const backend: StoreBackend = apiMode
    ? "cloud-api"
    : storageMode === "cloud"
      ? "cloud-postgres"
      : "local-sqlite";

  let selectedBy = "default";
  if (apiMode) {
    // Presence of BOTH keys is the selector, so name both.
    selectedBy = `${sources.urlKey} + ${sources.keyKey} (presence)`;
  } else if (backend === "cloud-postgres") {
    // An explicit mode env var, else the DSN auto-promoting, else the config file.
    const modeKey = [MEMENTOS_STORAGE_ENV.mode, MEMENTOS_STORAGE_FALLBACK_ENV.mode].find((key) =>
      process.env[key]?.trim(),
    );
    selectedBy = modeKey ?? sources.databaseUrlKey ?? "storage config file";
  }

  return {
    schema: "mementos.store_backend.v1",
    backend,
    api_mode: apiMode,
    storage_mode: storageMode,
    db_path: getDbPath(),
    api_endpoint: apiConfig?.baseUrl ?? null,
    api_key_present: Boolean(apiConfig?.apiKey),
    selected_by: selectedBy,
  };
}
