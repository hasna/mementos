process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { DbAdapter } from "../storage.js";
import { getDatabase, resetDatabase } from "../db/database.js";
import { getProject, registerProject } from "../db/projects.js";
import {
  MementosProjectRegistrationError,
  createLocalMementosProjectRegistrationAuthority,
  deriveMementosProjectRegistrationIdempotencyKey,
  digestMementosProjectRegistrationValue,
  type MementosProjectRegistrationAuthority,
  type MementosProjectRegistrationFaultPoint,
  type MementosProjectRegistrationReceipt,
  type MementosProjectRegistrationRequest,
} from "./index.js";

const PROJECT_ID = "wks_fleetresourcesv1";
const PROJECT_SLUG = "fleet-resources";
const PROJECT_NAME = "Fleet Resources";
const PROJECT_PATH = "/tmp/fleet-resources";

class OwnedPathHandle {
  constructor(private readonly value: string) {}

  withOwnedPath<T>(consumer: (absolutePath: string) => T): T {
    return consumer(this.value);
  }
}

function authority(
  db: DbAdapter,
  faultInjector?: (
    point: MementosProjectRegistrationFaultPoint,
    context: {
      operation_id: string;
      step_id: string;
      direction: "forward" | "inverse";
    },
  ) => void,
  now: () => string = () => "2026-08-07T12:00:00.000Z",
): MementosProjectRegistrationAuthority {
  return createLocalMementosProjectRegistrationAuthority(db, {
    packageVersion: "0.14.75-test",
    authorityId: "mementos-test-authority",
    tenantId: "tenant-test",
    corpusId: "corpus-test",
    now,
    faultInjector,
  });
}

async function forwardRequest(
  target: OwnedPathHandle = new OwnedPathHandle(PROJECT_PATH),
  operationId = "fleet-resources-registration-v1",
  db: DbAdapter = getDatabase(),
): Promise<{
  authority: MementosProjectRegistrationAuthority;
  request: MementosProjectRegistrationRequest;
}> {
  const registrationAuthority = authority(db);
  const capability = await registrationAuthority.capability();
  const desired = {
    source_project_id: PROJECT_ID,
    source_project_slug: PROJECT_SLUG,
    name: PROJECT_NAME,
    target_path_digest: createHash("sha256").update(PROJECT_PATH).digest("hex"),
  };
  const requestDigest = digestMementosProjectRegistrationValue(desired);
  const preconditionDigest = digestMementosProjectRegistrationValue({
    target_selector: PROJECT_ID,
    expected: "absent",
  });
  const request: MementosProjectRegistrationRequest = {
    operation_id: operationId,
    step_id: "mementos_project",
    resource_kind: "project",
    direction: "forward",
    authority_route: capability.route,
    package_version: capability.package_version,
    authority_id: capability.authority_id,
    tenant_id: capability.tenant_id,
    corpus_id: capability.corpus_id,
    target_selector: PROJECT_ID,
    idempotency_key: deriveMementosProjectRegistrationIdempotencyKey({
      operation_id: operationId,
      step_id: "mementos_project",
      direction: "forward",
      target_selector: PROJECT_ID,
      request_digest: requestDigest,
      precondition_digest: preconditionDigest,
    }),
    request_digest: requestDigest,
    precondition_digest: preconditionDigest,
    project_id: PROJECT_ID,
    project_slug: PROJECT_SLUG,
    project_name: PROJECT_NAME,
    desired,
    target,
    response_byte_limit: 65_536,
    time_budget_ms: 5_000,
  };
  return { authority: registrationAuthority, request };
}

