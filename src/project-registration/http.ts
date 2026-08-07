import {
  MementosProjectRegistrationError,
  type MementosProjectRegistrationAuthority,
  type MementosProjectRegistrationCapability,
  type MementosProjectRegistrationHttpClientOptions,
  type MementosProjectRegistrationInverseVerification,
  type MementosProjectRegistrationLookupRequest,
  type MementosProjectRegistrationLookupResult,
  type MementosProjectRegistrationPathHandle,
  type MementosProjectRegistrationReceipt,
  type MementosProjectRegistrationRecord,
  type MementosProjectRegistrationRequest,
  type MementosProjectRegistrationWireRequest,
} from "./types.js";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

class WirePathHandle implements MementosProjectRegistrationPathHandle {
  constructor(private readonly absolutePath: string) {}

  withOwnedPath<T>(consumer: (absolutePath: string) => T): T {
    return consumer(this.absolutePath);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorStatus(error: MementosProjectRegistrationError): number {
  switch (error.code) {
    case "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT":
    case "MEMENTOS_PROJECT_REGISTRATION_INVALID_BOUNDS":
    case "MEMENTOS_PROJECT_REGISTRATION_CAPABILITY_MISMATCH":
    case "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH":
    case "MEMENTOS_PROJECT_REGISTRATION_IDEMPOTENCY_MISMATCH":
    case "MEMENTOS_PROJECT_REGISTRATION_EXACT_ID_REQUIRED":
      return 400;
    case "MEMENTOS_PROJECT_REGISTRATION_RECEIPT_NOT_FOUND":
    case "MEMENTOS_PROJECT_REGISTRATION_RECORD_NOT_FOUND":
    case "MEMENTOS_PROJECT_REGISTRATION_ACCEPTED_RECEIPT_NOT_FOUND":
      return 404;
    case "MEMENTOS_PROJECT_REGISTRATION_RESPONSE_TOO_LARGE":
      return 413;
    case "MEMENTOS_PROJECT_REGISTRATION_TIME_BUDGET_EXCEEDED":
      return 408;
    case "MEMENTOS_PROJECT_REGISTRATION_ATOMICITY_UNAVAILABLE":
      return 503;
    default:
      return 409;
  }
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function fromWireRequest(body: Record<string, unknown>): MementosProjectRegistrationRequest {
  const { canonical_path: canonicalPath, ...request } = body;
  if (typeof canonicalPath !== "string") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "canonical_path is required on the private registration transport",
    );
  }
  return {
    ...request,
    target: new WirePathHandle(canonicalPath),
  } as unknown as MementosProjectRegistrationRequest;
}

function fromWireReadRequest(body: Record<string, unknown>): {
  resource_kind: "project";
  target_id: string;
  target: MementosProjectRegistrationPathHandle;
  response_byte_limit: number;
  time_budget_ms: number;
} {
  const { canonical_path: canonicalPath, ...request } = body;
  if (typeof canonicalPath !== "string") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "canonical_path is required on the private exact-read transport",
    );
  }
  return {
    ...request,
    target: new WirePathHandle(canonicalPath),
  } as unknown as {
    resource_kind: "project";
    target_id: string;
    target: MementosProjectRegistrationPathHandle;
    response_byte_limit: number;
    time_budget_ms: number;
  };
}

/**
 * Handle one package-owned registration request. The canonical path is private
 * request material and is converted back to a structural handle before the
 * authority sees it; no capability or result serializes it.
 */
