/**
 * mementos-serve API-key authentication.
 *
 * Uses the Foundation `@hasna/contracts/auth` stateless HMAC-signed verifiable
 * tokens (prefix `hasna_mementos_`). Tokens are verified cryptographically with
 * no per-request DB round-trip for authenticity; a DB-backed {@link ApiKeyStore}
 * layers revocation on top (idempotent `api_keys` table in the same cloud DB).
 *
 * Signing secret resolution (first wins):
 *   API_KEY_SIGNING_SECRET            (injected by the hasna-app Terraform module)
 *   HASNA_MEMENTOS_API_SIGNING_KEY    (per-app convention)
 *   HASNA_API_SIGNING_KEY             (shared fallback)
 *
 * When no signing secret is configured the contracts verifier is disabled and
 * the server falls back to the legacy static `MEMENTOS_API_KEY` bearer check
 * (local/dev). When neither is set, all requests are allowed (local default).
 */
import pg from "pg";
import {
  verifyApiKey,
  ApiKeyStore,
  type ApiKeyVerifier,
  type AuthQueryClient,
} from "@hasna/contracts/auth";
import { getStorageConnectionString, makePool } from "../storage.js";
import { authenticateRequest, json } from "./helpers.js";

const APP = "mementos";

let _verifier: ApiKeyVerifier | null | undefined; // undefined = uninitialized, null = disabled
let _store: ApiKeyStore | null = null;
let _schemaReady: Promise<void> | null = null;

function signingSecret(): string | undefined {
  return (
    process.env["API_KEY_SIGNING_SECRET"]?.trim() ||
    process.env["HASNA_MEMENTOS_API_SIGNING_KEY"]?.trim() ||
    process.env["HASNA_API_SIGNING_KEY"]?.trim() ||
    undefined
  );
}

/** Minimal AuthQueryClient over a pg Pool (revocation store). */
function makeAuthClient(): AuthQueryClient | null {
  let dsn: string;
  try {
    dsn = getStorageConnectionString(APP);
  } catch {
    return null; // no cloud DB configured — verify statelessly (no revocation)
  }
  let pool: pg.Pool;
  try {
    pool = makePool(dsn);
  } catch {
    return null;
  }
  return {
    many: async (sql, params = []) => (await pool.query(sql, params as unknown[])).rows,
    get: async (sql, params = []) => (await pool.query(sql, params as unknown[])).rows[0] ?? null,
    execute: async (sql, params = []) => {
      await pool.query(sql, params as unknown[]);
    },
  };
}

/** Lazily build the contracts verifier. Returns null when auth is disabled. */
export function getApiKeyVerifier(): ApiKeyVerifier | null {
  if (_verifier !== undefined) return _verifier;

  const secret = signingSecret();
  if (!secret) {
    _verifier = null;
    return null;
  }

  const client = makeAuthClient();
  if (client) {
    _store = new ApiKeyStore(client);
    // Idempotently ensure the api_keys table exists; best-effort so a transient
    // DB hiccup never wedges startup. Stateless verification still holds.
    _schemaReady = _store.ensureSchema().catch((e) => {
      console.warn(`[mementos-serve] api_keys ensureSchema failed: ${e instanceof Error ? e.message : e}`);
    });
  }

  _verifier = verifyApiKey({
    app: APP,
    signingSecret: secret,
    isRevoked: _store ? _store.isRevoked : undefined,
    audit: (e) => {
      if (e.outcome === "deny") {
        console.warn(
          `[mementos-serve] auth deny kid=${e.kid ?? "-"} reason=${e.reason} ${e.method ?? ""} ${e.path ?? ""}`
        );
      }
    },
  });
  return _verifier;
}

/**
 * Gate a request. Returns an error `Response` to reject, or `null` to allow.
 * `requiredScopes` (optional) enforces per-mount scope requirements.
 */
export async function checkApiKey(
  req: Request,
  method: string,
  path: string,
  requiredScopes?: readonly string[]
): Promise<Response | null> {
  const verifier = getApiKeyVerifier();
  if (!verifier) {
    // Contracts auth disabled — fall back to the legacy static bearer check.
    return authenticateRequest(req);
  }
  if (_schemaReady) await _schemaReady;
  const decision = await verifier.authenticate(req.headers, { method, path, requiredScopes });
  if (decision.ok) return null;
  return json({ error: decision.message, reason: decision.reason }, decision.status);
}

/** True when contracts API-key auth is active (a signing secret is configured). */
export function apiKeyAuthEnabled(): boolean {
  return getApiKeyVerifier() !== null;
}
