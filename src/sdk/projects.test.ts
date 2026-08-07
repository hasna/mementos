import { describe, expect, test } from "bun:test";
import {
  MementosClient,
  type Project,
  type ProjectGuardedUpdateRequest,
  type ProjectUpdateReceipt,
} from "./index.js";

const projectId = "4c21d965-b4cb-48c2-af80-91f8af654e88";
const before: Project = {
  id: projectId,
  name: "iproj-dubai-fraud",
  path: "/home/hasna/.hasna/projects/workspaces/iproj-dubai-fraud",
  description: "Private investigation",
  memory_prefix: "iproj_dubai_fraud",
  created_at: "2026-07-16T20:41:52.233Z",
  updated_at: "2026-08-07T15:00:00.000Z",
};
const expected: Project = {
  ...before,
  name: "Dubai Fraud",
  path: "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud",
  memory_prefix: "dubai_fraud",
  updated_at: "2026-08-07T16:00:00.000Z",
};
const request: ProjectGuardedUpdateRequest = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
  operation_id: "sdk-project-update-operation-v1",
  step_id: "mementos_project_update",
  idempotency_key: "sdk-project-update-request-0001",
  expected_revision: before.updated_at,
  updates: {
    name: `  ${expected.name}  `,
    path: `  ${expected.path}  `,
    memory_prefix: expected.memory_prefix,
  },
};
const receipt: ProjectUpdateReceipt = {
  receipt_id: "mpur_0123456789012345678901234567890123456789",
  authority: "mementos",
  route: "mementos.project-guarded-update.v1",
  package_version: "0.14.75-test",
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
  operation_id: request.operation_id,
  step_id: request.step_id,
  direction: "forward",
  idempotency_key: request.idempotency_key,
  request_digest: "0".repeat(64),
  outcome: "accepted",
  target_id: projectId,
  expected_revision: before.updated_at,
  result_revision: expected.updated_at,
  result_digest: "1".repeat(64),
  accepted_receipt_id: null,
  before_project: before,
  after_project: expected,
  created_at: expected.updated_at,
};

describe("MementosClient guarded project updates", () => {
  test("POSTs the exact stable ID, CAS revision, caller key, and normalized fields", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          dry_run: false,
          applied: true,
          project: expected,
          receipt,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    const updated = await client.updateProject(projectId, request);

    expect(updated.project).toEqual(expected);
    expect(updated.receipt).toEqual(receipt);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://mementos.example.test/v1/projects/${projectId}/guarded-update`,
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      ...request,
      updates: {
        name: expected.name,
        path: expected.path,
        memory_prefix: expected.memory_prefix,
      },
      dry_run: false,
    });
  });

  test("dry-run requires a no-write response and rollback/lookup use receipt-scoped routes", async () => {
    const calls: string[] = [];
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        if (String(url).endsWith("/update-receipts/lookup")) {
          return new Response(JSON.stringify(receipt), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).endsWith("/guarded-rollback")) {
          return new Response(JSON.stringify({
            dry_run: false,
            applied: true,
            project: before,
            receipt: { ...receipt, direction: "rollback", after_project: before },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          dry_run: true,
          applied: false,
          project: expected,
          receipt: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    await expect(client.previewProjectUpdate(projectId, request)).resolves.toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
    });
    await expect(client.rollbackProjectUpdate(projectId, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "sdk-project-rollback-operation-v1",
      step_id: "mementos_project_rollback",
      idempotency_key: "sdk-project-rollback-request-0001",
      expected_revision: expected.updated_at,
      accepted_receipt_id: receipt.receipt_id,
    })).resolves.toMatchObject({ project: before, receipt: { direction: "rollback" } });
    await expect(client.getProjectUpdateReceipt(projectId, receipt.receipt_id, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
    })).resolves.toEqual(receipt);
    expect(calls).toEqual([
      `POST https://mementos.example.test/v1/projects/${projectId}/guarded-update`,
      `POST https://mementos.example.test/v1/projects/${projectId}/guarded-rollback`,
      `POST https://mementos.example.test/v1/projects/${projectId}/update-receipts/lookup`,
    ]);
  });

  test("fails closed when the server returns a different stable ID", async () => {
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async () => new Response(JSON.stringify({
        dry_run: false,
        applied: true,
        project: { ...expected, id: "project-2" },
        receipt: { ...receipt, target_id: "project-2" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });

    expect(client.updateProject(projectId, request)).rejects.toThrow(/different stable ID/i);
  });
});
