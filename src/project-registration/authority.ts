import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { DbAdapter } from "../storage.js";
import { getMementosPackageVersion } from "../lib/package-version.js";
import type { Project } from "../types/index.js";
import {
  MEMENTOS_PROJECT_REGISTRATION_CALLER_ROUTE,
  MEMENTOS_PROJECT_REGISTRATION_ROUTE,
  MementosProjectRegistrationError,
  type MementosProjectRegistrationAuthority,
  type MementosProjectRegistrationAuthorityOptions,
  type MementosProjectRegistrationBounds,
  type MementosProjectRegistrationCapability,
  type MementosProjectRegistrationDirection,
  type MementosProjectRegistrationFaultPoint,
  type MementosProjectRegistrationInverseVerification,
  type MementosProjectRegistrationLookupRequest,
  type MementosProjectRegistrationLookupResult,
  type MementosProjectRegistrationPathHandle,
  type MementosProjectRegistrationReceipt,
  type MementosProjectRegistrationRecord,
  type MementosProjectRegistrationRequest,
} from "./types.js";

const WORKSPACE_ID_PATTERN = /^wks_[A-Za-z0-9][A-Za-z0-9_-]{11,}$/;
const OPERATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const STEP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_PATTERN = /^prk_[0-9a-f]{48}$/;
const PROJECT_ID_PATTERN = /^mm_project_[0-9a-f]{40}$/;

interface StoredReceipt extends MementosProjectRegistrationReceipt {
  target_selector: string;
  normalized_call_digest: string;
}

interface BindingRow {
  authority_id: string;
  tenant_id: string;
  corpus_id: string;
  resource_kind: "project";
  target_selector: string;
  operation_id: string;
  step_id: string;
  direction: "forward";
  idempotency_key: string;
  request_digest: string;
  precondition_digest: string;
  normalized_call_digest: string;
  state: "pending" | "accepted" | "terminal_nonacceptance" | "removed";
  target_id: string | null;
  accepted_receipt_id: string | null;
  result_revision: string | null;
  result_digest: string | null;
  removed_receipt_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectReferenceCounts {
  memories: number;
  sessions: number;
  entities: number;
  agents: number;
  tool_events: number;
  tasks: number;
  consolidation_runs: number;
  reflection_runs: number;
}

class WriteBoundaryError extends Error {
  constructor(
    readonly point: Exclude<MementosProjectRegistrationFaultPoint, "after_commit">,
    readonly cause: unknown,
  ) {
    super(`Mementos project registration failed at ${point}`);
  }
}

export function canonicalMementosProjectRegistrationJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

export function digestMementosProjectRegistrationValue(value: unknown): string {
  return createHash("sha256")
    .update(canonicalMementosProjectRegistrationJson(value))
    .digest("hex");
}

function digestOwnedPath(path: string): string {
  return createHash("sha256").update(path).digest("hex");
}

export function deriveMementosProjectRegistrationIdempotencyKey(input: {
  operation_id: string;
  step_id: string;
  direction: MementosProjectRegistrationDirection;
  target_selector: string;
  request_digest: string;
  precondition_digest: string;
}): string {
  return `prk_${digestMementosProjectRegistrationValue({
    route: MEMENTOS_PROJECT_REGISTRATION_CALLER_ROUTE,
    operation_id: input.operation_id,
    step_id: input.step_id,
    direction: input.direction,
    target_selector: input.target_selector,
    request_digest: input.request_digest,
    precondition_digest: input.precondition_digest,
  }).slice(0, 48)}`;
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assertBounds(bounds: MementosProjectRegistrationBounds): void {
  if (!Number.isSafeInteger(bounds.response_byte_limit) || bounds.response_byte_limit <= 0) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_BOUNDS",
      "response_byte_limit must be a positive integer",
    );
  }
  if (!Number.isSafeInteger(bounds.time_budget_ms) || bounds.time_budget_ms <= 0) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_BOUNDS",
      "time_budget_ms must be a positive integer",
    );
  }
}

function assertWithinBounds(
  value: unknown,
  bounds: MementosProjectRegistrationBounds,
  startedAt: number,
): { response_bytes: number; elapsed_ms: number } {
  const bytes = responseBytes(value);
  if (bytes > bounds.response_byte_limit) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_RESPONSE_TOO_LARGE",
      `registration response requires ${bytes} bytes but the bound is ${bounds.response_byte_limit}`,
      { response_bytes: bytes, response_byte_limit: bounds.response_byte_limit },
    );
  }
  const elapsed = Date.now() - startedAt;
  if (elapsed > bounds.time_budget_ms) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_TIME_BUDGET_EXCEEDED",
      `registration call took ${elapsed}ms but the bound is ${bounds.time_budget_ms}ms`,
      { elapsed_ms: elapsed, time_budget_ms: bounds.time_budget_ms },
    );
  }
  return { response_bytes: bytes, elapsed_ms: elapsed };
}

function withResponseControl(
  receipt: MementosProjectRegistrationReceipt,
  bounds: MementosProjectRegistrationBounds,
  startedAt: number,
): MementosProjectRegistrationLookupResult {
  const result: MementosProjectRegistrationLookupResult = {
    receipt,
    response_control: {
      response_byte_limit: bounds.response_byte_limit,
      time_budget_ms: bounds.time_budget_ms,
      response_bytes: 0,
      elapsed_ms: 0,
      complete: true,
      truncated: false,
    },
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const measured = assertWithinBounds(result, bounds, startedAt);
    const stable = result.response_control.response_bytes === measured.response_bytes
      && result.response_control.elapsed_ms === measured.elapsed_ms;
    result.response_control.response_bytes = measured.response_bytes;
    result.response_control.elapsed_ms = measured.elapsed_ms;
    if (stable) break;
  }
  const measured = assertWithinBounds(result, bounds, startedAt);
  result.response_control.response_bytes = measured.response_bytes;
  result.response_control.elapsed_ms = measured.elapsed_ms;
  return result;
}

