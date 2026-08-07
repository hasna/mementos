import { SqliteAdapter as Database } from "../storage.js";
import { createHash } from "node:crypto";
import type {
  Project,
  ProjectAuthorityIdentity,
  ProjectGuardedRollbackRequest,
  ProjectGuardedUpdateRequest,
  ProjectGuardedUpdateResult,
  ProjectUpdateReceipt,
  UpdateProjectInput,
} from "../types/index.js";
import { getDatabase, now, uuid } from "./database.js";
import { isApiMode, apiJson } from "./api-mode.js";
import { getMementosPackageVersion } from "../lib/package-version.js";
import { MEMENTOS_PROJECT_GUARDED_UPDATE_ROUTE } from "../project-registration/types.js";

function parseProjectRow(row: Record<string, unknown>): Project {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    path: row["path"] as string,
    description: (row["description"] as string) || null,
    memory_prefix: (row["memory_prefix"] as string) || null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export class ProjectCollisionError extends Error {
  constructor(
    public readonly field: "name" | "path",
    public readonly value: string
  ) {
    super(`Project ${field} already exists: ${value}`);
    this.name = "ProjectCollisionError";
  }
}

export type ProjectGuardedUpdateErrorCode =
  | "PROJECT_UPDATE_INVALID_INPUT"
  | "PROJECT_UPDATE_AUTHORITY_MISMATCH"
  | "PROJECT_UPDATE_NOT_FOUND"
  | "PROJECT_UPDATE_STALE_REVISION"
  | "PROJECT_UPDATE_COLLISION"
  | "PROJECT_UPDATE_IDEMPOTENCY_MISMATCH"
  | "PROJECT_UPDATE_RECEIPT_NOT_FOUND"
  | "PROJECT_UPDATE_ACCEPTED_TARGET_DRIFTED";

export class ProjectGuardedUpdateError extends Error {
  constructor(
    public readonly code: ProjectGuardedUpdateErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ProjectGuardedUpdateError";
  }
}

const PROJECT_UPDATE_AUTHORITY: ProjectAuthorityIdentity = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
};
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function canonicalizeProjectUpdateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeProjectUpdateValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) output[key] = canonicalizeProjectUpdateValue(item);
  }
  return output;
}

function canonicalProjectUpdateJson(value: unknown): string {
  return JSON.stringify(canonicalizeProjectUpdateValue(value));
}

function digestProjectUpdateValue(value: unknown): string {
  return createHash("sha256").update(canonicalProjectUpdateJson(value)).digest("hex");
}

function timestampString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function parseProjectJson(value: unknown): Project {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return parsed as Project;
}

function projectUpdateReceiptFromRow(row: Record<string, unknown>): ProjectUpdateReceipt {
  return {
    receipt_id: String(row["receipt_id"]),
    authority: "mementos",
    route: MEMENTOS_PROJECT_GUARDED_UPDATE_ROUTE,
    package_version: String(row["package_version"]),
    authority_id: String(row["authority_id"]),
    tenant_id: String(row["tenant_id"]),
    corpus_id: String(row["corpus_id"]),
    operation_id: String(row["operation_id"]),
    step_id: String(row["step_id"]),
    direction: row["direction"] as "forward" | "rollback",
    idempotency_key: String(row["idempotency_key"]),
    request_digest: String(row["request_digest"]),
    outcome: "accepted",
    target_id: String(row["target_id"]),
    expected_revision: timestampString(row["expected_revision"]),
    result_revision: timestampString(row["result_revision"]),
    result_digest: String(row["result_digest"]),
    accepted_receipt_id: row["accepted_receipt_id"] === null
      ? null
      : String(row["accepted_receipt_id"]),
    before_project: parseProjectJson(row["before_project_json"]),
    after_project: parseProjectJson(row["after_project_json"]),
    created_at: timestampString(row["created_at"]),
  };
}