export async function handleMementosProjectRegistrationHttpRequest(
  request: Request,
  url: URL,
  authority: MementosProjectRegistrationAuthority,
  basePath: "/v1/project-registration" | "/api/project-registration" =
    "/v1/project-registration",
): Promise<Response | null> {
  const path = url.pathname;
  if (path !== basePath && !path.startsWith(`${basePath}/`)) return null;
  const action = path.slice(basePath.length).split("/").filter(Boolean).join("/");
  const method = request.method.toUpperCase();

  try {
    if ((action === "" || action === "capability") && method === "GET") {
      return json({ capability: await authority.capability() });
    }
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    const body = await readJson(request);
    if (!body) {
      return json({
        error: "invalid JSON body",
        code: "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      }, 400);
    }
    if (action === "create") {
      return json({ receipt: await authority.create(fromWireRequest(body)) }, 201);
    }
    if (action === "receipts/lookup") {
      return json(await authority.lookupReceipt(
        body as unknown as MementosProjectRegistrationLookupRequest,
      ));
    }
    if (action === "read-exact") {
      return json({ record: await authority.readExact(fromWireReadRequest(body)) });
    }
    if (action === "compensate") {
      return json({ receipt: await authority.compensate(fromWireRequest(body)) }, 201);
    }
    if (action === "verify-inverse") {
      return json({ verification: await authority.verifyInverse(fromWireRequest(body)) });
    }
    return json({
      error: "unknown Mementos project-registration route",
      code: "MEMENTOS_PROJECT_REGISTRATION_RECEIPT_NOT_FOUND",
    }, 404);
  } catch (cause) {
    if (cause instanceof MementosProjectRegistrationError) {
      return json({
        error: cause.message,
        code: cause.code,
        details: cause.details,
        authoritative: true,
      }, errorStatus(cause));
    }
    return json({
      error: cause instanceof Error ? cause.message : "internal registration error",
      code: "MEMENTOS_PROJECT_REGISTRATION_ATOMICITY_UNAVAILABLE",
    }, 500);
  }
}

function extractPath(target: MementosProjectRegistrationPathHandle): string {
  if (!target || typeof target.withOwnedPath !== "function") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "target must be a package-owned path handle",
    );
  }
  return target.withOwnedPath((absolutePath) => absolutePath);
}

function toWireRequest(
  request: MementosProjectRegistrationRequest,
): MementosProjectRegistrationWireRequest {
  const { target, ...serializable } = request;
  return {
    ...serializable,
    canonical_path: extractPath(target),
  };
}

export class MementosProjectRegistrationHttpClient
implements MementosProjectRegistrationAuthority {
  readonly authority = "mementos" as const;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(options: MementosProjectRegistrationHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.headers = {
      ...options.headers,
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      "Content-Type": "application/json",
    };
  }

  private async request<T>(action: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/project-registration${action}`,
      {
        ...init,
        headers: { ...this.headers, ...(init.headers ?? {}) },
      },
    );
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_ATOMICITY_UNAVAILABLE",
        `Mementos project registration HTTP ${response.status} returned non-JSON`,
      );
    }
    if (!response.ok) {
      throw new MementosProjectRegistrationError(
        typeof body["code"] === "string"
          ? body["code"] as MementosProjectRegistrationError["code"]
          : "MEMENTOS_PROJECT_REGISTRATION_ATOMICITY_UNAVAILABLE",
        typeof body["error"] === "string"
          ? body["error"]
          : `Mementos project registration HTTP ${response.status}`,
        body["details"] && typeof body["details"] === "object"
          ? body["details"] as Record<string, unknown>
          : {},
      );
    }
    return body as T;
  }

  async capability(): Promise<MementosProjectRegistrationCapability> {
    const body = await this.request<{
      capability: MementosProjectRegistrationCapability;
    }>("/capability");
    return body.capability;
  }

  async create(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationReceipt> {
    const body = await this.request<{ receipt: MementosProjectRegistrationReceipt }>(
      "/create",
      { method: "POST", body: JSON.stringify(toWireRequest(request)) },
    );
    return body.receipt;
  }

  async readExact(request: {
    resource_kind: "project";
    target_id: string;
    target: MementosProjectRegistrationPathHandle;
    response_byte_limit: number;
    time_budget_ms: number;
  }): Promise<MementosProjectRegistrationRecord> {
    const { target, ...serializable } = request;
    const body = await this.request<{ record: MementosProjectRegistrationRecord }>(
      "/read-exact",
      {
        method: "POST",
        body: JSON.stringify({ ...serializable, canonical_path: extractPath(target) }),
      },
    );
    return body.record;
  }

  async lookupReceipt(
    request: MementosProjectRegistrationLookupRequest,
  ): Promise<MementosProjectRegistrationLookupResult> {
    return this.request<MementosProjectRegistrationLookupResult>(
      "/receipts/lookup",
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  async compensate(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationReceipt> {
    const body = await this.request<{ receipt: MementosProjectRegistrationReceipt }>(
      "/compensate",
      { method: "POST", body: JSON.stringify(toWireRequest(request)) },
    );
    return body.receipt;
  }

  async verifyInverse(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationInverseVerification> {
    const body = await this.request<{
      verification: MementosProjectRegistrationInverseVerification;
    }>("/verify-inverse", {
      method: "POST",
      body: JSON.stringify(toWireRequest(request)),
    });
    return body.verification;
  }
}

export function createMementosProjectRegistrationHttpClient(
  options: MementosProjectRegistrationHttpClientOptions,
): MementosProjectRegistrationAuthority {
  return new MementosProjectRegistrationHttpClient(options);
}
