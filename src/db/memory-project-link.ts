import { createHash } from "node:crypto";
import {
  PgAdapter,
  SqliteAdapter as Database,
} from "../storage.js";
import type {
  Memory,
  MemoryProjectLinkReceipt,
  MemoryProjectLinkRequest,
  MemoryProjectLinkResult,
  MemoryProjectLinkRollbackRequest,
  MemoryProjectLinkSnapshot,
  Project,
  ProjectAuthorityIdentity,
} from "../types/index.js";
import { apiJson, isApiMode } from "./api-mode.js";
import { getDatabase, now } from "./database.js";
import { parseMemoryRow } from "./memories.js";
import { getMementosPackageVersion } from "../lib/package-version.js";
import { MEMENTOS_MEMORY_PROJECT_LINK_ROUTE } from "../memory-project-link/schema.js";

export type MemoryProjectLinkErrorCode =
  | "MEMORY_PROJECT_LINK_INVALID_INPUT"
  | "MEMORY_PROJECT_LINK_AUTHORITY_MISMATCH"
  | "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND"
  | "MEMORY_PROJECT_LINK_PROJECT_NOT_FOUND"
  | "MEMORY_PROJECT_LINK_STALE_MEMORY"
  | "MEMORY_PROJECT_LINK_STALE_PROJECT"
  | "MEMORY_PROJECT_LINK_COLLISION"
  | "MEMORY_PROJECT_LINK_IDEMPOTENCY_MISMATCH"
  | "MEMORY_PROJECT_LINK_RECEIPT_NOT_FOUND"
  | "MEMORY_PROJECT_LINK_RECEIPT_NOT_ROLLBACKABLE"
  | "MEMORY_PROJECT_LINK_ACCEPTED_TARGET_DRIFTED";

export class MemoryProjectLinkError extends Error {
  constructor(
    public readonly code: MemoryProjectLinkErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "MemoryProjectLinkError";
  }
}

const LINK_AUTHORITY: ProjectAuthorityIdentity = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
};
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function timestampString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestampString(value);
}

function normalizeMemoryTimestamps(memory: Memory): Memory {
  return {
    ...memory,
    created_at: timestampString(memory.created_at),
    updated_at: timestampString(memory.updated_at),
    accessed_at: nullableTimestamp(memory.accessed_at),
    expires_at: nullableTimestamp(memory.expires_at),
    valid_from: nullableTimestamp(memory.valid_from),
    valid_until: nullableTimestamp(memory.valid_until),
    ingested_at: nullableTimestamp(memory.ingested_at),
  };
}

function parseProjectRow(row: Record<string, unknown>): Project {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    path: String(row["path"]),
    description: row["description"] === null ? null : String(row["description"] ?? "") || null,
    memory_prefix: row["memory_prefix"] === null
      ? null
      : String(row["memory_prefix"] ?? "") || null,
    created_at: timestampString(row["created_at"]),
    updated_at: timestampString(row["updated_at"]),
  };
}

/** Access tracking changes on reads and is not an edit to the memory payload. */
function memoryMutationState(memory: Memory): Omit<Memory, "access_count" | "accessed_at"> {
  const { access_count: _accessCount, accessed_at: _accessedAt, ...state } = memory;
  return state;
}

function memoryDigest(memory: Memory): string {
  return digest(memoryMutationState(memory));
}

function projectDigest(project: Project): string {
  return digest(project);
}

function snapshot(memory: Memory): MemoryProjectLinkSnapshot {
  return {
    memory_id: memory.id,
    project_id: memory.project_id,
    memory_version: memory.version,
    memory_revision: timestampString(memory.updated_at),
    memory_digest: memoryDigest(memory),
  };
}

function parseSnapshot(value: unknown): MemoryProjectLinkSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed as MemoryProjectLinkSnapshot;
}