function normalizeProjectUpdateInput(input: UpdateProjectInput): UpdateProjectInput {
  const normalized: UpdateProjectInput = {};
  if (input.name !== undefined) normalized.name = input.name.trim();
  if (input.path !== undefined) normalized.path = input.path.trim();
  if (input.description !== undefined) normalized.description = input.description;
  if (input.memory_prefix !== undefined) normalized.memory_prefix = input.memory_prefix;
  if (Object.keys(normalized).length === 0) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_INVALID_INPUT",
      "At least one project field must be provided",
    );
  }
  if (normalized.name !== undefined && normalized.name.length === 0) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_INVALID_INPUT",
      "Project name cannot be empty",
    );
  }
  if (normalized.path !== undefined && normalized.path.length === 0) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_INVALID_INPUT",
      "Project path cannot be empty",
    );
  }
  return normalized;
}

function assertProjectUpdateIdentity(identity: ProjectAuthorityIdentity): void {
  if (
    identity.authority_id !== PROJECT_UPDATE_AUTHORITY.authority_id
    || identity.tenant_id !== PROJECT_UPDATE_AUTHORITY.tenant_id
    || identity.corpus_id !== PROJECT_UPDATE_AUTHORITY.corpus_id
  ) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_AUTHORITY_MISMATCH",
      "guarded project update does not match this authority, tenant, and corpus",
    );
  }
}

function assertBoundedIdentifier(value: string, field: string): void {
  if (!BOUNDED_IDENTIFIER.test(value)) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_INVALID_INPUT",
      `${field} must be an 8-128 character bounded identifier`,
    );
  }
}

function assertProjectUpdateRequest(
  request: ProjectGuardedUpdateRequest | ProjectGuardedRollbackRequest,
): void {
  assertProjectUpdateIdentity(request);
  assertBoundedIdentifier(request.operation_id, "operation_id");
  assertBoundedIdentifier(request.step_id, "step_id");
  assertBoundedIdentifier(request.idempotency_key, "idempotency_key");
  if (!request.expected_revision || request.expected_revision.length > 128) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_INVALID_INPUT",
      "expected_revision is required and must be bounded",
    );
  }
}

function getProjectByExactId(id: string, db: Database): Project | null {
  const row = db.query("SELECT * FROM projects WHERE id = ? LIMIT 1").get(id) as
    | Record<string, unknown>
    | null;
  return row ? parseProjectRow(row) : null;
}

function assertNoProjectCollision(
  id: string,
  input: UpdateProjectInput,
  db: Database,
): void {
  if (input.name !== undefined) {
    const collision = db.query(
      "SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id != ? LIMIT 1",
    ).get(input.name, id) as Record<string, unknown> | null;
    if (collision) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_COLLISION",
        `Project name already exists: ${input.name}`,
        { field: "name" },
      );
    }
  }
  if (input.path !== undefined) {
    const collision = db.query(
      "SELECT id FROM projects WHERE path = ? AND id != ? LIMIT 1",
    ).get(input.path, id) as Record<string, unknown> | null;
    if (collision) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_COLLISION",
        `Project path already exists: ${input.path}`,
        { field: "path" },
      );
    }
  }
}

function nextProjectRevision(previous: string): string {
  const candidate = now();
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  if (Number.isFinite(previousMs) && Number.isFinite(candidateMs) && candidateMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return candidate;
}

function projectWithUpdates(
  project: Project,
  updates: UpdateProjectInput,
  revision: string,
): Project {
  return {
    ...project,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.path !== undefined ? { path: updates.path } : {}),
    ...(updates.description !== undefined ? { description: updates.description } : {}),
    ...(updates.memory_prefix !== undefined ? { memory_prefix: updates.memory_prefix } : {}),
    updated_at: revision,
  };
}

