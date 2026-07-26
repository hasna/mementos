// ============================================================================
// API-key HTTPS client routing (self-hosted cloud, NO DSN on clients).
//
// Mission constraint (project CLAUDE.md, NON-NEGOTIABLE): fleet clients must
// reach the self-hosted cloud store over HTTPS with a bearer API key —
// `Authorization: Bearer <key>` against `https://<app>.hasna.xyz/v1`. The raw
// RDS DSN is NEVER distributed to client machines. This module is the sanctioned
// client transport: it turns the core memory operations (create/get/list/
// update/delete/search) into authed HTTP calls against the cloud server, which
// runs the exact same domain logic against cloud Postgres.
//
// Activation is fail-safe and reversible:
//   - API mode is ON  when BOTH `HASNA_MEMENTOS_API_URL` and
//     `HASNA_MEMENTOS_API_KEY` are set (aliases `MEMENTOS_API_URL` /
//     `MEMENTOS_API_KEY` accepted) AND no DATABASE_URL is present.
//   - API mode is OFF when either is missing (→ pure local SQLite, unchanged).
//   - If a DATABASE_URL is set, API mode refuses to engage (a DSN on a client
//     is forbidden; the operator must remove it). This keeps the two transports
//     mutually exclusive and never silently mixes them.
//
// Transport: a synchronous HTTP request via `Bun.spawnSync(["curl", …])`. The
// domain functions in this codebase are synchronous, so the client transport
// must be too. curl is spawned DIRECTLY (no `bash -c`), and the bearer key is
// fed to curl on stdin via `-H @-` (curl reads one header line per stdin line).
// The key therefore never appears in argv (`ps`/`/proc/<pid>/cmdline`) nor in
// the child's environment, and is never logged. The request body, when present,
// is written to a private 0600 temp file passed as `--data-binary @<file>` and
// removed immediately after the call, so it never touches argv either.
// ============================================================================

import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface ApiConfig {
  baseUrl: string; // normalized, includes the /v1 (or /api) prefix, no trailing slash
  apiKey: string;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return undefined;
}

function hasDatabaseUrl(): boolean {
  return Boolean(firstEnv("HASNA_MEMENTOS_DATABASE_URL", "MEMENTOS_DATABASE_URL"));
}

/** Normalize a configured base URL to always carry a `/v1` (or `/api`) prefix. */
function normalizeBase(raw: string): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (/\/(v1|api)$/.test(base)) return base;
  return `${base}/v1`;
}

/** Resolve the API client config from env, or `null` when not configured. */
export function getApiConfig(): ApiConfig | null {
  const rawBase = firstEnv("HASNA_MEMENTOS_API_URL", "MEMENTOS_API_URL");
  const apiKey = firstEnv("HASNA_MEMENTOS_API_KEY", "MEMENTOS_API_KEY");
  if (!rawBase || !apiKey) return null;
  return { baseUrl: normalizeBase(rawBase), apiKey };
}

/**
 * True when the client should route memory operations to the cloud API.
 * Fail-closed against a client-side DSN: if DATABASE_URL is present, API mode
 * refuses to engage so the two transports never mix.
 */