async function inverseRequest(
  registrationAuthority: MementosProjectRegistrationAuthority,
  accepted: MementosProjectRegistrationReceipt,
): Promise<MementosProjectRegistrationRequest> {
  const capability = await registrationAuthority.capability();
  const desired = {
    accepted_receipt_id: accepted.receipt_id,
    target_id: accepted.target_id,
  };
  const precondition = {
    expected_revision: accepted.result_revision,
    expected_digest: accepted.result_digest,
  };
  const requestDigest = digestMementosProjectRegistrationValue(desired);
  const preconditionDigest = digestMementosProjectRegistrationValue(precondition);
  return {
    operation_id: accepted.operation_id,
    step_id: accepted.step_id,
    resource_kind: "project",
    direction: "inverse",
    authority_route: capability.route,
    package_version: capability.package_version,
    authority_id: capability.authority_id,
    tenant_id: capability.tenant_id,
    corpus_id: capability.corpus_id,
    target_selector: accepted.target_id!,
    idempotency_key: deriveMementosProjectRegistrationIdempotencyKey({
      operation_id: accepted.operation_id,
      step_id: accepted.step_id,
      direction: "inverse",
      target_selector: accepted.target_id!,
      request_digest: requestDigest,
      precondition_digest: preconditionDigest,
    }),
    request_digest: requestDigest,
    precondition_digest: preconditionDigest,
    project_id: PROJECT_ID,
    project_slug: PROJECT_SLUG,
    project_name: PROJECT_NAME,
    desired,
    target: new OwnedPathHandle(PROJECT_PATH),
    accepted_receipt: accepted,
    response_byte_limit: 65_536,
    time_budget_ms: 5_000,
  };
}

beforeEach(() => {
  resetDatabase();
});

