process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "./database.js";
import {
  createMemory,
  getMemory,
  getMemoryVersions,
  updateMemory,
} from "./memories.js";
import { registerProject, updateProject } from "./projects.js";
import {
  applyMemoryProjectLink,
  getMemoryProjectLinkReceipt,
  MemoryProjectLinkError,
  previewMemoryProjectLink,
  rollbackMemoryProjectLink,
} from "./memory-project-link.js";

const IDENTITY = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
} as const;

function requestFor(
  memory: NonNullable<ReturnType<typeof getMemory>>,
  project: ReturnType<typeof registerProject>,
  idempotencyKey: string,
) {
  return {
    ...IDENTITY,
    operation_id: "dubai-memory-project-link-v1",
    step_id: "mementos_memory_project_link",
    idempotency_key: idempotencyKey,
    expected_memory_version: memory.version,
    expected_memory_revision: memory.updated_at,
    target_project_id: project.id,
    expected_project_revision: project.updated_at,
  };
}

function expectLinkError(action: () => unknown, code: MemoryProjectLinkError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(MemoryProjectLinkError);
  expect(caught).toMatchObject({ code });
}

beforeEach(() => {
  resetDatabase();
});

describe("guarded existing-memory project linkage", () => {
  test("dry-run is read-only; apply preserves identity/content/history; replay is stable", () => {
    const project = registerProject("Dubai Fraud", "/projects/dubai-fraud");
    const original = createMemory({
      key: "conversations-bulk-linkage-lock-race-2026-08-07",
      value: "stable evidence",
      category: "knowledge",
      scope: "shared",
      importance: 9,
      tags: ["dubai", "evidence"],
      metadata: { source: "incident" },
    });
    const historyBefore = getMemoryVersions(original.id);
    const request = requestFor(original, project, "dubai-memory-project-link-request-0001");

    const preview = previewMemoryProjectLink(original.id, request);
    expect(preview).toMatchObject({
      dry_run: true,
      applied: false,
      no_change: false,
      receipt: null,
      memory: { id: original.id, project_id: project.id },
      project: { id: project.id, updated_at: project.updated_at },
    });
    expect(getMemory(original.id)).toEqual(original);
    expect(getMemoryVersions(original.id)).toEqual(historyBefore);

    const accepted = applyMemoryProjectLink(original.id, request);
    expect(accepted).toMatchObject({
      dry_run: false,
      applied: true,
      no_change: false,
      memory: {
        id: original.id,
        key: original.key,
        value: original.value,
        project_id: project.id,
        version: original.version,
      },
      receipt: {
        direction: "forward",
        outcome: "accepted",
        target_memory_id: original.id,
        requested_project_id: project.id,
        before_link: {
          memory_id: original.id,
          project_id: null,
          memory_version: original.version,
          memory_revision: original.updated_at,
        },
        after_link: {
          memory_id: original.id,
          project_id: project.id,
          memory_version: original.version,
        },
      },
    });
    expect(accepted.receipt?.after_link.memory_revision).toBe(accepted.memory.updated_at);
    expect(accepted.receipt?.result_memory_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.receipt?.result_project_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(getMemoryVersions(original.id)).toEqual(historyBefore);
    expect(applyMemoryProjectLink(original.id, request)).toEqual(accepted);
    expect(getMemoryProjectLinkReceipt(
      original.id,
      accepted.receipt!.receipt_id,
      IDENTITY,
    )).toEqual(accepted.receipt);
  });

  test("no-change apply emits an immutable deterministic receipt without mutating the memory", () => {
    const project = registerProject("Dubai Fraud", "/projects/dubai-fraud");
    const memory = createMemory({
      key: "already-linked",
      value: "unchanged",
      project_id: project.id,
      scope: "shared",
    });
    const request = requestFor(memory, project, "dubai-memory-project-link-no-change-0001");

    expect(previewMemoryProjectLink(memory.id, request)).toMatchObject({
      dry_run: true,
      applied: false,
      no_change: true,
      receipt: null,
      memory,
    });
    const result = applyMemoryProjectLink(memory.id, request);
    expect(result).toMatchObject({
      applied: false,
      no_change: true,
      memory,
      receipt: {
        outcome: "no_change",
        before_link: { project_id: project.id },
        after_link: { project_id: project.id },
      },
    });
    expect(getMemory(memory.id)).toEqual(memory);
    expect(applyMemoryProjectLink(memory.id, request)).toEqual(result);
    expectLinkError(() => rollbackMemoryProjectLink(memory.id, {
      ...IDENTITY,
      operation_id: "dubai-memory-project-link-v1",
      step_id: "mementos_memory_project_link_rollback",
      idempotency_key: "dubai-memory-project-link-no-change-rollback-0001",
      expected_memory_version: memory.version,
      expected_memory_revision: memory.updated_at,
      accepted_receipt_id: result.receipt!.receipt_id,
    }), "MEMORY_PROJECT_LINK_RECEIPT_NOT_ROLLBACKABLE");
  });

  test("unknown IDs, tenant mismatch, stale revisions, and caller-key mismatch fail closed", () => {
    const project = registerProject("Dubai Fraud", "/projects/dubai-fraud");
    const memory = createMemory({ key: "unlinked", value: "stable", scope: "shared" });
    const before = getMemory(memory.id);
    const base = requestFor(memory, project, "dubai-memory-project-link-reject-0001");

    expectLinkError(() => applyMemoryProjectLink("missing-memory", base), "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND");
    expectLinkError(() => applyMemoryProjectLink(memory.id, {
      ...base,
      target_project_id: "missing-project",
      idempotency_key: "dubai-memory-project-link-missing-project-0001",
    }), "MEMORY_PROJECT_LINK_PROJECT_NOT_FOUND");
    expectLinkError(() => applyMemoryProjectLink(memory.id, {
      ...base,
      tenant_id: "other-tenant",
      idempotency_key: "dubai-memory-project-link-other-tenant-0001",
    }), "MEMORY_PROJECT_LINK_AUTHORITY_MISMATCH");
    expectLinkError(() => applyMemoryProjectLink(memory.id, {
      ...base,
      expected_memory_revision: "2026-01-01T00:00:00.000Z",
      idempotency_key: "dubai-memory-project-link-stale-memory-0001",
    }), "MEMORY_PROJECT_LINK_STALE_MEMORY");
    expectLinkError(() => applyMemoryProjectLink(memory.id, {
      ...base,
      expected_project_revision: "2026-01-01T00:00:00.000Z",
      idempotency_key: "dubai-memory-project-link-stale-project-0001",
    }), "MEMORY_PROJECT_LINK_STALE_PROJECT");

    const accepted = applyMemoryProjectLink(memory.id, base);
    expectLinkError(() => applyMemoryProjectLink(memory.id, {
      ...base,
      target_project_id: registerProject("Other", "/projects/other").id,
    }), "MEMORY_PROJECT_LINK_IDEMPOTENCY_MISMATCH");
    expect(getMemory(memory.id)).toEqual(accepted.memory);
    expect(before?.project_id).toBeNull();
  });

  test("rollback is receipt-scoped, restores the exact prior link, and rejects intervening edits", () => {
    const oldProject = registerProject("Old", "/projects/old");
    const newProject = registerProject("New", "/projects/new");
    const original = createMemory({
      key: "move-existing-memory",
      value: "stable content",
      project_id: oldProject.id,
      scope: "shared",
    });
    const accepted = applyMemoryProjectLink(
      original.id,
      requestFor(original, newProject, "dubai-memory-project-link-forward-0001"),
    );
    const rollbackRequest = {
      ...IDENTITY,
      operation_id: "dubai-memory-project-link-v1",
      step_id: "mementos_memory_project_link_rollback",
      idempotency_key: "dubai-memory-project-link-rollback-0001",
      expected_memory_version: accepted.memory.version,
      expected_memory_revision: accepted.memory.updated_at,
      accepted_receipt_id: accepted.receipt!.receipt_id,
    };

    const rolledBack = rollbackMemoryProjectLink(original.id, rollbackRequest);
    expect(rolledBack).toMatchObject({
      applied: true,
      no_change: false,
      memory: original,
      receipt: {
        direction: "rollback",
        accepted_receipt_id: accepted.receipt!.receipt_id,
        before_link: { project_id: newProject.id },
        after_link: { project_id: oldProject.id },
      },
    });
    expect(getMemory(original.id)).toEqual(original);
    expect(rollbackMemoryProjectLink(original.id, rollbackRequest)).toEqual(rolledBack);

    const second = applyMemoryProjectLink(
      original.id,
      requestFor(original, newProject, "dubai-memory-project-link-forward-0002"),
    );
    const edited = updateMemory(original.id, {
      version: second.memory.version,
      summary: "concurrent edit",
    });
    expectLinkError(() => rollbackMemoryProjectLink(original.id, {
      ...rollbackRequest,
      idempotency_key: "dubai-memory-project-link-rollback-after-edit-0001",
      expected_memory_version: second.memory.version,
      expected_memory_revision: second.memory.updated_at,
      accepted_receipt_id: second.receipt!.receipt_id,
    }), "MEMORY_PROJECT_LINK_STALE_MEMORY");
    expect(getMemory(original.id)).toEqual(edited);

    const other = createMemory({ key: "other-memory", value: "other" });
    expectLinkError(() => rollbackMemoryProjectLink(other.id, {
      ...rollbackRequest,
      idempotency_key: "dubai-memory-project-link-wrong-target-0001",
      expected_memory_version: other.version,
      expected_memory_revision: other.updated_at,
      accepted_receipt_id: second.receipt!.receipt_id,
    }), "MEMORY_PROJECT_LINK_RECEIPT_NOT_FOUND");
  });

  test("rollback rejects a project row edited after the accepted link", () => {
    const project = registerProject("Mutable", "/projects/mutable-after-link");
    const memory = createMemory({ key: "project-edited-after-link", value: "stable" });
    const accepted = applyMemoryProjectLink(
      memory.id,
      requestFor(memory, project, "dubai-memory-project-link-project-edit-0001"),
    );
    updateProject(project.id, { description: "concurrent project edit" });

    expectLinkError(() => rollbackMemoryProjectLink(memory.id, {
      ...IDENTITY,
      operation_id: "dubai-memory-project-link-v1",
      step_id: "mementos_memory_project_link_rollback",
      idempotency_key: "dubai-memory-project-link-project-edit-rollback-0001",
      expected_memory_version: accepted.memory.version,
      expected_memory_revision: accepted.memory.updated_at,
      accepted_receipt_id: accepted.receipt!.receipt_id,
    }), "MEMORY_PROJECT_LINK_STALE_PROJECT");
    expect(getMemory(memory.id)).toEqual(accepted.memory);
  });
});