export function isApiMode(): boolean {
  if (hasDatabaseUrl()) return false;
  return getApiConfig() !== null;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface RawResponse {
  status: number;
  body: string;
}

const DEFAULT_TIMEOUT_S = "45";

/**
 * Synchronous authed HTTP request to the cloud API. Returns the raw status +
 * body. The bearer key is fed to curl on stdin (`-H @-`) so it never appears in
 * argv or the environment. The body (if any) is written to a private 0600 temp
 * file and passed as `--data-binary @file` so it never appears in argv either.
 */
function apiRequestRaw(method: string, path: string, body?: unknown): RawResponse {
  const cfg = getApiConfig();
  if (!cfg) throw new Error("api-mode: not configured (HASNA_MEMENTOS_API_URL / HASNA_MEMENTOS_API_KEY)");

  const url = `${cfg.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const hasBody = body !== undefined && body !== null;
  const timeout = process.env["HASNA_MEMENTOS_API_TIMEOUT"] || DEFAULT_TIMEOUT_S;

  // Secret headers are read by curl from stdin via `-H @-` (one header per
  // line). The key is NEVER placed on argv or in the process environment, so it
  // cannot leak via `ps` / `/proc/<pid>/cmdline` / `/proc/<pid>/environ`.
  const headerLines = `Authorization: Bearer ${cfg.apiKey}\nx-api-key: ${cfg.apiKey}\n`;

  // Only non-secret values ever reach argv (method, url, timeout, static headers).
  const args = [
    "curl",
    "-sS",
    "--fail-with-body",
    "-m",
    timeout,
    "-X",
    method,
    "-H",
    "@-", // read the auth headers from stdin
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: application/json",
    "-w",
    "\\n%{http_code}",
  ];

  let bodyFile: string | undefined;
  if (hasBody) {
    bodyFile = join(tmpdir(), `mem-req-${process.pid}-${randomUUID()}.json`);
    writeFileSync(bodyFile, JSON.stringify(body), { mode: 0o600 });
    args.push("--data-binary", `@${bodyFile}`);
  }
  args.push(url);

  // Hand curl an environment with the key vars stripped, so the secret is not
  // even present in the child's `/proc/<pid>/environ` (it travels only on stdin).
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "HASNA_MEMENTOS_API_KEY" || k === "MEMENTOS_API_KEY") continue;
    childEnv[k] = v;
  }

  let out = "";
  let err = "";
  try {
    const proc = Bun.spawnSync(args, {
      stdin: Buffer.from(headerLines),
      stdout: "pipe",
      stderr: "pipe",
      env: childEnv,
    });
    out = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    err = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
  } finally {
    if (bodyFile) {
      try {
        unlinkSync(bodyFile);
      } catch {
        // temp file already gone — nothing to clean up
      }
    }
  }

  // curl exit 7/28/etc → transport failure (server unreachable / timeout).
  // With --fail-with-body, a non-2xx still returns exit!=0 but we parse the code.
  const nl = out.lastIndexOf("\n");
  const codeStr = nl >= 0 ? out.slice(nl + 1).trim() : "";
  const respBody = nl >= 0 ? out.slice(0, nl) : out;
  const status = parseInt(codeStr, 10);

  if (!Number.isFinite(status) || status === 0) {
    throw new ApiRequestError(
      `mementos cloud request failed (${method} ${path}): ${err.trim() || "no HTTP status"}`,
      0,
      respBody,
    );
  }
  return { status, body: respBody };
}

export interface ApiJsonOptions {
  /**
   * Treat `404` as a normal outcome and return `{status: 404, data: undefined}`
   * instead of throwing. ONLY for callers where "absent" is a real answer —
   * a GET of one record by id, or a DELETE that tolerates an already-gone row.
   *
   * It must never be set on a create/upsert path. A 404 there means the route
   * did not exist on the server (client/server version skew, wrong base URL),
   * so nothing was written; returning success-shaped data made the CLI print
   * "Saved:" and exit 0 having persisted nothing. Default is fail-closed.
   */
  allow404?: boolean;
}

/**
 * Authed JSON request. Throws {@link ApiRequestError} on every non-2xx,
 * including 404, unless the caller opts into 404 pass-through via
 * {@link ApiJsonOptions.allow404}.
 */
export function apiJson<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: ApiJsonOptions,
): { status: number; data: T } {
  const raw = apiRequestRaw(method, path, body);
  if (raw.status >= 200 && raw.status < 300) {
    const data = raw.body.trim() ? (JSON.parse(raw.body) as T) : (undefined as unknown as T);
    return { status: raw.status, data };
  }
  if (raw.status === 404 && options?.allow404) {
    return { status: 404, data: undefined as unknown as T };
  }
  let msg = `mementos cloud ${method} ${path} → ${raw.status}`;
  try {
    const parsed = JSON.parse(raw.body) as { error?: string; message?: string };
    if (parsed.error || parsed.message) msg += `: ${parsed.error || parsed.message}`;
  } catch {
    if (raw.body.trim()) msg += `: ${raw.body.slice(0, 200)}`;
  }
  throw new ApiRequestError(msg, raw.status, raw.body);
}

/** Build a query string from a filter object (skips undefined/null/empty). */
export function toQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      sp.set(k, v.join(","));
    } else if (typeof v === "boolean") {
      sp.set(k, v ? "true" : "false");
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
