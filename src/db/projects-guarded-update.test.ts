process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "./database.js";
import { createMemory, listMemories } from "./memories.js";
import {
  applyProjectUpdate,
  getProject,
  getProjectUpdateReceipt,
  previewProjectUpdate,
  registerProject,
  rollbackProjectUpdate,
  ProjectGuardedUpdateError,
} from "./projects.js";

const IDENTITY = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
} as const;

function expectGuardedError(
  action: () => unknown,
  code: ProjectGuardedUpdateError["code"],
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectGuardedUpdateError);
  expect(caught).toMatchObject({ code });
}

beforeEach(() => {
  resetDatabase();
});

describe("guarded stable-ID project updates", () => {
  test("dry-run performs no write, accepted retry is immutable, and an inconsistent retry is rejected", () => {
    const original = registerProject(
      "iproj-dubai-fraud",
      "/projects/iproj-dubai-fraud",
      "Private investigation",
      "iproj_dubai_fraud",
    );
    const memory = createMemory({
      key: "dubai-evidence-index",
      value: "version one",
      project_id: original.id,
      scope: "shared",
    });
    const request = {
      ...IDENTITY,
      operation_id: "dubai-project-update-v1",
      step_id: "mementos_project_update",
      idempotency_key: "dubai-project-update-request-0001",
      expected_revision: original.updated_at,
      updates: {
        name: "Dubai Fraud",
        path: "/projects/dubai-fraud",
        memory_prefix: "dubai_fraud",
      },
    };

    const preview = previewProjectUpdate(original.id, request);
    expect(preview).toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
      project: {
        id: original.id,
        name: "Dubai Fraud",
        path: "/projects/dubai-fraud",
      },
    });
    expect(getProject(original.id)).toEqual(original);

    const accepted = applyProjectUpdate(original.id, request);
    expect(accepted).toMatchObject({
      dry_run: false,
      applied: true,
      project: {
        id: original.id,
        name: "Dubai Fraud",
        path: "/projects/dubai-fraud",
      },
      receipt: {
        direction: "forward",
        outcome: "accepted",
        target_id: original.id,
        before_project: original,
      },
    });
    expect(accepted.receipt?.after_project).toEqual(accepted.project);
    expect(listMemories({ project_id: original.id, limit: 100 })).toMatchObject([
      { id: memory.id, project_id: original.id },
    ]);

    const duplicate = applyProjectUpdate(original.id, request);
    expect(duplicate).toEqual(accepted);
    expect(getProjectUpdateReceipt(original.id, accepted.receipt!.receipt_id, IDENTITY))
      .toEqual(accepted.receipt);

    expect(() => applyProjectUpdate(original.id, {
      ...request,
      updates: { description: "different payload under the same caller key" },
    })).toThrow(/idempotency key.*different request/i);
  });

  test("stale revision, collision, missing ID, and cross-tenant calls reject without writes", () => {
    const source = registerProject("Source", "/projects/source");
    const target = registerProject("Target", "/projects/target");
    const before = getProject(source.id);
    const base = {
      ...IDENTITY,
      operation_id: "guarded-project-rejections-v1",
      step_id: "mementos_project_update",
      expected_revision: source.updated_at,
    };

    expectGuardedError(() => applyProjectUpdate(source.id, {
      ...base,
      idempotency_key: "guarded-project-stale-revision-0001",
      expected_revision: "2026-01-01T00:00:00.000Z",
      updates: { name: "Stale" },
    }), "PROJECT_UPDATE_STALE_REVISION");
    expectGuardedError(() => applyProjectUpdate(source.id, {
      ...base,
      idempotency_key: "guarded-project-name-collision-0001",
      updates: { name: target.name.toLowerCase() },
    }), "PROJECT_UPDATE_COLLISION");
    expectGuardedError(() => applyProjectUpdate("missing-project", {
      ...base,
      idempotency_key: "guarded-project-missing-id-0001",
      updates: { name: "Missing" },
    }), "PROJECT_UPDATE_NOT_FOUND");
    expectGuardedError(() => applyProjectUpdate(source.id, {
      ...base,
      tenant_id: "other-tenant",
      idempotency_key: "guarded-project-cross-tenant-0001",
      updates: { name: "Wrong tenant" },
    }), "PROJECT_UPDATE_AUTHORITY_MISMATCH");

    expect(getProject(source.id)).toEqual(before);
    expect(getProject(target.id)).toEqual(target);
  });

  test("rollback accepts only the current forward state and restores the exact prior row", () => {
    const original = registerProject(
      "Original",
      "/projects/original",
      "Original description",
      "original_prefix",
    );
    const memory = createMemory({
      key: "project-linked-memory",
      value: "must stay linked",
      project_id: original.id,
      scope: "shared",
    });
    const accepted = applyProjectUpdate(original.id, {
      ...IDENTITY,
      operation_id: "guarded-project-rollback-v1",
      step_id: "mementos_project_update",
      idempotency_key: "guarded-project-forward-rollback-0001",
      expected_revision: original.updated_at,
      updates: {
        name: "Updated",
        path: "/projects/updated",
        description: null,
        memory_prefix: null,
      },
    });

    const rolledBack = rollbackProjectUpdate(original.id, {
      ...IDENTITY,
      operation_id: "guarded-project-rollback-v1",
      step_id: "mementos_project_rollback",
      idempotency_key: "guarded-project-inverse-rollback-0001",
      expected_revision: accepted.project.updated_at,
      accepted_receipt_id: accepted.receipt!.receipt_id,
    });

    expect(rolledBack).toMatchObject({
      applied: true,
      project: original,
      receipt: {
        direction: "rollback",
        outcome: "accepted",
        target_id: original.id,
        accepted_receipt_id: accepted.receipt!.receipt_id,
        after_project: original,
      },
    });
    expect(getProject(original.id)).toEqual(original);
    expect(listMemories({ project_id: original.id, limit: 100 })).toMatchObject([
      { id: memory.id, project_id: original.id },
    ]);
    expect(rollbackProjectUpdate(original.id, {
      ...IDENTITY,
      operation_id: "guarded-project-rollback-v1",
      step_id: "mementos_project_rollback",
      idempotency_key: "guarded-project-inverse-rollback-0001",
      expected_revision: accepted.project.updated_at,
      accepted_receipt_id: accepted.receipt!.receipt_id,
    })).toEqual(rolledBack);
  });
});