function requireString(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; pattern?: RegExp } = {},
): string {
  const min = options.min ?? 1;
  const max = options.max ?? 512;
  if (
    typeof value !== "string"
    || value.length < min
    || value.length > max
    || /[\u0000-\u001f]/.test(value)
    || (options.pattern && !options.pattern.test(value))
  ) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      `${field} is not a valid bounded registration identifier`,
    );
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      `${field} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function ownedPath(target: MementosProjectRegistrationPathHandle): string {
  if (!target || typeof target.withOwnedPath !== "function") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "target must be a package-owned path handle",
    );
  }
  const path = target.withOwnedPath((value) => value);
  requireString(path, "target path", { max: 4096 });
  if (path !== resolve(path)) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "target path must already be canonical and absolute",
    );
  }
  return path;
}

function normalizedCallDigest(request: MementosProjectRegistrationRequest): string {
  return digestMementosProjectRegistrationValue({
    authority_route: request.authority_route,
    package_version: request.package_version,
    authority_id: request.authority_id,
    tenant_id: request.tenant_id,
    corpus_id: request.corpus_id,
    operation_id: request.operation_id,
    step_id: request.step_id,
    resource_kind: request.resource_kind,
    direction: request.direction,
    target_selector: request.target_selector,
    idempotency_key: request.idempotency_key,
    request_digest: request.request_digest,
    precondition_digest: request.precondition_digest,
    project_id: request.project_id,
    project_slug: request.project_slug,
    project_name: request.project_name,
    desired: request.desired,
    accepted_receipt_id: request.accepted_receipt?.receipt_id ?? null,
  });
}

function publicReceipt(row: StoredReceipt): MementosProjectRegistrationReceipt {
  const { target_selector: _selector, normalized_call_digest: _digest, ...receipt } = row;
  return receipt;
}

function timestampString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function receiptFromRow(row: Record<string, unknown>): StoredReceipt {
  return {
    ...row,
    authority: "mementos",
    resource_kind: "project",
    created_by_operation:
      row["created_by_operation"] === true || Number(row["created_by_operation"]) === 1,
    created_at: timestampString(row["created_at"]),
  } as unknown as StoredReceipt;
}

function bindingFromRow(row: Record<string, unknown>): BindingRow {
  return {
    ...row,
    created_at: timestampString(row["created_at"]),
    updated_at: timestampString(row["updated_at"]),
  } as unknown as BindingRow;
}

function getStoredReceipt(db: DbAdapter, receiptId: string): StoredReceipt | null {
  const row = db.get(
    "SELECT * FROM mementos_project_registration_receipts WHERE receipt_id = ? LIMIT 1",
    receiptId,
  ) as Record<string, unknown> | null;
  return row ? receiptFromRow(row) : null;
}

function getAcceptedReceipt(
  db: DbAdapter,
  request: MementosProjectRegistrationRequest,
): StoredReceipt | null {
  const row = db.get(`
    SELECT * FROM mementos_project_registration_receipts
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND operation_id = ? AND step_id = ? AND resource_kind = 'project'
      AND direction = ? AND outcome = 'accepted'
    ORDER BY created_at ASC, receipt_id ASC
    LIMIT 1
  `,
  request.authority_id,
  request.tenant_id,
  request.corpus_id,
  request.operation_id,
  request.step_id,
  request.direction,
  ) as Record<string, unknown> | null;
  return row ? receiptFromRow(row) : null;
}

function getReceiptForLookup(
  db: DbAdapter,
  request: MementosProjectRegistrationLookupRequest,
): StoredReceipt | null {
  const row = db.get(`
    SELECT * FROM mementos_project_registration_receipts
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND operation_id = ? AND step_id = ? AND resource_kind = 'project'
      AND direction = ? AND idempotency_key = ? AND target_selector = ?
    ORDER BY CASE outcome
      WHEN 'terminal_nonacceptance' THEN 0
      WHEN 'duplicate_of_accepted' THEN 1
      ELSE 2
    END, created_at DESC, receipt_id DESC
    LIMIT 1
  `,
  request.authority_id,
  request.tenant_id,
  request.corpus_id,
  request.operation_id,
  request.step_id,
  request.direction,
  request.idempotency_key,
  request.target_selector,
  ) as Record<string, unknown> | null;
  return row ? receiptFromRow(row) : null;
}

function getBinding(
  db: DbAdapter,
  capability: MementosProjectRegistrationCapability,
  targetSelector: string,
): BindingRow | null {
  const row = db.get(`
    SELECT * FROM mementos_project_registration_bindings
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND resource_kind = 'project' AND target_selector = ?
    LIMIT 1
  `,
  capability.authority_id,
  capability.tenant_id,
  capability.corpus_id,
  targetSelector,
  ) as Record<string, unknown> | null;
  return row ? bindingFromRow(row) : null;
}

function getProjectByExactId(db: DbAdapter, id: string): Project | null {
  const row = db.get("SELECT * FROM projects WHERE id = ? LIMIT 1", id) as
    | Record<string, unknown>
    | null;
  if (!row) return null;
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    path: String(row["path"]),
    description: row["description"] === null ? null : String(row["description"]),
    memory_prefix: row["memory_prefix"] === null ? null : String(row["memory_prefix"]),
    created_at: timestampString(row["created_at"]),
    updated_at: timestampString(row["updated_at"]),
  };
}

function getProjectByPath(db: DbAdapter, path: string): Project | null {
  const row = db.get("SELECT * FROM projects WHERE path = ? LIMIT 1", path) as
    | Record<string, unknown>
    | null;
  return row ? getProjectByExactId(db, String(row["id"])) : null;
}

function projectReferenceCounts(db: DbAdapter, id: string): ProjectReferenceCounts {
  const row = db.get(`
    SELECT
      (SELECT COUNT(*) FROM memories WHERE project_id = ?) AS memories,
      (SELECT COUNT(*) FROM sessions WHERE project_id = ?) AS sessions,
      (SELECT COUNT(*) FROM entities WHERE project_id = ?) AS entities,
      (SELECT COUNT(*) FROM agents WHERE active_project_id = ?) AS agents,
      (SELECT COUNT(*) FROM tool_events WHERE project_id = ?) AS tool_events,
      (SELECT COUNT(*) FROM tasks WHERE project_id = ?) AS tasks,
      (SELECT COUNT(*) FROM memory_consolidation_runs WHERE project_id = ?) AS consolidation_runs,
      (SELECT COUNT(*) FROM memory_reflection_runs WHERE project_id = ?) AS reflection_runs
  `, id, id, id, id, id, id, id, id) as Record<string, unknown>;
  return {
    memories: Number(row["memories"]),
    sessions: Number(row["sessions"]),
    entities: Number(row["entities"]),
    agents: Number(row["agents"]),
    tool_events: Number(row["tool_events"]),
    tasks: Number(row["tasks"]),
    consolidation_runs: Number(row["consolidation_runs"]),
    reflection_runs: Number(row["reflection_runs"]),
  };
}

function projectRecord(db: DbAdapter, project: Project): MementosProjectRegistrationRecord {
  return {
    target_id: project.id,
    revision: project.updated_at,
    digest: digestMementosProjectRegistrationValue({
      id: project.id,
      name: project.name,
      path: project.path,
      description: project.description,
      memory_prefix: project.memory_prefix,
      created_at: project.created_at,
      updated_at: project.updated_at,
      references: projectReferenceCounts(db, project.id),
    }),
  };
}

function targetId(capability: MementosProjectRegistrationCapability, selector: string): string {
  return `mm_project_${digestMementosProjectRegistrationValue({
    authority_id: capability.authority_id,
    tenant_id: capability.tenant_id,
    corpus_id: capability.corpus_id,
    selector,
  }).slice(0, 40)}`;
}

function receiptId(input: Omit<StoredReceipt, "receipt_id" | "created_at">): string {
  return `mmpr_${digestMementosProjectRegistrationValue(input).slice(0, 40)}`;
}

function makeReceipt(
  request: MementosProjectRegistrationRequest,
  capability: MementosProjectRegistrationCapability,
  callDigest: string,
  now: string,
  values: {
    outcome: MementosProjectRegistrationReceipt["outcome"];
    reason?: string | null;
    target_id?: string | null;
    result_revision?: string | null;
    result_digest?: string | null;
    duplicate_of_receipt_id?: string | null;
    accepted_receipt_id?: string | null;
    created_by_operation?: boolean;
    target_selector?: string;
  },
): StoredReceipt {
  const withoutId = {
    authority: "mementos" as const,
    route: MEMENTOS_PROJECT_REGISTRATION_ROUTE,
    package_version: capability.package_version,
    authority_id: capability.authority_id,
    tenant_id: capability.tenant_id,
    corpus_id: capability.corpus_id,
    operation_id: request.operation_id,
    step_id: request.step_id,
    resource_kind: "project" as const,
    direction: request.direction,
    target_selector: values.target_selector ?? request.target_selector,
    idempotency_key: request.idempotency_key,
    request_digest: request.request_digest,
    precondition_digest: request.precondition_digest,
    normalized_call_digest: callDigest,
    outcome: values.outcome,
    reason: values.reason ?? null,
    target_id: values.target_id ?? null,
    result_revision: values.result_revision ?? null,
    result_digest: values.result_digest ?? null,
    duplicate_of_receipt_id: values.duplicate_of_receipt_id ?? null,
    accepted_receipt_id: values.accepted_receipt_id ?? null,
    created_by_operation: values.created_by_operation ?? false,
  };
  return {
    receipt_id: receiptId(withoutId),
    ...withoutId,
    created_at: now,
  };
}

function insertReceipt(db: DbAdapter, receipt: StoredReceipt): StoredReceipt {
  db.run(`
    INSERT INTO mementos_project_registration_receipts (
      receipt_id, authority, route, package_version, authority_id, tenant_id,
      corpus_id, operation_id, step_id, resource_kind, direction,
      target_selector, idempotency_key, request_digest, precondition_digest,
      normalized_call_digest, outcome, reason, target_id, result_revision,
      result_digest, duplicate_of_receipt_id, accepted_receipt_id,
      created_by_operation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `,
  receipt.receipt_id,
  receipt.authority,
  receipt.route,
  receipt.package_version,
  receipt.authority_id,
  receipt.tenant_id,
  receipt.corpus_id,
  receipt.operation_id,
  receipt.step_id,
  receipt.resource_kind,
  receipt.direction,
  receipt.target_selector,
  receipt.idempotency_key,
  receipt.request_digest,
  receipt.precondition_digest,
  receipt.normalized_call_digest,
  receipt.outcome,
  receipt.reason,
  receipt.target_id,
  receipt.result_revision,
  receipt.result_digest,
  receipt.duplicate_of_receipt_id,
  receipt.accepted_receipt_id,
  receipt.created_by_operation,
  receipt.created_at,
  );
  const stored = getStoredReceipt(db, receipt.receipt_id);
  const withoutCreatedAt = (value: StoredReceipt): Omit<StoredReceipt, "created_at"> => {
    const { created_at: _createdAt, ...logical } = value;
    return logical;
  };
  if (!stored || canonicalMementosProjectRegistrationJson(withoutCreatedAt(stored))
    !== canonicalMementosProjectRegistrationJson(withoutCreatedAt(receipt))) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
      "immutable receipt id resolved to different content",
    );
  }
  return stored;
}

function insertBinding(
  db: DbAdapter,
  request: MementosProjectRegistrationRequest,
  callDigest: string,
  now: string,
): boolean {
  const result = db.run(`
    INSERT INTO mementos_project_registration_bindings (
      authority_id, tenant_id, corpus_id, resource_kind, target_selector,
      operation_id, step_id, direction, idempotency_key, request_digest,
      precondition_digest, normalized_call_digest, state, target_id,
      accepted_receipt_id, result_revision, result_digest, removed_receipt_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'project', ?, ?, ?, 'forward', ?, ?, ?, ?, 'pending',
      NULL, NULL, NULL, NULL, NULL, ?, ?)
    ON CONFLICT DO NOTHING
  `,
  request.authority_id,
  request.tenant_id,
  request.corpus_id,
  request.target_selector,
  request.operation_id,
  request.step_id,
  request.idempotency_key,
  request.request_digest,
  request.precondition_digest,
  callDigest,
  now,
  now,
  );
  return result.changes === 1;
}

/**
 * Take a portable write lock on the selector binding. PostgreSQL waits for a
 * concurrent create/inverse transaction before returning from this no-op
 * update; SQLite serializes the same write inside its transaction.
 */
function lockBinding(
  db: DbAdapter,
  capability: MementosProjectRegistrationCapability,
  targetSelector: string,
): boolean {
  const result = db.run(`
    UPDATE mementos_project_registration_bindings
    SET updated_at = updated_at
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND resource_kind = 'project' AND target_selector = ?
  `,
  capability.authority_id,
  capability.tenant_id,
  capability.corpus_id,
  targetSelector,
  );
  return result.changes === 1;
}

function setBindingAccepted(
  db: DbAdapter,
  request: MementosProjectRegistrationRequest,
  receipt: StoredReceipt,
  now: string,
): void {
  const result = db.run(`
    UPDATE mementos_project_registration_bindings
    SET state = 'accepted', target_id = ?, accepted_receipt_id = ?,
      result_revision = ?, result_digest = ?, updated_at = ?
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND resource_kind = 'project' AND target_selector = ? AND state = 'pending'
  `,
  receipt.target_id,
  receipt.receipt_id,
  receipt.result_revision,
  receipt.result_digest,
  now,
  request.authority_id,
  request.tenant_id,
  request.corpus_id,
  request.target_selector,
  );
  if (result.changes !== 1) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
      "registration binding was not pending at acceptance",
    );
  }
}

function setBindingRemoved(
  db: DbAdapter,
  accepted: StoredReceipt,
  inverseReceiptId: string,
  now: string,
): void {
  const result = db.run(`
    UPDATE mementos_project_registration_bindings
    SET state = 'removed', removed_receipt_id = ?, updated_at = ?
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND resource_kind = 'project' AND target_selector = ?
      AND state = 'accepted' AND accepted_receipt_id = ?
  `,
  inverseReceiptId,
  now,
  accepted.authority_id,
  accepted.tenant_id,
  accepted.corpus_id,
  accepted.target_selector,
  accepted.receipt_id,
  );
  if (result.changes !== 1) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
      "registration binding was not accepted at inverse",
    );
  }
}

function capabilityMatches(
  request: Pick<MementosProjectRegistrationRequest,
    "authority_route" | "package_version" | "authority_id" | "tenant_id" | "corpus_id">,
  capability: MementosProjectRegistrationCapability,
): boolean {
  return request.authority_route === capability.route
    && request.package_version === capability.package_version
    && request.authority_id === capability.authority_id
    && request.tenant_id === capability.tenant_id
    && request.corpus_id === capability.corpus_id;
}

function assertCommonRequest(
  request: MementosProjectRegistrationRequest,
  capability: MementosProjectRegistrationCapability,
): void {
  assertBounds(request);
  if (request.resource_kind !== "project") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "resource_kind must be project",
    );
  }
  if (request.direction !== "forward" && request.direction !== "inverse") {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "direction must be forward or inverse",
    );
  }
  if (!capabilityMatches(request, capability)) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_CAPABILITY_MISMATCH",
      "registration request does not match this authority capability identity",
    );
  }
  requireString(request.operation_id, "operation_id", {
    min: 8,
    max: 128,
    pattern: OPERATION_PATTERN,
  });
  requireString(request.step_id, "step_id", { min: 3, max: 128, pattern: STEP_PATTERN });
  requireString(request.target_selector, "target_selector", { max: 512 });
  requireString(request.project_id, "project_id", {
    min: 16,
    max: 128,
    pattern: WORKSPACE_ID_PATTERN,
  });
  requireString(request.project_name, "project_name", { max: 256 });
  requireString(request.project_slug, "project_slug", { max: 128 });
  requireString(request.request_digest, "request_digest", {
    min: 64,
    max: 64,
    pattern: SHA256_PATTERN,
  });
  requireString(request.precondition_digest, "precondition_digest", {
    min: 64,
    max: 64,
    pattern: SHA256_PATTERN,
  });
  requireString(request.idempotency_key, "idempotency_key", {
    min: 52,
    max: 52,
    pattern: IDEMPOTENCY_PATTERN,
  });
  if (!request.desired || typeof request.desired !== "object" || Array.isArray(request.desired)) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "desired must be a JSON object",
    );
  }
  if (digestMementosProjectRegistrationValue(request.desired) !== request.request_digest) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH",
      "request_digest does not match the canonical desired payload",
    );
  }
  const expectedKey = deriveMementosProjectRegistrationIdempotencyKey(request);
  if (request.idempotency_key !== expectedKey) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_IDEMPOTENCY_MISMATCH",
      "idempotency_key does not match the deterministic request",
      { expected: expectedKey },
    );
  }
}

function assertForwardRequest(
  request: MementosProjectRegistrationRequest,
  capability: MementosProjectRegistrationCapability,
): string {
  assertCommonRequest(request, capability);
  if (request.direction !== "forward" || request.accepted_receipt !== undefined) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "conditional create requires a forward request without an accepted receipt",
    );
  }
  exactKeys(request.desired, [
    "name",
    "source_project_id",
    "source_project_slug",
    "target_path_digest",
  ], "forward desired");
  if (
    request.target_selector !== request.project_id
    || request.desired["source_project_id"] !== request.project_id
    || request.desired["source_project_slug"] !== request.project_slug
    || request.desired["name"] !== request.project_name
  ) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "forward project identity fields disagree",
    );
  }
  const expectedPrecondition = digestMementosProjectRegistrationValue({
    target_selector: request.target_selector,
    expected: "absent",
  });
  if (request.precondition_digest !== expectedPrecondition) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH",
      "forward precondition must bind expected absence",
    );
  }
  const path = ownedPath(request.target);
  if (request.desired["target_path_digest"] !== digestOwnedPath(path)) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH",
      "target path does not match the package-owned digest",
    );
  }
  return path;
}

function sameReceipt(left: StoredReceipt, right: MementosProjectRegistrationReceipt): boolean {
  return canonicalMementosProjectRegistrationJson(publicReceipt(left))
    === canonicalMementosProjectRegistrationJson(right);
}

function assertInverseRequest(
  request: MementosProjectRegistrationRequest,
  capability: MementosProjectRegistrationCapability,
): MementosProjectRegistrationReceipt {
  assertCommonRequest(request, capability);
  if (request.direction !== "inverse" || !request.accepted_receipt) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "conditional inverse requires the accepted forward receipt",
    );
  }
  const accepted = request.accepted_receipt;
  if (
    accepted.authority !== "mementos"
    || accepted.route !== capability.route
    || accepted.package_version !== capability.package_version
    || accepted.authority_id !== capability.authority_id
    || accepted.tenant_id !== capability.tenant_id
    || accepted.corpus_id !== capability.corpus_id
    || accepted.operation_id !== request.operation_id
    || accepted.step_id !== request.step_id
    || accepted.resource_kind !== "project"
    || accepted.direction !== "forward"
    || accepted.outcome !== "accepted"
    || !accepted.created_by_operation
    || !accepted.target_id
    || !accepted.result_revision
    || !accepted.result_digest
    || request.target_selector !== accepted.target_id
  ) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      "accepted receipt is not an exact attempt-created forward receipt",
    );
  }
  exactKeys(request.desired, ["accepted_receipt_id", "target_id"], "inverse desired");
  if (
    request.desired["accepted_receipt_id"] !== accepted.receipt_id
    || request.desired["target_id"] !== accepted.target_id
  ) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH",
      "inverse desired payload does not bind the accepted receipt",
    );
  }
  const expectedPrecondition = digestMementosProjectRegistrationValue({
    expected_revision: accepted.result_revision,
    expected_digest: accepted.result_digest,
  });
  if (request.precondition_digest !== expectedPrecondition) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_DIGEST_MISMATCH",
      "inverse precondition does not bind the accepted object state",
    );
  }
  return accepted;
}

function assertLookup(
  request: MementosProjectRegistrationLookupRequest,
  capability: MementosProjectRegistrationCapability,
): void {
  assertBounds(request);
  if (request.max_items !== 1) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_INVALID_BOUNDS",
      "terminal receipt lookup requires max_items exactly 1",
    );
  }
  if (
    request.authority !== "mementos"
    || request.resource_kind !== "project"
    || request.authority_route !== capability.route
    || request.package_version !== capability.package_version
    || request.authority_id !== capability.authority_id
    || request.tenant_id !== capability.tenant_id
    || request.corpus_id !== capability.corpus_id
  ) {
    throw new MementosProjectRegistrationError(
      "MEMENTOS_PROJECT_REGISTRATION_CAPABILITY_MISMATCH",
      "receipt lookup does not match this authority capability identity",
    );
  }
  requireString(request.operation_id, "operation_id", { pattern: OPERATION_PATTERN });
  requireString(request.step_id, "step_id", { pattern: STEP_PATTERN });
  requireString(request.target_selector, "target_selector");
  requireString(request.idempotency_key, "idempotency_key", {
    min: 52,
    max: 52,
    pattern: IDEMPOTENCY_PATTERN,
  });
  if (request.target_id !== undefined) {
    requireString(request.target_id, "target_id", {
      min: 51,
      max: 51,
      pattern: PROJECT_ID_PATTERN,
    });
  }
}

export class PackageOwnedMementosProjectRegistrationAuthority
implements MementosProjectRegistrationAuthority {
  readonly authority = "mementos" as const;
  private readonly capabilityValue: MementosProjectRegistrationCapability;
  private readonly now: () => string;
  private readonly faultInjector?: MementosProjectRegistrationAuthorityOptions["faultInjector"];

  constructor(
    private readonly db: DbAdapter,
    options: MementosProjectRegistrationAuthorityOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.faultInjector = options.faultInjector;
    this.capabilityValue = {
      authority: "mementos",
      route: MEMENTOS_PROJECT_REGISTRATION_ROUTE,
      package_version: options.packageVersion ?? getMementosPackageVersion(),
      authority_id: options.authorityId ?? "mementos",
      tenant_id: options.tenantId ?? "default",
      corpus_id: options.corpusId ?? "default",
      supported_resources: ["project"],
      conditional_create: true,
      immutable_receipts: true,
      exact_terminal_lookup: true,
      exact_readback: true,
      conditional_inverse: true,
      ambiguous_outcome_reconciliation: true,
    };
  }

  private fault(
    point: MementosProjectRegistrationFaultPoint,
    request: MementosProjectRegistrationRequest,
  ): void {
    this.faultInjector?.(point, {
      operation_id: request.operation_id,
      step_id: request.step_id,
      resource_kind: "project",
      direction: request.direction,
    });
  }

  private writeBoundary(
    point: Exclude<MementosProjectRegistrationFaultPoint, "after_commit">,
    request: MementosProjectRegistrationRequest,
  ): void {
    try {
      this.fault(point, request);
    } catch (cause) {
      throw new WriteBoundaryError(point, cause);
    }
  }

  private terminal(
    request: MementosProjectRegistrationRequest,
    callDigest: string,
    reason: string,
    values: {
      target_id?: string | null;
      accepted_receipt_id?: string | null;
      target_selector?: string;
    } = {},
  ): StoredReceipt {
    return insertReceipt(this.db, makeReceipt(
      request,
      this.capabilityValue,
      callDigest,
      this.now(),
      {
        outcome: "terminal_nonacceptance",
        reason,
        target_id: values.target_id,
        accepted_receipt_id: values.accepted_receipt_id,
        target_selector: values.target_selector,
      },
    ));
  }

  private duplicateForwardOrTerminal(
    request: MementosProjectRegistrationRequest,
    callDigest: string,
    path: string,
    accepted: StoredReceipt,
  ): StoredReceipt {
    if (accepted.normalized_call_digest !== callDigest) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_IDEMPOTENCY_MISMATCH",
        "accepted operation/step identity is bound to a different request",
      );
    }
    const project = accepted.target_id
      ? getProjectByExactId(this.db, accepted.target_id)
      : null;
    if (!project || project.path !== path) {
      return this.terminal(request, callDigest, "accepted_target_missing_or_replaced", {
        target_id: accepted.target_id,
      });
    }
    const record = projectRecord(this.db, project);
    if (
      record.revision !== accepted.result_revision
      || record.digest !== accepted.result_digest
    ) {
      return this.terminal(request, callDigest, "accepted_target_drifted", {
        target_id: accepted.target_id,
      });
    }
    return insertReceipt(this.db, makeReceipt(
      request,
      this.capabilityValue,
      callDigest,
      this.now(),
      {
        outcome: "duplicate_of_accepted",
        target_id: accepted.target_id,
        result_revision: accepted.result_revision,
        result_digest: accepted.result_digest,
        duplicate_of_receipt_id: accepted.receipt_id,
        created_by_operation: false,
      },
    ));
  }

  async capability(): Promise<MementosProjectRegistrationCapability> {
    return {
      ...this.capabilityValue,
      supported_resources: ["project"],
    };
  }

  async create(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationReceipt> {
    const startedAt = Date.now();
    const path = assertForwardRequest(request, this.capabilityValue);
    const callDigest = normalizedCallDigest(request);
    let stored: StoredReceipt;
    try {
      stored = this.db.transaction(() => {
        const exact = getReceiptForLookup(this.db, {
          ...request,
          authority: "mementos",
          max_items: 1,
        });
        if (exact?.outcome === "terminal_nonacceptance") return exact;

        const accepted = getAcceptedReceipt(this.db, request);
        if (accepted) {
          return this.duplicateForwardOrTerminal(request, callDigest, path, accepted);
        }

        const existing = getProjectByPath(this.db, path)
          ?? getProjectByExactId(this.db, targetId(this.capabilityValue, request.target_selector));
        if (existing) {
          return this.terminal(request, callDigest, "target_preexists", {
            target_id: existing.id,
          });
        }

        const now = this.now();
        const insertedBinding = insertBinding(this.db, request, callDigest, now);
        if (!lockBinding(this.db, this.capabilityValue, request.target_selector)) {
          throw new MementosProjectRegistrationError(
            "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
            "registration binding disappeared before it could be locked",
          );
        }
        const ownedBinding = getBinding(this.db, this.capabilityValue, request.target_selector);
        if (!ownedBinding || ownedBinding.normalized_call_digest !== callDigest) {
          return this.terminal(request, callDigest, "target_selector_preexists", {
            target_id: ownedBinding?.target_id,
          });
        }
        const acceptedAfterBinding = getAcceptedReceipt(this.db, request);
        if (acceptedAfterBinding) {
          return this.duplicateForwardOrTerminal(
            request,
            callDigest,
            path,
            acceptedAfterBinding,
          );
        }
        if (!insertedBinding || ownedBinding.state !== "pending") {
          return this.terminal(request, callDigest, "target_selector_preexists", {
            target_id: ownedBinding.target_id,
          });
        }

        const id = targetId(this.capabilityValue, request.target_selector);
        this.writeBoundary("before_object_write", request);
        try {
          this.db.run(`
            INSERT INTO projects (
              id, name, path, description, memory_prefix, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `, id, request.project_name, path, null, request.project_slug, now, now);
        } catch (cause) {
          throw new WriteBoundaryError("before_object_write", cause);
        }
        this.writeBoundary("after_object_write", request);
        const project = getProjectByExactId(this.db, id);
        if (!project || project.path !== path) {
          throw new MementosProjectRegistrationError(
            "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
            "project write did not read back by its full id",
          );
        }
        const record = projectRecord(this.db, project);
        const acceptedReceipt = makeReceipt(
          request,
          this.capabilityValue,
          callDigest,
          now,
          {
            outcome: "accepted",
            target_id: record.target_id,
            result_revision: record.revision,
            result_digest: record.digest,
            created_by_operation: true,
          },
        );
        this.writeBoundary("before_receipt_write", request);
        let inserted: StoredReceipt;
        try {
          inserted = insertReceipt(this.db, acceptedReceipt);
        } catch (cause) {
          throw new WriteBoundaryError("before_receipt_write", cause);
        }
        this.writeBoundary("after_receipt_write", request);
        setBindingAccepted(this.db, request, inserted, now);
        return inserted;
      });
    } catch (error) {
      if (!(error instanceof WriteBoundaryError)) throw error;
      stored = this.db.transaction(() => this.terminal(
        request,
        callDigest,
        `write_failed:${error.point}`,
      ));
    }
    this.fault("after_commit", request);
    const receipt = publicReceipt(stored);
    assertWithinBounds(receipt, request, startedAt);
    return receipt;
  }

  async readExact(request: {
    resource_kind: "project";
    target_id: string;
    target: MementosProjectRegistrationPathHandle;
    response_byte_limit: number;
    time_budget_ms: number;
  }): Promise<MementosProjectRegistrationRecord> {
    const startedAt = Date.now();
    assertBounds(request);
    if (request.resource_kind !== "project") {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
        "resource_kind must be project",
      );
    }
    requireString(request.target_id, "target_id", {
      min: 51,
      max: 51,
      pattern: PROJECT_ID_PATTERN,
    });
    const path = ownedPath(request.target);
    const project = getProjectByExactId(this.db, request.target_id);
    if (!project || project.path !== path) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_RECORD_NOT_FOUND",
        "exact full-id project readback did not resolve the owned path",
      );
    }
    const record = projectRecord(this.db, project);
    assertWithinBounds(record, request, startedAt);
    return record;
  }

  async lookupReceipt(
    request: MementosProjectRegistrationLookupRequest,
  ): Promise<MementosProjectRegistrationLookupResult> {
    const startedAt = Date.now();
    assertLookup(request, this.capabilityValue);
    const receipt = getReceiptForLookup(this.db, request);
    if (!receipt || (request.target_id !== undefined && receipt.target_id !== request.target_id)) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_RECEIPT_NOT_FOUND",
        "exact immutable terminal receipt was not found",
      );
    }
    return withResponseControl(publicReceipt(receipt), request, startedAt);
  }

  async compensate(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationReceipt> {
    const startedAt = Date.now();
    const acceptedPublic = assertInverseRequest(request, this.capabilityValue);
    const callDigest = normalizedCallDigest(request);
    const storedAccepted = getStoredReceipt(this.db, acceptedPublic.receipt_id);
    if (!storedAccepted || !sameReceipt(storedAccepted, acceptedPublic)) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_ACCEPTED_RECEIPT_NOT_FOUND",
        "accepted forward receipt is not stored immutably in this authority",
      );
    }
    const path = ownedPath(request.target);
    let stored: StoredReceipt;
    try {
      stored = this.db.transaction(() => {
        const exact = getReceiptForLookup(this.db, {
          ...request,
          authority: "mementos",
          max_items: 1,
        });
        if (exact?.outcome === "terminal_nonacceptance") return exact;

        if (!lockBinding(this.db, this.capabilityValue, storedAccepted.target_selector)) {
          return this.terminal(request, callDigest, "accepted_binding_missing", {
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
          });
        }
        const binding = getBinding(
          this.db,
          this.capabilityValue,
          storedAccepted.target_selector,
        );
        if (!binding || binding.accepted_receipt_id !== storedAccepted.receipt_id) {
          return this.terminal(request, callDigest, "accepted_binding_replaced", {
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
          });
        }

        const prior = getAcceptedReceipt(this.db, request);
        if (prior) {
          if (
            prior.normalized_call_digest !== callDigest
            || prior.accepted_receipt_id !== storedAccepted.receipt_id
          ) {
            throw new MementosProjectRegistrationError(
              "MEMENTOS_PROJECT_REGISTRATION_IDEMPOTENCY_MISMATCH",
              "inverse operation/step identity is bound to a different request",
            );
          }
          return insertReceipt(this.db, makeReceipt(
            request,
            this.capabilityValue,
            callDigest,
            this.now(),
            {
              outcome: "duplicate_of_accepted",
              target_id: prior.target_id,
              result_revision: prior.result_revision,
              result_digest: prior.result_digest,
              duplicate_of_receipt_id: prior.receipt_id,
              accepted_receipt_id: storedAccepted.receipt_id,
            },
          ));
        }
        if (binding.state !== "accepted") {
          return this.terminal(request, callDigest, "accepted_binding_not_active", {
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
          });
        }

        const project = getProjectByExactId(this.db, storedAccepted.target_id!);
        if (!project) {
          return this.terminal(request, callDigest, "target_missing", {
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
          });
        }
        const current = projectRecord(this.db, project);
        if (
          project.path !== path
          || current.revision !== storedAccepted.result_revision
          || current.digest !== storedAccepted.result_digest
        ) {
          return this.terminal(request, callDigest, "target_drifted", {
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
          });
        }

        this.writeBoundary("before_object_write", request);
        try {
          const result = this.db.run("DELETE FROM projects WHERE id = ?", storedAccepted.target_id);
          if (result.changes !== 1) {
            throw new MementosProjectRegistrationError(
              "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
              "conditional inverse did not delete exactly one project",
            );
          }
        } catch (cause) {
          throw new WriteBoundaryError("before_object_write", cause);
        }
        this.writeBoundary("after_object_write", request);
        const inverseRecord = {
          target_id: storedAccepted.target_id!,
          revision: "absent",
          digest: digestMementosProjectRegistrationValue({
            target_id: storedAccepted.target_id,
            accepted_receipt_id: storedAccepted.receipt_id,
            absent: true,
          }),
        };
        const inverseReceipt = makeReceipt(
          request,
          this.capabilityValue,
          callDigest,
          this.now(),
          {
            outcome: "accepted",
            target_id: inverseRecord.target_id,
            result_revision: inverseRecord.revision,
            result_digest: inverseRecord.digest,
            accepted_receipt_id: storedAccepted.receipt_id,
            created_by_operation: false,
          },
        );
        this.writeBoundary("before_receipt_write", request);
        let inserted: StoredReceipt;
        try {
          inserted = insertReceipt(this.db, inverseReceipt);
        } catch (cause) {
          throw new WriteBoundaryError("before_receipt_write", cause);
        }
        this.writeBoundary("after_receipt_write", request);
        setBindingRemoved(this.db, storedAccepted, inserted.receipt_id, this.now());
        return inserted;
      });
    } catch (error) {
      if (!(error instanceof WriteBoundaryError)) throw error;
      stored = this.db.transaction(() => this.terminal(
        request,
        callDigest,
        `write_failed:${error.point}`,
        {
          target_id: storedAccepted.target_id,
          accepted_receipt_id: storedAccepted.receipt_id,
        },
      ));
    }
    this.fault("after_commit", request);
    const receipt = publicReceipt(stored);
    assertWithinBounds(receipt, request, startedAt);
    return receipt;
  }

  async verifyInverse(
    request: MementosProjectRegistrationRequest,
  ): Promise<MementosProjectRegistrationInverseVerification> {
    const startedAt = Date.now();
    const accepted = assertInverseRequest(request, this.capabilityValue);
    const storedAccepted = getStoredReceipt(this.db, accepted.receipt_id);
    if (!storedAccepted || !sameReceipt(storedAccepted, accepted)) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_ACCEPTED_RECEIPT_NOT_FOUND",
        "accepted forward receipt is not stored immutably in this authority",
      );
    }
    const inverse = getAcceptedReceipt(this.db, request);
    if (
      !inverse
      || inverse.outcome !== "accepted"
      || inverse.accepted_receipt_id !== accepted.receipt_id
      || inverse.result_revision !== "absent"
      || !inverse.result_digest
    ) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_RECEIPT_NOT_FOUND",
        "accepted conditional inverse receipt was not found",
      );
    }
    if (getProjectByExactId(this.db, accepted.target_id!)) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
        "inverse verification found the accepted target still present",
      );
    }
    const verification = {
      target_id: accepted.target_id!,
      accepted_receipt_id: accepted.receipt_id,
      absent: true as const,
      digest: digestMementosProjectRegistrationValue({
        target_id: accepted.target_id,
        accepted_receipt_id: accepted.receipt_id,
        absent: true,
      }),
    };
    assertWithinBounds(verification, request, startedAt);
    if (verification.digest !== inverse.result_digest) {
      throw new MementosProjectRegistrationError(
        "MEMENTOS_PROJECT_REGISTRATION_CONFLICT",
        "inverse verification digest does not match its immutable receipt",
      );
    }
    return verification;
  }
}

export function createMementosProjectRegistrationAuthority(
  db: DbAdapter,
  options: MementosProjectRegistrationAuthorityOptions = {},
): MementosProjectRegistrationAuthority {
  return new PackageOwnedMementosProjectRegistrationAuthority(db, options);
}

export const createLocalMementosProjectRegistrationAuthority =
  createMementosProjectRegistrationAuthority;