describe("package-owned Mementos project registration authority", () => {
  test("creates once, reads back by full id, and returns duplicate-of-accepted on byte-identical retry", async () => {
    const db = getDatabase();
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      undefined,
      db,
    );

    const accepted = await registrationAuthority.create(request);
    expect(accepted).toMatchObject({
      authority: "mementos",
      outcome: "accepted",
      created_by_operation: true,
      duplicate_of_receipt_id: null,
    });
    expect(accepted.target_id).toMatch(/^mm_project_[0-9a-f]{40}$/);
    expect(JSON.stringify(accepted)).not.toContain(PROJECT_PATH);

    const readback = await registrationAuthority.readExact({
      resource_kind: "project",
      target_id: accepted.target_id!,
      target: request.target,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    expect(readback).toEqual({
      target_id: accepted.target_id,
      revision: accepted.result_revision,
      digest: accepted.result_digest,
    });

    const duplicate = await registrationAuthority.create(request);
    expect(duplicate).toMatchObject({
      outcome: "duplicate_of_accepted",
      target_id: accepted.target_id,
      result_revision: accepted.result_revision,
      result_digest: accepted.result_digest,
      duplicate_of_receipt_id: accepted.receipt_id,
      created_by_operation: false,
    });
    expect(getProject(accepted.target_id!, db)?.updated_at).toBe(accepted.result_revision);

    const lookup = await registrationAuthority.lookupReceipt({
      operation_id: request.operation_id,
      step_id: request.step_id,
      resource_kind: request.resource_kind,
      direction: request.direction,
      authority: "mementos",
      authority_route: request.authority_route,
      package_version: request.package_version,
      authority_id: request.authority_id,
      tenant_id: request.tenant_id,
      corpus_id: request.corpus_id,
      target_selector: request.target_selector,
      idempotency_key: request.idempotency_key,
      target_id: accepted.target_id!,
      max_items: 1,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    expect(lookup.receipt.receipt_id).toBe(duplicate.receipt_id);
    expect(lookup.response_control).toMatchObject({
      complete: true,
      truncated: false,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    expect(lookup.response_control.response_bytes).toBe(
      Buffer.byteLength(JSON.stringify(lookup), "utf8"),
    );
  });

  test("a pre-existing project at the canonical path is terminal nonacceptance with zero project mutation", async () => {
    const db = getDatabase();
    const existing = registerProject("existing", PROJECT_PATH, "keep-me", "keep", db);
    const before = db.query("SELECT * FROM projects WHERE id = ?").get(existing.id);
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-conflict-v1",
      db,
    );

    const receipt = await registrationAuthority.create(request);
    expect(receipt).toMatchObject({
      outcome: "terminal_nonacceptance",
      reason: "target_preexists",
      target_id: existing.id,
      created_by_operation: false,
    });
    expect(db.query("SELECT * FROM projects WHERE id = ?").get(existing.id)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 1 });
  });

  test("byte-identical retries reuse immutable duplicate evidence across clock ticks", async () => {
    const db = getDatabase();
    let tick = 0;
    const advancing = authority(
      db,
      undefined,
      () => new Date(Date.UTC(2026, 7, 7, 12, 0, tick++)).toISOString(),
    );
    const capability = await advancing.capability();
    const { request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-advancing-clock-v1",
      db,
    );
    Object.assign(request, {
      authority_route: capability.route,
      package_version: capability.package_version,
      authority_id: capability.authority_id,
      tenant_id: capability.tenant_id,
      corpus_id: capability.corpus_id,
    });
    request.idempotency_key = deriveMementosProjectRegistrationIdempotencyKey(request);

    const accepted = await advancing.create(request);
    const firstDuplicate = await advancing.create(request);
    const secondDuplicate = await advancing.create(request);

    expect(accepted.outcome).toBe("accepted");
    expect(firstDuplicate.outcome).toBe("duplicate_of_accepted");
    expect(secondDuplicate).toEqual(firstDuplicate);
  });

  test.each([
    "before_object_write",
    "after_object_write",
    "before_receipt_write",
    "after_receipt_write",
  ] as const)("%s rolls object and accepted receipt back before returning terminal evidence", async (point) => {
    const db = getDatabase();
    const throwingAuthority = authority(db, (current) => {
      if (current === point) throw new Error(`injected:${point}`);
    });
    const capability = await throwingAuthority.capability();
    const { request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      `fleet-resources-${point}-v1`,
      db,
    );
    Object.assign(request, {
      authority_route: capability.route,
      package_version: capability.package_version,
      authority_id: capability.authority_id,
      tenant_id: capability.tenant_id,
      corpus_id: capability.corpus_id,
    });
    request.idempotency_key = deriveMementosProjectRegistrationIdempotencyKey(request);

    const receipt = await throwingAuthority.create(request);
    expect(receipt).toMatchObject({
      outcome: "terminal_nonacceptance",
      reason: `write_failed:${point}`,
      target_id: null,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM projects").get()).toEqual({ count: 0 });
  });

  test("after-commit disconnect is reconciled by exact immutable lookup and retry", async () => {
    const db = getDatabase();
    const disconnecting = authority(db, (point) => {
      if (point === "after_commit") throw new Error("simulated response disconnect");
    });
    const capability = await disconnecting.capability();
    const { request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-disconnect-v1",
      db,
    );
    Object.assign(request, {
      authority_route: capability.route,
      package_version: capability.package_version,
      authority_id: capability.authority_id,
      tenant_id: capability.tenant_id,
      corpus_id: capability.corpus_id,
    });
    request.idempotency_key = deriveMementosProjectRegistrationIdempotencyKey(request);

    await expect(disconnecting.create(request)).rejects.toThrow("simulated response disconnect");
    const lookup = await disconnecting.lookupReceipt({
      operation_id: request.operation_id,
      step_id: request.step_id,
      resource_kind: request.resource_kind,
      direction: request.direction,
      authority: "mementos",
      authority_route: request.authority_route,
      package_version: request.package_version,
      authority_id: request.authority_id,
      tenant_id: request.tenant_id,
      corpus_id: request.corpus_id,
      target_selector: request.target_selector,
      idempotency_key: request.idempotency_key,
      max_items: 1,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    expect(lookup.receipt.outcome).toBe("accepted");
    await expect(disconnecting.create(request)).rejects.toThrow("simulated response disconnect");
    const reconciled = await disconnecting.lookupReceipt({
      operation_id: request.operation_id,
      step_id: request.step_id,
      resource_kind: request.resource_kind,
      direction: request.direction,
      authority: "mementos",
      authority_route: request.authority_route,
      package_version: request.package_version,
      authority_id: request.authority_id,
      tenant_id: request.tenant_id,
      corpus_id: request.corpus_id,
      target_selector: request.target_selector,
      idempotency_key: request.idempotency_key,
      max_items: 1,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    expect(reconciled.receipt).toMatchObject({
      outcome: "duplicate_of_accepted",
      duplicate_of_receipt_id: lookup.receipt.receipt_id,
    });
  });

  test("receipt-scoped inverse deletes only the unchanged attempt-created project", async () => {
    const db = getDatabase();
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-inverse-v1",
      db,
    );
    const accepted = await registrationAuthority.create(request);
    const inverse = await inverseRequest(registrationAuthority, accepted);

    const receipt = await registrationAuthority.compensate(inverse);
    expect(receipt).toMatchObject({
      outcome: "accepted",
      direction: "inverse",
      target_id: accepted.target_id,
      accepted_receipt_id: accepted.receipt_id,
      result_revision: "absent",
    });
    expect(getProject(accepted.target_id!, db)).toBeNull();
    await expect(registrationAuthority.verifyInverse(inverse)).resolves.toMatchObject({
      target_id: accepted.target_id,
      accepted_receipt_id: accepted.receipt_id,
      absent: true,
    });

    const duplicate = await registrationAuthority.compensate(inverse);
    expect(duplicate).toMatchObject({
      outcome: "duplicate_of_accepted",
      duplicate_of_receipt_id: receipt.receipt_id,
      accepted_receipt_id: accepted.receipt_id,
    });
    await expect(registrationAuthority.verifyInverse(inverse)).resolves.toMatchObject({
      target_id: accepted.target_id,
      accepted_receipt_id: accepted.receipt_id,
      absent: true,
    });
  });

  test("a failed inverse is terminal and a byte-identical retry cannot delete later", async () => {
    const db = getDatabase();
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-inverse-terminal-v1",
      db,
    );
    const accepted = await registrationAuthority.create(request);
    const inverse = await inverseRequest(registrationAuthority, accepted);
    const failingInverse = authority(db, (point, context) => {
      if (context.direction === "inverse" && point === "after_object_write") {
        throw new Error("injected inverse failure");
      }
    });

    const failed = await failingInverse.compensate(inverse);
    expect(failed).toMatchObject({
      outcome: "terminal_nonacceptance",
      reason: "write_failed:after_object_write",
      target_id: accepted.target_id,
      accepted_receipt_id: accepted.receipt_id,
    });
    expect(getProject(accepted.target_id!, db)).not.toBeNull();

    const retry = await registrationAuthority.compensate(inverse);
    expect(retry).toEqual(failed);
    expect(getProject(accepted.target_id!, db)).not.toBeNull();
  });

  test("receipt-scoped inverse refuses a drifted project and preserves it", async () => {
    const db = getDatabase();
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-drift-v1",
      db,
    );
    const accepted = await registrationAuthority.create(request);
    db.run("UPDATE projects SET description = ?, updated_at = ? WHERE id = ?", [
      "concurrent owner update",
      "2026-08-07T12:01:00.000Z",
      accepted.target_id,
    ]);
    const inverse = await inverseRequest(registrationAuthority, accepted);

    const receipt = await registrationAuthority.compensate(inverse);
    expect(receipt).toMatchObject({
      outcome: "terminal_nonacceptance",
      reason: "target_drifted",
      target_id: accepted.target_id,
      accepted_receipt_id: accepted.receipt_id,
    });
    expect(getProject(accepted.target_id!, db)?.description).toBe("concurrent owner update");
  });

  test("bounded lookup rejects anything except one exact terminal item", async () => {
    const db = getDatabase();
    const { authority: registrationAuthority, request } = await forwardRequest(
      new OwnedPathHandle(PROJECT_PATH),
      "fleet-resources-bounds-v1",
      db,
    );
    await registrationAuthority.create(request);

    await expect(registrationAuthority.lookupReceipt({
      operation_id: request.operation_id,
      step_id: request.step_id,
      resource_kind: request.resource_kind,
      direction: request.direction,
      authority: "mementos",
      authority_route: request.authority_route,
      package_version: request.package_version,
      authority_id: request.authority_id,
      tenant_id: request.tenant_id,
      corpus_id: request.corpus_id,
      target_selector: request.target_selector,
      idempotency_key: request.idempotency_key,
      max_items: 2 as 1,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    })).rejects.toMatchObject<MementosProjectRegistrationError>({
      code: "MEMENTOS_PROJECT_REGISTRATION_INVALID_BOUNDS",
    });
  });
});
