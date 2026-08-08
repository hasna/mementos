process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { registerProject } from "../db/projects.js";
import { buildOpenApiDocument } from "./openapi.js";
import { matchRoute } from "./router.js";
import "./routes/memories.js";

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const matched = matchRoute("POST", path);
  if (!matched) throw new Error(`route not found: ${path}`);
  const req = new Request(`http://mementos.test${path.replace(/^\/api/, "/v1")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return matched.handler(req, new URL(req.url), matched.params);
}

beforeEach(() => {
  resetDatabase();
});

describe("guarded existing-memory project-link server contract", () => {
  test("dry-run is read-only, accepted replay is stable, and key mismatch fails closed", async () => {
    const project = registerProject("Dubai", "/projects/server-dubai");
    const memory = createMemory({ key: "server-memory-link", value: "stable" });
    const request = {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-memory-link-operation-v1",
      step_id: "server_memory_project_link",
      idempotency_key: "server-memory-link-request-0001",
      expected_memory_version: memory.version,
      expected_memory_revision: memory.updated_at,
      target_project_id: project.id,
      expected_project_revision: project.updated_at,
    };
    const path = `/api/memories/${memory.id}/guarded-project-link`;

    const preview = await post(path, { ...request, dry_run: true });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
      memory: { id: memory.id, project_id: project.id },
    });
    expect(getMemory(memory.id)).toEqual(memory);

    const acceptedResponse = await post(path, { ...request, dry_run: false });
    const accepted = await acceptedResponse.json() as Record<string, any>;
    expect(acceptedResponse.status).toBe(200);
    expect(accepted).toMatchObject({
      applied: true,
      memory: { id: memory.id, project_id: project.id, version: memory.version },
      receipt: {
        direction: "forward",
        target_memory_id: memory.id,
        requested_project_id: project.id,
      },
    });
    expect(await (await post(path, request)).json()).toEqual(accepted);

    const mismatch = await post(path, { ...request, target_project_id: "another-project" });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      details: { code: "MEMORY_PROJECT_LINK_IDEMPOTENCY_MISMATCH" },
    });

    const lookup = await post(`/api/memories/${memory.id}/project-link-receipts/lookup`, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      receipt_id: accepted.receipt.receipt_id,
    });
    expect(await lookup.json()).toEqual(accepted.receipt);
  });

  test("cross-tenant link rejects and receipt-scoped rollback restores the exact row", async () => {
    const oldProject = registerProject("Old", "/projects/server-old");
    const newProject = registerProject("New", "/projects/server-new");
    const memory = createMemory({
      key: "server-memory-rollback",
      value: "stable",
      project_id: oldProject.id,
    });
    const request = {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-memory-rollback-operation-v1",
      step_id: "server_memory_project_link",
      idempotency_key: "server-memory-forward-request-0001",
      expected_memory_version: memory.version,
      expected_memory_revision: memory.updated_at,
      target_project_id: newProject.id,
      expected_project_revision: newProject.updated_at,
    };
    const path = `/api/memories/${memory.id}/guarded-project-link`;
    const denied = await post(path, { ...request, tenant_id: "other-tenant" });
    expect(denied.status).toBe(403);
    expect(getMemory(memory.id)).toEqual(memory);

    const accepted = await (await post(path, request)).json() as Record<string, any>;
    const rollback = await post(`/api/memories/${memory.id}/guarded-project-link-rollback`, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-memory-rollback-operation-v1",
      step_id: "server_memory_project_rollback",
      idempotency_key: "server-memory-rollback-request-0001",
      expected_memory_version: accepted.memory.version,
      expected_memory_revision: accepted.memory.updated_at,
      accepted_receipt_id: accepted.receipt.receipt_id,
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({
      memory,
      receipt: {
        direction: "rollback",
        accepted_receipt_id: accepted.receipt.receipt_id,
      },
    });
    expect(getMemory(memory.id)).toEqual(memory);
  });

  test("unguarded PATCH is refused and OpenAPI exposes all guarded routes", async () => {
    const memory = createMemory({ key: "server-unguarded-link", value: "stable" });
    const matched = matchRoute("PATCH", `/api/memories/${memory.id}`);
    expect(matched).not.toBeNull();
    const req = new Request(`http://mementos.test/v1/memories/${memory.id}`, {
      method: "PATCH",
      body: JSON.stringify({ project_id: "unsafe-project" }),
    });
    const response = await matched!.handler(req, new URL(req.url), matched!.params);
    expect(response.status).toBe(428);
    expect(getMemory(memory.id)).toEqual(memory);

    const paths = buildOpenApiDocument("test")["paths"] as Record<string, unknown>;
    expect(paths).toHaveProperty("/v1/memories/{id}/guarded-project-link");
    expect(paths).toHaveProperty("/v1/memories/{id}/guarded-project-link-rollback");
    expect(paths).toHaveProperty("/v1/memories/{id}/project-link-receipts/lookup");
  });
});