function findProjectUpdateReceiptByKey(
  db: Database,
  identity: ProjectAuthorityIdentity,
  direction: "forward" | "rollback",
  idempotencyKey: string,
): ProjectUpdateReceipt | null {
  const row = db.query(`
    SELECT * FROM mementos_project_update_receipts
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
  return row ? projectUpdateReceiptFromRow(row) : null;
}

function findProjectUpdateReceiptById(
  db: Database,
  identity: ProjectAuthorityIdentity,
  receiptId: string,
): ProjectUpdateReceipt | null {
  const row = db.query(`
    SELECT * FROM mementos_project_update_receipts
    WHERE receipt_id = ? AND authority_id = ? AND tenant_id = ? AND corpus_id = ?
    LIMIT 1
  `).get(
    receiptId,
    identity.authority_id,
    identity.tenant_id,
    identity.corpus_id,
  ) as Record<string, unknown> | null;
  return row ? projectUpdateReceiptFromRow(row) : null;
}

function insertProjectUpdateReceipt(db: Database, receipt: ProjectUpdateReceipt): void {
  db.run(`
    INSERT INTO mementos_project_update_receipts (
      receipt_id, authority, route, package_version, authority_id, tenant_id,
      corpus_id, operation_id, step_id, direction, idempotency_key,
      request_digest, outcome, target_id, expected_revision, result_revision,
      result_digest, accepted_receipt_id, before_project_json,
      after_project_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    receipt.target_id,
    receipt.expected_revision,
    receipt.result_revision,
    receipt.result_digest,
    receipt.accepted_receipt_id,
    canonicalProjectUpdateJson(receipt.before_project),
    canonicalProjectUpdateJson(receipt.after_project),
    receipt.created_at,
  ]);
}

function makeProjectUpdateReceipt(input: {
  request: ProjectGuardedUpdateRequest | ProjectGuardedRollbackRequest;
  direction: "forward" | "rollback";
  request_digest: string;
  target_id: string;
  before_project: Project;
  after_project: Project;
  accepted_receipt_id?: string | null;
}): ProjectUpdateReceipt {
  const createdAt = now();
  const logical = {
    authority: "mementos" as const,
    route: MEMENTOS_PROJECT_GUARDED_UPDATE_ROUTE,
    package_version: getMementosPackageVersion(),
    authority_id: input.request.authority_id,
    tenant_id: input.request.tenant_id,
    corpus_id: input.request.corpus_id,
    operation_id: input.request.operation_id,
    step_id: input.request.step_id,
    direction: input.direction,
    idempotency_key: input.request.idempotency_key,
    request_digest: input.request_digest,
    outcome: "accepted" as const,
    target_id: input.target_id,
    expected_revision: input.request.expected_revision,
    result_revision: input.after_project.updated_at,
    result_digest: digestProjectUpdateValue(input.after_project),
    accepted_receipt_id: input.accepted_receipt_id ?? null,
    before_project: input.before_project,
    after_project: input.after_project,
    created_at: createdAt,
  };
  return {
    receipt_id: `mpur_${digestProjectUpdateValue(logical).slice(0, 40)}`,
    ...logical,
  };
}

export function registerProject(
  name: string,
  path: string,
  description?: string,
  memoryPrefix?: string,
  db?: Database
): Project {
  if (!db && isApiMode()) {
    const { data } = apiJson<Project>("POST", "/projects", {
      name,
      path,
      description,
      memory_prefix: memoryPrefix,
    });
    return data;
  }
  const d = db || getDatabase();
  const timestamp = now();

  // Idempotent: same path returns existing
  const existing = d
    .query("SELECT * FROM projects WHERE path = ?")
    .get(path) as Record<string, unknown> | null;

  if (existing) {
    const existingId = existing["id"] as string;
    d.run("UPDATE projects SET updated_at = ? WHERE id = ?", [
      timestamp,
      existingId,
    ]);
    return parseProjectRow(existing);
  }

  const id = uuid();
  d.run(
    "INSERT INTO projects (id, name, path, description, memory_prefix, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, name, path, description || null, memoryPrefix || null, timestamp, timestamp]
  );

  return getProject(id, d)!;
}