function receiptFromRow(row: Record<string, unknown>): MemoryProjectLinkReceipt {
  return {
    receipt_id: String(row["receipt_id"]),
    authority: "mementos",
    route: MEMENTOS_MEMORY_PROJECT_LINK_ROUTE,
    package_version: String(row["package_version"]),
    authority_id: String(row["authority_id"]),
    tenant_id: String(row["tenant_id"]),
    corpus_id: String(row["corpus_id"]),
    operation_id: String(row["operation_id"]),
    step_id: String(row["step_id"]),
    direction: row["direction"] as "forward" | "rollback",
    idempotency_key: String(row["idempotency_key"]),
    request_digest: String(row["request_digest"]),
    outcome: row["outcome"] as "accepted" | "no_change",
    target_memory_id: String(row["target_memory_id"]),
    requested_project_id: String(row["requested_project_id"]),
    expected_memory_version: Number(row["expected_memory_version"]),
    expected_memory_revision: timestampString(row["expected_memory_revision"]),
    expected_project_revision: nullableTimestamp(row["expected_project_revision"]),
    result_memory_version: Number(row["result_memory_version"]),
    result_memory_revision: timestampString(row["result_memory_revision"]),
    result_memory_digest: String(row["result_memory_digest"]),
    result_project_revision: nullableTimestamp(row["result_project_revision"]),
    result_project_digest: row["result_project_digest"] === null
      ? null
      : String(row["result_project_digest"]),
    accepted_receipt_id: row["accepted_receipt_id"] === null
      ? null
      : String(row["accepted_receipt_id"]),
    before_link: parseSnapshot(row["before_link_json"]),
    after_link: parseSnapshot(row["after_link_json"]),
    before_project_revision: nullableTimestamp(row["before_project_revision"]),
    before_project_digest: row["before_project_digest"] === null
      ? null
      : String(row["before_project_digest"]),
    after_project_revision: nullableTimestamp(row["after_project_revision"]),
    after_project_digest: row["after_project_digest"] === null
      ? null
      : String(row["after_project_digest"]),
    created_at: timestampString(row["created_at"]),
  };
}

function assertIdentity(identity: ProjectAuthorityIdentity): void {
  if (
    identity.authority_id !== LINK_AUTHORITY.authority_id
    || identity.tenant_id !== LINK_AUTHORITY.tenant_id
    || identity.corpus_id !== LINK_AUTHORITY.corpus_id
  ) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_AUTHORITY_MISMATCH",
      "memory project link does not match this authority, tenant, and corpus",
    );
  }
}

function assertBoundedIdentifier(value: string, field: string): void {
  if (!BOUNDED_IDENTIFIER.test(value)) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_INVALID_INPUT",
      `${field} must be an 8-128 character bounded identifier`,
    );
  }
}

function assertMemoryGuard(version: number, revision: string): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_INVALID_INPUT",
      "expected_memory_version must be a positive safe integer",
    );
  }
  if (!revision || revision.length > 128) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_INVALID_INPUT",
      "expected_memory_revision is required and must be bounded",
    );
  }
}

function assertForwardRequest(request: MemoryProjectLinkRequest): void {
  assertIdentity(request);
  assertBoundedIdentifier(request.operation_id, "operation_id");
  assertBoundedIdentifier(request.step_id, "step_id");
  assertBoundedIdentifier(request.idempotency_key, "idempotency_key");
  assertBoundedIdentifier(request.target_project_id, "target_project_id");
  assertMemoryGuard(request.expected_memory_version, request.expected_memory_revision);
  if (!request.expected_project_revision || request.expected_project_revision.length > 128) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_INVALID_INPUT",
      "expected_project_revision is required and must be bounded",
    );
  }
}

function assertRollbackRequest(request: MemoryProjectLinkRollbackRequest): void {
  assertIdentity(request);
  assertBoundedIdentifier(request.operation_id, "operation_id");
  assertBoundedIdentifier(request.step_id, "step_id");
  assertBoundedIdentifier(request.idempotency_key, "idempotency_key");
  assertBoundedIdentifier(request.accepted_receipt_id, "accepted_receipt_id");
  assertMemoryGuard(request.expected_memory_version, request.expected_memory_revision);
}

function forwardRequestDigest(
  memoryId: string,
  request: MemoryProjectLinkRequest,
): string {
  return digest({
    authority_id: request.authority_id,
    tenant_id: request.tenant_id,
    corpus_id: request.corpus_id,
    operation_id: request.operation_id,
    step_id: request.step_id,
    idempotency_key: request.idempotency_key,
    expected_memory_version: request.expected_memory_version,
    expected_memory_revision: request.expected_memory_revision,
    target_project_id: request.target_project_id,
    expected_project_revision: request.expected_project_revision,
    direction: "forward",
    target_memory_id: memoryId,
  });
}

