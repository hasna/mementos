import { describe, expect, test } from "bun:test";
import {
  MementosClient,
  type Memory,
  type MemoryProjectLinkReceipt,
  type MemoryProjectLinkRequest,
  type Project,
} from "./index.js";

const memoryId = "994b8da5-e4bc-4504-b09a-ea224cb6a2b4";
const projectId = "a60df6eb-09f7-4f86-8e16-4ae3bd16ac6c";
const memory = {
  id: memoryId,
  key: "sdk-memory-link",
  value: "stable",
  project_id: projectId,
  version: 4,
  updated_at: "2026-08-08T06:00:00.000Z",
} as Memory;
const project: Project = {
  id: projectId,
  name: "Dubai",
  path: "/projects/sdk-dubai",
  description: null,
  memory_prefix: null,
  created_at: "2026-08-08T05:00:00.000Z",
  updated_at: "2026-08-08T05:00:00.000Z",
};
const request: MemoryProjectLinkRequest = {
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
  operation_id: "sdk-memory-link-operation-v1",
  step_id: "sdk_memory_project_link",
  idempotency_key: "sdk-memory-link-request-0001",
  expected_memory_version: 4,
  expected_memory_revision: "2026-08-08T05:59:00.000Z",
  target_project_id: projectId,
  expected_project_revision: project.updated_at,
};
const receipt: MemoryProjectLinkReceipt = {
  receipt_id: "mmpl_0123456789012345678901234567890123456789",
  authority: "mementos",
  route: "mementos.memory-project-link.v1",
  package_version: "0.14.76-test",
  authority_id: "mementos",
  tenant_id: "default",
  corpus_id: "default",
  operation_id: request.operation_id,
  step_id: request.step_id,
  direction: "forward",
  idempotency_key: request.idempotency_key,
  request_digest: "0".repeat(64),
  outcome: "accepted",
  target_memory_id: memoryId,
  requested_project_id: projectId,
  expected_memory_version: request.expected_memory_version,
  expected_memory_revision: request.expected_memory_revision,
  expected_project_revision: request.expected_project_revision,
  result_memory_version: memory.version,
  result_memory_revision: memory.updated_at,
  result_memory_digest: "1".repeat(64),
  result_project_revision: project.updated_at,
  result_project_digest: "2".repeat(64),
  accepted_receipt_id: null,
  before_link: {
    memory_id: memoryId,
    project_id: null,
    memory_version: memory.version,
    memory_revision: request.expected_memory_revision,
    memory_digest: "3".repeat(64),
  },
  after_link: {
    memory_id: memoryId,
    project_id: projectId,
    memory_version: memory.version,
    memory_revision: memory.updated_at,
    memory_digest: "1".repeat(64),
  },
  before_project_revision: null,
  before_project_digest: null,
  after_project_revision: project.updated_at,
  after_project_digest: "2".repeat(64),
  created_at: memory.updated_at,
};

describe("MementosClient guarded existing-memory project linkage", () => {
  test("POSTs exact IDs, both CAS revisions, and the caller idempotency key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          dry_run: false,
          applied: true,
          no_change: false,
          memory,
          project,
          receipt,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    const result = await client.linkMemoryProject(memoryId, request);
    expect(result.receipt).toEqual(receipt);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://mementos.example.test/v1/memories/${memoryId}/guarded-project-link`,
    );
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ ...request, dry_run: false });
  });

  test("dry-run, rollback, and receipt lookup use receipt-scoped routes", async () => {
    const calls: string[] = [];
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        if (String(url).endsWith("/project-link-receipts/lookup")) {
          return new Response(JSON.stringify(receipt), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (String(url).endsWith("/guarded-project-link-rollback")) {
          return new Response(JSON.stringify({
            dry_run: false,
            applied: true,
            no_change: false,
            memory: { ...memory, project_id: null },
            project: null,
            receipt: {
              ...receipt,
              direction: "rollback",
              accepted_receipt_id: receipt.receipt_id,
              after_link: { ...receipt.after_link, project_id: null },
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          dry_run: true,
          applied: false,
          no_change: false,
          memory,
          project,
          receipt: null,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch,
    });

    await expect(client.previewMemoryProjectLink(memoryId, request)).resolves.toMatchObject({
      dry_run: true,
      applied: false,
      receipt: null,
    });
    await expect(client.rollbackMemoryProjectLink(memoryId, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "sdk-memory-rollback-operation-v1",
      step_id: "sdk_memory_project_rollback",
      idempotency_key: "sdk-memory-rollback-request-0001",
      expected_memory_version: memory.version,
      expected_memory_revision: memory.updated_at,
      accepted_receipt_id: receipt.receipt_id,
    })).resolves.toMatchObject({
      memory: { id: memoryId, project_id: null },
      receipt: { direction: "rollback", accepted_receipt_id: receipt.receipt_id },
    });
    await expect(client.getMemoryProjectLinkReceipt(memoryId, receipt.receipt_id, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
    })).resolves.toEqual(receipt);
    expect(calls).toEqual([
      `POST https://mementos.example.test/v1/memories/${memoryId}/guarded-project-link`,
      `POST https://mementos.example.test/v1/memories/${memoryId}/guarded-project-link-rollback`,
      `POST https://mementos.example.test/v1/memories/${memoryId}/project-link-receipts/lookup`,
    ]);
  });

  test("fails closed when the server returns different stable IDs", async () => {
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async () => new Response(JSON.stringify({
        dry_run: false,
        applied: true,
        no_change: false,
        memory: { ...memory, id: "different-memory" },
        project,
        receipt: { ...receipt, target_memory_id: "different-memory" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });

    expect(client.linkMemoryProject(memoryId, request)).rejects.toThrow(/exact memory\/project IDs/i);
  });

  test("fails closed when receipt lookup returns a different receipt or memory", async () => {
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async () => new Response(JSON.stringify({
        ...receipt,
        receipt_id: "mmpl_different_receipt_01234567890123456789",
      }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    });

    expect(client.getMemoryProjectLinkReceipt(memoryId, receipt.receipt_id, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
    })).rejects.toThrow(/mismatched receipt/i);
  });
});
