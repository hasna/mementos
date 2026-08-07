import { describe, expect, test } from "bun:test";
import { MementosClient, type Project } from "./index.js";

describe("MementosClient project updates", () => {
  test("PATCHes an exact stable ID with the requested project fields", async () => {
    const projectId = "4c21d965-b4cb-48c2-af80-91f8af654e88";
    const expected: Project = {
      id: projectId,
      name: "Dubai Fraud",
      path: "/home/hasna/.hasna/projects/workspaces/wks-dubai-fraud",
      description: "Private investigation",
      memory_prefix: "dubai_fraud",
      created_at: "2026-07-16T20:41:52.233Z",
      updated_at: "2026-08-07T16:00:00.000Z",
    };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(expected), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });

    const updated = await client.updateProject(projectId, {
      name: `  ${expected.name}  `,
      path: `  ${expected.path}  `,
      memory_prefix: expected.memory_prefix,
    });

    expect(updated).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `https://mementos.example.test/v1/projects/${projectId}`
    );
    expect(calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      name: expected.name,
      path: expected.path,
      memory_prefix: expected.memory_prefix,
    });
  });

  test("fails closed when the server returns a different stable ID", async () => {
    const client = new MementosClient({
      baseUrl: "https://mementos.example.test",
      fetch: (async () =>
        new Response(
          JSON.stringify({
            id: "project-2",
            name: "Dubai Fraud",
            path: "/canonical",
            description: null,
            memory_prefix: null,
            created_at: "2026-08-07T16:00:00.000Z",
            updated_at: "2026-08-07T16:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as typeof fetch,
    });

    expect(client.updateProject("project-1", { name: "Dubai Fraud" })).rejects.toThrow(
      /different stable ID/i
    );
  });
});