function rollbackRequestDigest(
  memoryId: string,
  request: MemoryProjectLinkRollbackRequest,
): string {
  return digest({
    authority_id: request.authority_id,
    tenant_id: request.tenant_id,
    corpus_id: request.corpus_id,
    operation_id: request.operation_id,
    step_id: request.step_id,
    idempotency_key: request.idempotency_key,
    expected_memory_version: request.expected_memory_version,
    expected_memory_revision: request.expected_memory_revision,
    accepted_receipt_id: request.accepted_receipt_id,
    direction: "rollback",
    target_memory_id: memoryId,
  });
}

function forUpdateSuffix(db: Database, lock: boolean): string {
  return lock && db instanceof PgAdapter ? " FOR UPDATE" : "";
}

function getMemoryByExactId(id: string, db: Database, lock = false): Memory | null {
  const row = db.query(
    `SELECT * FROM memories WHERE id = ? LIMIT 1${forUpdateSuffix(db, lock)}`,
  ).get(id) as Record<string, unknown> | null;
  return row ? normalizeMemoryTimestamps(parseMemoryRow(row)) : null;
}

function getProjectByExactId(id: string, db: Database, lock = false): Project | null {
  const row = db.query(
    `SELECT * FROM projects WHERE id = ? LIMIT 1${forUpdateSuffix(db, lock)}`,
  ).get(id) as Record<string, unknown> | null;
  return row ? parseProjectRow(row) : null;
}

function lockProjects(
  ids: Array<string | null>,
  db: Database,
): Map<string, Project> {
  const projects = new Map<string, Project>();
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))].sort();
  for (const id of uniqueIds) {
    const project = getProjectByExactId(id, db, true);
    if (!project) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_PROJECT_NOT_FOUND",
        `Project not found by exact stable ID: ${id}`,
      );
    }
    projects.set(id, project);
  }
  return projects;
}

function assertMemoryPrecondition(
  memory: Memory,
  expectedVersion: number,
  expectedRevision: string,
): void {
  if (memory.version !== expectedVersion || memory.updated_at !== expectedRevision) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_STALE_MEMORY",
      "Memory changed before the guarded project link",
      {
        expected_memory_version: expectedVersion,
        current_memory_version: memory.version,
        expected_memory_revision: expectedRevision,
        current_memory_revision: memory.updated_at,
      },
    );
  }
}

function assertProjectPrecondition(project: Project, expectedRevision: string): void {
  if (project.updated_at !== expectedRevision) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_STALE_PROJECT",
      "Project changed before the guarded memory link",
      {
        expected_project_revision: expectedRevision,
        current_project_revision: project.updated_at,
      },
    );
  }
}

function assertNoTargetBucketCollision(
  memory: Memory,
  projectId: string | null,
  db: Database,
): void {
  const collision = db.query(`
    SELECT id FROM memories
    WHERE id != ? AND key = ? AND scope = ?
      AND COALESCE(agent_id, '') = COALESCE(?, '')
      AND COALESCE(project_id, '') = COALESCE(?, '')
      AND COALESCE(session_id, '') = COALESCE(?, '')
    LIMIT 1
  `).get(
    memory.id,
    memory.key,
    memory.scope,
    memory.agent_id,
    projectId,
    memory.session_id,
  ) as { id: string } | null;
  if (collision) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_COLLISION",
      "Linking this memory would collide with another memory in the target project bucket",
      { collision_id: collision.id },
    );
  }
}

