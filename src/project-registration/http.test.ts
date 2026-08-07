process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getDatabase, resetDatabase } from "../db/database.js";
import {
  createLocalMementosProjectRegistrationAuthority,
  createMementosProjectRegistrationHttpClient,
  deriveMementosProjectRegistrationIdempotencyKey,
  digestMementosProjectRegistrationValue,
  handleMementosProjectRegistrationHttpRequest,
  type MementosProjectRegistrationPathHandle,
  type MementosProjectRegistrationRequest,
} from "./index.js";

const PROJECT_ID = "wks_httpregistrationv1";
const PROJECT_PATH = "/tmp/http-registration";

class OwnedPathHandle implements MementosProjectRegistrationPathHandle {
  constructor(private readonly value: string) {}

  withOwnedPath<T>(consumer: (absolutePath: string) => T): T {
    return consumer(this.value);
  }
}

beforeEach(() => {
  resetDatabase();
});

describe("Mementos project registration HTTP authority", () => {
  test("round-trips the private path through the public client without returning it", async () => {
    const local = createLocalMementosProjectRegistrationAuthority(getDatabase(), {
      packageVersion: "0.14.75-http-test",
      authorityId: "mementos-http-test",
      tenantId: "tenant-http-test",
      corpusId: "corpus-http-test",
      now: () => "2026-08-07T12:00:00.000Z",
    });
    const requestBodies: string[] = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST") requestBodies.push(await request.clone().text());
      const response = await handleMementosProjectRegistrationHttpRequest(
        request,
        new URL(request.url),
        local,
      );
      return response ?? new Response("not found", { status: 404 });
    };
    const client = createMementosProjectRegistrationHttpClient({
      baseUrl: "http://mementos.test",
      fetch: fetchImpl,
    });
    const capability = await client.capability();
    const target = new OwnedPathHandle(PROJECT_PATH);
    const desired = {
      source_project_id: PROJECT_ID,
      source_project_slug: "http-registration",
      name: "HTTP Registration",
      target_path_digest: createHash("sha256").update(PROJECT_PATH).digest("hex"),
    };
    const requestDigest = digestMementosProjectRegistrationValue(desired);
    const preconditionDigest = digestMementosProjectRegistrationValue({
      target_selector: PROJECT_ID,
      expected: "absent",
    });
    const request: MementosProjectRegistrationRequest = {
      operation_id: "http-registration-operation-v1",
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
        operation_id: "http-registration-operation-v1",
        step_id: "mementos_project",
        direction: "forward",
        target_selector: PROJECT_ID,
        request_digest: requestDigest,
        precondition_digest: preconditionDigest,
      }),
      request_digest: requestDigest,
      precondition_digest: preconditionDigest,
      project_id: PROJECT_ID,
      project_slug: "http-registration",
      project_name: "HTTP Registration",
      desired,
      target,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    };

    const accepted = await client.create(request);
    const record = await client.readExact({
      resource_kind: "project",
      target_id: accepted.target_id!,
      target,
      response_byte_limit: 65_536,
      time_budget_ms: 5_000,
    });
    const duplicate = await client.create(request);

    expect(accepted.outcome).toBe("accepted");
    expect(record).toMatchObject({
      target_id: accepted.target_id,
      revision: accepted.result_revision,
      digest: accepted.result_digest,
    });
    expect(duplicate).toMatchObject({
      outcome: "duplicate_of_accepted",
      duplicate_of_receipt_id: accepted.receipt_id,
    });
    expect(requestBodies.some((body) => body.includes(PROJECT_PATH))).toBe(true);
    expect(requestBodies.every((body) => !body.includes('"target"'))).toBe(true);
    expect(JSON.stringify({ capability, accepted, record, duplicate })).not.toContain(PROJECT_PATH);
  });

  test("fails closed when the private transport omits the canonical path", async () => {
    const local = createLocalMementosProjectRegistrationAuthority(getDatabase(), {
      packageVersion: "0.14.75-http-test",
    });
    const response = await handleMementosProjectRegistrationHttpRequest(
      new Request("http://mementos.test/v1/project-registration/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resource_kind: "project" }),
      }),
      new URL("http://mementos.test/v1/project-registration/create"),
      local,
    );

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({
      code: "MEMENTOS_PROJECT_REGISTRATION_INVALID_INPUT",
      authoritative: true,
    });
  });
});