export function getProject(
  idOrPath: string,
  db?: Database
): Project | null {
  if (!db && isApiMode()) {
    const { status, data } = apiJson<Project>("GET", `/projects/${encodeURIComponent(idOrPath)}`, undefined, { allow404: true });
    if (status === 404 || !data) return null;
    return data;
  }
  const d = db || getDatabase();

  let row = d.query("SELECT * FROM projects WHERE id = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  row = d.query("SELECT * FROM projects WHERE path = ?").get(idOrPath) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  // Try by name (case-insensitive)
  row = d.query("SELECT * FROM projects WHERE LOWER(name) = ?").get(idOrPath.toLowerCase()) as
    | Record<string, unknown>
    | null;
  if (row) return parseProjectRow(row);

  return null;
}

export function listProjects(db?: Database): Project[] {
  if (!db && isApiMode()) {
    const { data } = apiJson<{ projects: Project[] }>("GET", "/projects");
    return data?.projects ?? [];
  }
  const d = db || getDatabase();
  const rows = d
    .query("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map(parseProjectRow);
}

export function previewProjectUpdate(
  id: string,
  request: ProjectGuardedUpdateRequest,
  db?: Database,
): ProjectGuardedUpdateResult {
  assertProjectUpdateRequest(request);
  const normalized = normalizeProjectUpdateInput(request.updates);
  if (!db && isApiMode()) {
    const { data } = apiJson<ProjectGuardedUpdateResult>(
      "POST",
      `/projects/${encodeURIComponent(id)}/guarded-update`,
      { ...request, updates: normalized, dry_run: true },
    );
    return data;
  }
  const d = db || getDatabase();
  const project = getProjectByExactId(id, d);
  if (!project) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_NOT_FOUND",
      `Project not found by exact stable ID: ${id}`,
    );
  }
  if (project.updated_at !== request.expected_revision) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_STALE_REVISION",
      "Project revision changed before the guarded update dry run",
      { expected_revision: request.expected_revision, current_revision: project.updated_at },
    );
  }
  assertNoProjectCollision(id, normalized, d);
  return {
    dry_run: true,
    applied: false,
    project: projectWithUpdates(project, normalized, project.updated_at),
    receipt: null,
  };
}

export function applyProjectUpdate(
  id: string,
  request: ProjectGuardedUpdateRequest,
  db?: Database,
): ProjectGuardedUpdateResult {
  assertProjectUpdateRequest(request);
  const normalized = normalizeProjectUpdateInput(request.updates);
  if (!db && isApiMode()) {
    const { data } = apiJson<ProjectGuardedUpdateResult>(
      "POST",
      `/projects/${encodeURIComponent(id)}/guarded-update`,
      { ...request, updates: normalized, dry_run: false },
    );
    return data;
  }
  const d = db || getDatabase();
  const requestDigest = digestProjectUpdateValue({
    ...request,
    target_id: id,
    direction: "forward",
    updates: normalized,
  });
  return d.transaction(() => {
    const prior = findProjectUpdateReceiptByKey(d, request, "forward", request.idempotency_key);
    if (prior) {
      if (prior.request_digest !== requestDigest || prior.target_id !== id) {
        throw new ProjectGuardedUpdateError(
          "PROJECT_UPDATE_IDEMPOTENCY_MISMATCH",
          "caller idempotency key is already bound to a different request",
        );
      }
      const current = getProjectByExactId(id, d);
      if (!current || canonicalProjectUpdateJson(current) !== canonicalProjectUpdateJson(prior.after_project)) {
        throw new ProjectGuardedUpdateError(
          "PROJECT_UPDATE_ACCEPTED_TARGET_DRIFTED",
          "accepted guarded update target drifted after its immutable receipt",
        );
      }
      return { dry_run: false, applied: true, project: prior.after_project, receipt: prior };
    }

    const before = getProjectByExactId(id, d);
    if (!before) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_NOT_FOUND",
        `Project not found by exact stable ID: ${id}`,
      );
    }
    if (before.updated_at !== request.expected_revision) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_STALE_REVISION",
        "Project revision changed before the guarded update",
        { expected_revision: request.expected_revision, current_revision: before.updated_at },
      );
    }
    assertNoProjectCollision(id, normalized, d);
    const revision = nextProjectRevision(before.updated_at);
    const after = projectWithUpdates(before, normalized, revision);
    const result = d.run(`
      UPDATE projects
      SET name = ?, path = ?, description = ?, memory_prefix = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `, [
      after.name,
      after.path,
      after.description,
      after.memory_prefix,
      after.updated_at,
      id,
      request.expected_revision,
    ]);
    if (result.changes !== 1) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_STALE_REVISION",
        "Project compare-and-swap did not update exactly one row",
      );
    }
    const readback = getProjectByExactId(id, d);
    if (!readback || canonicalProjectUpdateJson(readback) !== canonicalProjectUpdateJson(after)) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_ACCEPTED_TARGET_DRIFTED",
        "Project guarded update did not read back exactly under the stable ID",
      );
    }
    const receipt = makeProjectUpdateReceipt({
      request: { ...request, updates: normalized },
      direction: "forward",
      request_digest: requestDigest,
      target_id: id,
      before_project: before,
      after_project: readback,
    });
    insertProjectUpdateReceipt(d, receipt);
    return { dry_run: false, applied: true, project: readback, receipt };
  });
}

