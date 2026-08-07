process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getProject, registerProject } from "../db/projects.js";
import { resetDatabase } from "../db/database.js";
import { buildOpenApiDocument } from "./openapi.js";
import { matchRoute } from "./router.js";
import "./routes/projects.js";

async function request(path: string, body: Record<string, unknown>): Promise<Response> {
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

describe("guarded project update server contract", () => {
  test("dry-run writes nothing, accepted retry is stable, and an inconsistent caller-key retry is 409", async () => {
    const project = registerProject("Old", "/projects/old");
    const update = {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-project-update-v1",
      step_id: "mementos_project_update",
      idempotency_key: "server-project-update-request-0001",
      expected_revision: project.updated_at,
      updates: { name: "New", path: "/projects/new" },
    };

    const previewResponse = await request(`/api/projects/${project.id}/guarded-update`, {
      ...update,
      dry_run: true,
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
      project: { id: project.id, name: "New" },
    });
    expect(getProject(project.id)).toEqual(project);

    const acceptedResponse = await request(`/api/projects/${project.id}/guarded-update`, update);
    const accepted = await acceptedResponse.json() as Record<string, any>;
    expect(acceptedResponse.status).toBe(200);
    expect(accepted).toMatchObject({
      applied: true,
      project: { id: project.id, name: "New" },
      receipt: { direction: "forward", target_id: project.id },
    });

    const duplicateResponse = await request(`/api/projects/${project.id}/guarded-update`, update);
    expect(await duplicateResponse.json()).toEqual(accepted);

    const mismatch = await request(`/api/projects/${project.id}/guarded-update`, {
      ...update,
      updates: { description: "different request under the same key" },
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      details: { code: "PROJECT_UPDATE_IDEMPOTENCY_MISMATCH" },
    });

    const lookup = await request(`/api/projects/${project.id}/update-receipts/lookup`, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      receipt_id: accepted.receipt.receipt_id,
    });
    expect(await lookup.json()).toEqual(accepted.receipt);
  });

  test("cross-tenant update rejects and receipt-scoped rollback restores the exact prior row", async () => {
    const original = registerProject("Original", "/projects/original", "keep", "original");
    const base = {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-project-rollback-v1",
      step_id: "mementos_project_update",
      idempotency_key: "server-project-forward-request-0001",
      expected_revision: original.updated_at,
      updates: { name: "Updated", path: "/projects/updated" },
    };
    const crossTenant = await request(`/api/projects/${original.id}/guarded-update`, {
      ...base,
      tenant_id: "other-tenant",
    });
    expect(crossTenant.status).toBe(403);
    expect(getProject(original.id)).toEqual(original);

    const acceptedResponse = await request(`/api/projects/${original.id}/guarded-update`, base);
    const accepted = await acceptedResponse.json() as Record<string, any>;
    const rollback = await request(`/api/projects/${original.id}/guarded-rollback`, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "server-project-rollback-v1",
      step_id: "mementos_project_rollback",
      idempotency_key: "server-project-rollback-request-0001",
      expected_revision: accepted.project.updated_at,
      accepted_receipt_id: accepted.receipt.receipt_id,
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({
      project: original,
      receipt: {
        direction: "rollback",
        accepted_receipt_id: accepted.receipt.receipt_id,
      },
    });
    expect(getProject(original.id)).toEqual(original);
  });

  test("the unguarded PATCH is refused and OpenAPI exposes all guarded routes", async () => {
    const matched = matchRoute("PATCH", "/api/projects/project-1");
    expect(matched).not.toBeNull();
    const req = new Request("http://mementos.test/v1/projects/project-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "unsafe" }),
    });
    const response = await matched!.handler(req, new URL(req.url), matched!.params);
    expect(response.status).toBe(428);
    const paths = buildOpenApiDocument("test")["paths"] as Record<string, unknown>;
    expect(paths).toHaveProperty("/v1/projects/{id}/guarded-update");
    expect(paths).toHaveProperty("/v1/projects/{id}/guarded-rollback");
    expect(paths).toHaveProperty("/v1/projects/{id}/update-receipts/lookup");
  });
});