function nextRevision(previous: string): string {
  const candidate = now();
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  if (Number.isFinite(previousMs) && Number.isFinite(candidateMs) && candidateMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return candidate;
}

function findReceiptByKey(
  db: Database,
  identity: ProjectAuthorityIdentity,
  direction: "forward" | "rollback",
  idempotencyKey: string,
): MemoryProjectLinkReceipt | null {
  const row = db.query(`
    SELECT * FROM mementos_memory_project_link_receipts
    WHERE authority_id = ? AND tenant_id = ? AND corpus_id = ?
      AND direction = ? AND idempotency_key = ?
    LIMIT 1
  `).get(
    identity.authority_id,
    identity.tenant_id,
    identity.corpus_id,
    direction,
    idempotencyKey,
  ) as Record<string, unknown> | null;
  return row ? receiptFromRow(row) : null;
}

function findReceiptById(
  db: Database,
  identity: ProjectAuthorityIdentity,
  receiptId: string,
): MemoryProjectLinkReceipt | null {
  const row = db.query(`
    SELECT * FROM mementos_memory_project_link_receipts
    WHERE receipt_id = ? AND authority_id = ? AND tenant_id = ? AND corpus_id = ?
    LIMIT 1
  `).get(
    receiptId,
    identity.authority_id,
    identity.tenant_id,
    identity.corpus_id,
  ) as Record<string, unknown> | null;
  return row ? receiptFromRow(row) : null;
}

function insertReceipt(db: Database, receipt: MemoryProjectLinkReceipt): void {
  db.run(`
    INSERT INTO mementos_memory_project_link_receipts (
      receipt_id, authority, route, package_version, authority_id, tenant_id,
      corpus_id, operation_id, step_id, direction, idempotency_key,
      request_digest, outcome, target_memory_id, requested_project_id,
      expected_memory_version, expected_memory_revision,
      expected_project_revision, result_memory_version,
      result_memory_revision, result_memory_digest, result_project_revision,
      result_project_digest, accepted_receipt_id, before_link_json,
      after_link_json, before_project_revision, before_project_digest,
      after_project_revision, after_project_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    receipt.receipt_id,
    receipt.authority,
    receipt.route,
    receipt.package_version,
    receipt.authority_id,
    receipt.tenant_id,
    receipt.corpus_id,
    receipt.operation_id,
    receipt.step_id,
    receipt.direction,
    receipt.idempotency_key,
    receipt.request_digest,
    receipt.outcome,
    receipt.target_memory_id,
    receipt.requested_project_id,
    receipt.expected_memory_version,
    receipt.expected_memory_revision,
    receipt.expected_project_revision,
    receipt.result_memory_version,
    receipt.result_memory_revision,
    receipt.result_memory_digest,
    receipt.result_project_revision,
    receipt.result_project_digest,
    receipt.accepted_receipt_id,
    canonicalJson(receipt.before_link),
    canonicalJson(receipt.after_link),
    receipt.before_project_revision,
    receipt.before_project_digest,
    receipt.after_project_revision,
    receipt.after_project_digest,
    receipt.created_at,
  ]);
}

function makeReceipt(input: {
  request: MemoryProjectLinkRequest | MemoryProjectLinkRollbackRequest;
  direction: "forward" | "rollback";
  requestDigest: string;
  outcome: "accepted" | "no_change";
  targetMemoryId: string;
  requestedProjectId: string;
  expectedProjectRevision: string | null;
  beforeMemory: Memory;
  afterMemory: Memory;
  beforeProject: Project | null;
  afterProject: Project | null;
  acceptedReceiptId?: string | null;
}): MemoryProjectLinkReceipt {
  const beforeLink = snapshot(input.beforeMemory);
  const afterLink = snapshot(input.afterMemory);
  const logical = {
    authority: "mementos" as const,
    route: MEMENTOS_MEMORY_PROJECT_LINK_ROUTE,
    package_version: getMementosPackageVersion(),
    authority_id: input.request.authority_id,
    tenant_id: input.request.tenant_id,
    corpus_id: input.request.corpus_id,
    operation_id: input.request.operation_id,
    step_id: input.request.step_id,
    direction: input.direction,
    idempotency_key: input.request.idempotency_key,
    request_digest: input.requestDigest,
    outcome: input.outcome,
    target_memory_id: input.targetMemoryId,
    requested_project_id: input.requestedProjectId,
    expected_memory_version: input.request.expected_memory_version,
    expected_memory_revision: input.request.expected_memory_revision,
    expected_project_revision: input.expectedProjectRevision,
    result_memory_version: afterLink.memory_version,
    result_memory_revision: afterLink.memory_revision,
    result_memory_digest: afterLink.memory_digest,
    result_project_revision: input.afterProject?.updated_at ?? null,
    result_project_digest: input.afterProject ? projectDigest(input.afterProject) : null,
    accepted_receipt_id: input.acceptedReceiptId ?? null,
    before_link: beforeLink,
    after_link: afterLink,
    before_project_revision: input.beforeProject?.updated_at ?? null,
    before_project_digest: input.beforeProject ? projectDigest(input.beforeProject) : null,
    after_project_revision: input.afterProject?.updated_at ?? null,
    after_project_digest: input.afterProject ? projectDigest(input.afterProject) : null,
  };
  return {
    receipt_id: `mmpl_${digest(logical).slice(0, 40)}`,
    ...logical,
    created_at: now(),
  };
}

function sameSnapshot(memory: Memory, expected: MemoryProjectLinkSnapshot): boolean {
  return canonicalJson(snapshot(memory)) === canonicalJson(expected);
}

function assertProjectSnapshot(
  project: Project | null,
  revision: string | null,
  expectedDigest: string | null,
): void {
  if (!revision && !expectedDigest) {
    if (project) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_ACCEPTED_TARGET_DRIFTED",
        "receipt expected no linked project but a project row was resolved",
      );
    }
    return;
  }
  if (!project || project.updated_at !== revision || projectDigest(project) !== expectedDigest) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_STALE_PROJECT",
      "Project no longer matches the immutable memory-link receipt",
      { expected_project_revision: revision, current_project_revision: project?.updated_at ?? null },
    );
  }
}

function replayResult(
  db: Database,
  receipt: MemoryProjectLinkReceipt,
  requestDigest: string,
  memoryId: string,
): MemoryProjectLinkResult {
  if (receipt.request_digest !== requestDigest || receipt.target_memory_id !== memoryId) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_IDEMPOTENCY_MISMATCH",
      "caller idempotency key is already bound to a different memory project-link request",
    );
  }
  const memory = getMemoryByExactId(memoryId, db);
  if (!memory || !sameSnapshot(memory, receipt.after_link)) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_ACCEPTED_TARGET_DRIFTED",
      "accepted memory project-link target drifted after its immutable receipt",
    );
  }
  const project = receipt.after_link.project_id
    ? getProjectByExactId(receipt.after_link.project_id, db)
    : null;
  assertProjectSnapshot(project, receipt.after_project_revision, receipt.after_project_digest);
  return {
    dry_run: false,
    applied: receipt.outcome === "accepted",
    no_change: receipt.outcome === "no_change",
    memory,
    project,
    receipt,
  };
}

export function previewMemoryProjectLink(
  memoryId: string,
  request: MemoryProjectLinkRequest,
  db?: Database,
): MemoryProjectLinkResult {
  assertForwardRequest(request);
  assertBoundedIdentifier(memoryId, "memory_id");
  if (!db && isApiMode()) {
    const { data } = apiJson<MemoryProjectLinkResult>(
      "POST",
      `/memories/${encodeURIComponent(memoryId)}/guarded-project-link`,
      { ...request, dry_run: true },
    );
    return data;
  }
  const d = db || getDatabase();
  const memory = getMemoryByExactId(memoryId, d);
  if (!memory) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND",
      `Memory not found by exact stable ID: ${memoryId}`,
    );
  }
  const project = getProjectByExactId(request.target_project_id, d);
  if (!project) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_PROJECT_NOT_FOUND",
      `Project not found by exact stable ID: ${request.target_project_id}`,
    );
  }
  assertMemoryPrecondition(memory, request.expected_memory_version, request.expected_memory_revision);
  assertProjectPrecondition(project, request.expected_project_revision);
  const noChange = memory.project_id === project.id;
  if (!noChange) assertNoTargetBucketCollision(memory, project.id, d);
  return {
    dry_run: true,
    applied: false,
    no_change: noChange,
    memory: noChange ? memory : { ...memory, project_id: project.id },
    project,
    receipt: null,
  };
}

export function applyMemoryProjectLink(
  memoryId: string,
  request: MemoryProjectLinkRequest,
  db?: Database,
): MemoryProjectLinkResult {
  assertForwardRequest(request);
  assertBoundedIdentifier(memoryId, "memory_id");
  if (!db && isApiMode()) {
    const { data } = apiJson<MemoryProjectLinkResult>(
      "POST",
      `/memories/${encodeURIComponent(memoryId)}/guarded-project-link`,
      { ...request, dry_run: false },
    );
    return data;
  }
  const d = db || getDatabase();
  const requestDigest = forwardRequestDigest(memoryId, request);

  return d.transaction(() => {
    const prior = findReceiptByKey(d, request, "forward", request.idempotency_key);
    if (prior) return replayResult(d, prior, requestDigest, memoryId);

    const before = getMemoryByExactId(memoryId, d, true);
    if (!before) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND",
        `Memory not found by exact stable ID: ${memoryId}`,
      );
    }
    // A same-key PostgreSQL retry can begin before the first transaction
    // commits, miss its receipt, and then wait here on the memory row lock.
    // Re-read after acquiring the lock so that retry becomes a stable replay
    // instead of a spurious stale-memory rejection.
    const committedPrior = findReceiptByKey(
      d,
      request,
      "forward",
      request.idempotency_key,
    );
    if (committedPrior) return replayResult(d, committedPrior, requestDigest, memoryId);
    assertMemoryPrecondition(before, request.expected_memory_version, request.expected_memory_revision);

    const projects = lockProjects([before.project_id, request.target_project_id], d);
    const targetProject = projects.get(request.target_project_id)!;
    const beforeProject = before.project_id ? projects.get(before.project_id)! : null;
    assertProjectPrecondition(targetProject, request.expected_project_revision);

    const noChange = before.project_id === request.target_project_id;
    if (noChange) {
      const receipt = makeReceipt({
        request,
        direction: "forward",
        requestDigest,
        outcome: "no_change",
        targetMemoryId: memoryId,
        requestedProjectId: request.target_project_id,
        expectedProjectRevision: request.expected_project_revision,
        beforeMemory: before,
        afterMemory: before,
        beforeProject,
        afterProject: targetProject,
      });
      insertReceipt(d, receipt);
      return {
        dry_run: false,
        applied: false,
        no_change: true,
        memory: before,
        project: targetProject,
        receipt,
      };
    }

    assertNoTargetBucketCollision(before, targetProject.id, d);
    const revision = nextRevision(before.updated_at);
    const result = d.run(`
      UPDATE memories
      SET project_id = ?, updated_at = ?
      WHERE id = ? AND version = ? AND updated_at = ?
        AND COALESCE(project_id, '') = COALESCE(?, '')
    `, [
      targetProject.id,
      revision,
      memoryId,
      before.version,
      before.updated_at,
      before.project_id,
    ]);
    // SQLite's FTS triggers contribute to Bun's reported change count, while
    // PostgreSQL reports only the row count for the guarded UPDATE. Zero is
    // the only portable signal that the compare-and-swap predicate missed.
    if (result.changes === 0) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_STALE_MEMORY",
        "Memory project-link compare-and-swap did not update exactly one row",
      );
    }
    const after = getMemoryByExactId(memoryId, d);
    const expectedAfter = { ...before, project_id: targetProject.id, updated_at: revision };
    if (!after || canonicalJson(memoryMutationState(after)) !== canonicalJson(memoryMutationState(expectedAfter))) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_ACCEPTED_TARGET_DRIFTED",
        "Memory project link did not read back exactly under the stable ID",
      );
    }
    const receipt = makeReceipt({
      request,
      direction: "forward",
      requestDigest,
      outcome: "accepted",
      targetMemoryId: memoryId,
      requestedProjectId: request.target_project_id,
      expectedProjectRevision: request.expected_project_revision,
      beforeMemory: before,
      afterMemory: after,
      beforeProject,
      afterProject: targetProject,
    });
    insertReceipt(d, receipt);
    return {
      dry_run: false,
      applied: true,
      no_change: false,
      memory: after,
      project: targetProject,
      receipt,
    };
  });
}

export function rollbackMemoryProjectLink(
  memoryId: string,
  request: MemoryProjectLinkRollbackRequest,
  db?: Database,
): MemoryProjectLinkResult {
  assertRollbackRequest(request);
  assertBoundedIdentifier(memoryId, "memory_id");
  if (!db && isApiMode()) {
    const { data } = apiJson<MemoryProjectLinkResult>(
      "POST",
      `/memories/${encodeURIComponent(memoryId)}/guarded-project-link-rollback`,
      request,
    );
    return data;
  }
  const d = db || getDatabase();
  const requestDigest = rollbackRequestDigest(memoryId, request);

  return d.transaction(() => {
    const prior = findReceiptByKey(d, request, "rollback", request.idempotency_key);
    if (prior) return replayResult(d, prior, requestDigest, memoryId);

    const accepted = findReceiptById(d, request, request.accepted_receipt_id);
    if (!accepted || accepted.direction !== "forward" || accepted.target_memory_id !== memoryId) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_RECEIPT_NOT_FOUND",
        "accepted forward link receipt was not found for this exact memory",
      );
    }
    if (accepted.outcome !== "accepted") {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_RECEIPT_NOT_ROLLBACKABLE",
        "a no-change memory project-link receipt has no mutation to roll back",
      );
    }

    const current = getMemoryByExactId(memoryId, d, true);
    if (!current) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND",
        `Memory not found by exact stable ID: ${memoryId}`,
      );
    }
    const committedPrior = findReceiptByKey(
      d,
      request,
      "rollback",
      request.idempotency_key,
    );
    if (committedPrior) return replayResult(d, committedPrior, requestDigest, memoryId);
    assertMemoryPrecondition(current, request.expected_memory_version, request.expected_memory_revision);
    if (!sameSnapshot(current, accepted.after_link)) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_STALE_MEMORY",
        "Memory no longer matches the accepted forward link receipt",
      );
    }

    const projects = lockProjects(
      [accepted.after_link.project_id, accepted.before_link.project_id],
      d,
    );
    const beforeProject = accepted.after_link.project_id
      ? projects.get(accepted.after_link.project_id)!
      : null;
    const afterProject = accepted.before_link.project_id
      ? projects.get(accepted.before_link.project_id)!
      : null;
    assertProjectSnapshot(
      beforeProject,
      accepted.after_project_revision,
      accepted.after_project_digest,
    );
    assertProjectSnapshot(
      afterProject,
      accepted.before_project_revision,
      accepted.before_project_digest,
    );
    assertNoTargetBucketCollision(current, accepted.before_link.project_id, d);

    const result = d.run(`
      UPDATE memories
      SET project_id = ?, updated_at = ?
      WHERE id = ? AND version = ? AND updated_at = ?
        AND COALESCE(project_id, '') = COALESCE(?, '')
    `, [
      accepted.before_link.project_id,
      accepted.before_link.memory_revision,
      memoryId,
      current.version,
      current.updated_at,
      current.project_id,
    ]);
    if (result.changes === 0) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_STALE_MEMORY",
        "Memory project-link rollback compare-and-swap did not update exactly one row",
      );
    }
    const restored = getMemoryByExactId(memoryId, d);
    if (!restored || !sameSnapshot(restored, accepted.before_link)) {
      throw new MemoryProjectLinkError(
        "MEMORY_PROJECT_LINK_ACCEPTED_TARGET_DRIFTED",
        "Memory project-link rollback did not restore the exact prior linkage",
      );
    }
    const receipt = makeReceipt({
      request,
      direction: "rollback",
      requestDigest,
      outcome: "accepted",
      targetMemoryId: memoryId,
      requestedProjectId: accepted.requested_project_id,
      expectedProjectRevision: null,
      beforeMemory: current,
      afterMemory: restored,
      beforeProject,
      afterProject,
      acceptedReceiptId: accepted.receipt_id,
    });
    insertReceipt(d, receipt);
    return {
      dry_run: false,
      applied: true,
      no_change: false,
      memory: restored,
      project: afterProject,
      receipt,
    };
  });
}

export function getMemoryProjectLinkReceipt(
  memoryId: string,
  receiptId: string,
  identity: ProjectAuthorityIdentity = LINK_AUTHORITY,
  db?: Database,
): MemoryProjectLinkReceipt {
  assertIdentity(identity);
  assertBoundedIdentifier(memoryId, "memory_id");
  assertBoundedIdentifier(receiptId, "receipt_id");
  if (!db && isApiMode()) {
    const { data } = apiJson<MemoryProjectLinkReceipt>(
      "POST",
      `/memories/${encodeURIComponent(memoryId)}/project-link-receipts/lookup`,
      { ...identity, receipt_id: receiptId },
    );
    return data;
  }
  const d = db || getDatabase();
  const receipt = findReceiptById(d, identity, receiptId);
  if (!receipt || receipt.target_memory_id !== memoryId) {
    throw new MemoryProjectLinkError(
      "MEMORY_PROJECT_LINK_RECEIPT_NOT_FOUND",
      "immutable memory project-link receipt was not found for this exact memory",
    );
  }
  return receipt;
}