export function rollbackProjectUpdate(
  id: string,
  request: ProjectGuardedRollbackRequest,
  db?: Database,
): ProjectGuardedUpdateResult {
  assertProjectUpdateRequest(request);
  assertBoundedIdentifier(request.accepted_receipt_id, "accepted_receipt_id");
  if (!db && isApiMode()) {
    const { data } = apiJson<ProjectGuardedUpdateResult>(
      "POST",
      `/projects/${encodeURIComponent(id)}/guarded-rollback`,
      request,
    );
    return data;
  }
  const d = db || getDatabase();
  const requestDigest = digestProjectUpdateValue({
    ...request,
    target_id: id,
    direction: "rollback",
  });
  return d.transaction(() => {
    const prior = findProjectUpdateReceiptByKey(d, request, "rollback", request.idempotency_key);
    if (prior) {
      if (prior.request_digest !== requestDigest || prior.target_id !== id) {
        throw new ProjectGuardedUpdateError(
          "PROJECT_UPDATE_IDEMPOTENCY_MISMATCH",
          "caller idempotency key is already bound to a different rollback request",
        );
      }
      const current = getProjectByExactId(id, d);
      if (!current || canonicalProjectUpdateJson(current) !== canonicalProjectUpdateJson(prior.after_project)) {
        throw new ProjectGuardedUpdateError(
          "PROJECT_UPDATE_ACCEPTED_TARGET_DRIFTED",
          "accepted rollback target drifted after its immutable receipt",
        );
      }
      return { dry_run: false, applied: true, project: prior.after_project, receipt: prior };
    }

    const accepted = findProjectUpdateReceiptById(d, request, request.accepted_receipt_id);
    if (!accepted || accepted.direction !== "forward" || accepted.target_id !== id) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_RECEIPT_NOT_FOUND",
        "accepted forward update receipt was not found for this exact project",
      );
    }
    const current = getProjectByExactId(id, d);
    if (!current) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_NOT_FOUND",
        `Project not found by exact stable ID: ${id}`,
      );
    }
    if (
      current.updated_at !== request.expected_revision
      || canonicalProjectUpdateJson(current) !== canonicalProjectUpdateJson(accepted.after_project)
    ) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_STALE_REVISION",
        "Project no longer matches the accepted forward receipt",
        { expected_revision: request.expected_revision, current_revision: current.updated_at },
      );
    }
    assertNoProjectCollision(id, accepted.before_project, d);
    const restored = accepted.before_project;
    const result = d.run(`
      UPDATE projects
      SET name = ?, path = ?, description = ?, memory_prefix = ?,
          created_at = ?, updated_at = ?
      WHERE id = ? AND updated_at = ?
    `, [
      restored.name,
      restored.path,
      restored.description,
      restored.memory_prefix,
      restored.created_at,
      restored.updated_at,
      id,
      request.expected_revision,
    ]);
    if (result.changes !== 1) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_STALE_REVISION",
        "Project rollback compare-and-swap did not update exactly one row",
      );
    }
    const readback = getProjectByExactId(id, d);
    if (!readback || canonicalProjectUpdateJson(readback) !== canonicalProjectUpdateJson(restored)) {
      throw new ProjectGuardedUpdateError(
        "PROJECT_UPDATE_ACCEPTED_TARGET_DRIFTED",
        "Project rollback did not restore the exact prior row",
      );
    }
    const receipt = makeProjectUpdateReceipt({
      request,
      direction: "rollback",
      request_digest: requestDigest,
      target_id: id,
      before_project: current,
      after_project: readback,
      accepted_receipt_id: accepted.receipt_id,
    });
    insertProjectUpdateReceipt(d, receipt);
    return { dry_run: false, applied: true, project: readback, receipt };
  });
}

export function getProjectUpdateReceipt(
  id: string,
  receiptId: string,
  identity: ProjectAuthorityIdentity = PROJECT_UPDATE_AUTHORITY,
  db?: Database,
): ProjectUpdateReceipt {
  assertProjectUpdateIdentity(identity);
  if (!db && isApiMode()) {
    const { data } = apiJson<ProjectUpdateReceipt>(
      "POST",
      `/projects/${encodeURIComponent(id)}/update-receipts/lookup`,
      { ...identity, receipt_id: receiptId },
    );
    return data;
  }
  const d = db || getDatabase();
  const receipt = findProjectUpdateReceiptById(d, identity, receiptId);
  if (!receipt || receipt.target_id !== id) {
    throw new ProjectGuardedUpdateError(
      "PROJECT_UPDATE_RECEIPT_NOT_FOUND",
      "immutable project update receipt was not found for this exact project",
    );
  }
  return receipt;
}

/**
 * Package-internal compatibility helper for old tests and migrations.
 * Public callers use applyProjectUpdate so every mutation is CAS-guarded and
 * receipt-backed; this helper is intentionally not exported from src/index.ts.
 */
export function updateProject(
  id: string,
  input: UpdateProjectInput,
  db?: Database
): Project | null {
  let normalizedInput: UpdateProjectInput;
  try {
    normalizedInput = normalizeProjectUpdateInput(input);
  } catch (error) {
    if (error instanceof ProjectGuardedUpdateError) throw new Error(error.message);
    throw error;
  }

  if (!db && isApiMode()) {
    const { status, data } = apiJson<Project>(
      "PATCH",
      `/projects/${encodeURIComponent(id)}`,
      normalizedInput,
      { allow404: true }
    );
    if (status === 404 || !data) return null;
    if (data.id !== id) {
      throw new Error(
        `Project update did not persist for ${id}: server returned a different stable ID (${data.id})`
      );
    }
    for (const field of ["name", "path", "description", "memory_prefix"] as const) {
      if (normalizedInput[field] !== undefined && data[field] !== normalizedInput[field]) {
        throw new Error(
          `Project update did not persist for ${id}: ${field} remained ${JSON.stringify(data[field])}`
        );
      }
    }
    return data;
  }

  const d = db || getDatabase();
  return d.transaction(() => {
    const existingRow = d.query("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | null;
    if (!existingRow) return null;

    const existing = parseProjectRow(existingRow);
    const nextName = normalizedInput.name;
    const nextPath = normalizedInput.path;

    if (nextName !== undefined) {
      const collision = d
        .query("SELECT id FROM projects WHERE LOWER(name) = LOWER(?) AND id != ?")
        .get(nextName, existing.id) as Record<string, unknown> | null;
      if (collision) throw new ProjectCollisionError("name", nextName);
    }
    if (nextPath !== undefined) {
      const collision = d
        .query("SELECT id FROM projects WHERE path = ? AND id != ?")
        .get(nextPath, existing.id) as Record<string, unknown> | null;
      if (collision) throw new ProjectCollisionError("path", nextPath);
    }

    const sets = ["updated_at = ?"];
    const values: unknown[] = [now()];
    if (nextName !== undefined) {
      sets.push("name = ?");
      values.push(nextName);
    }
    if (nextPath !== undefined) {
      sets.push("path = ?");
      values.push(nextPath);
    }
    if (normalizedInput.description !== undefined) {
      sets.push("description = ?");
      values.push(normalizedInput.description);
    }
    if (normalizedInput.memory_prefix !== undefined) {
      sets.push("memory_prefix = ?");
      values.push(normalizedInput.memory_prefix);
    }
    values.push(existing.id);

    d.run(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`, values);
    const updated = d.query("SELECT * FROM projects WHERE id = ?").get(existing.id) as
      | Record<string, unknown>
      | null;
    return updated ? parseProjectRow(updated) : null;
  });
}
