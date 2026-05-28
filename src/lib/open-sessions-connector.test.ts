import { describe, it, expect, afterEach } from "bun:test";
import { OpenSessionsConnector, connectorFromEnv } from "./open-sessions-connector.js";

describe("OpenSessionsConnector", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("skips ingest when transcript is too short", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/transcript")) {
        return Response.json({ transcript: "short" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const connector = new OpenSessionsConnector({
      openSessionsUrl: "http://sessions.test",
      mementosUrl: "http://mementos.test",
    });

    const result = await connector.ingestSession("sess-1");
    expect(result.status).toBe("skipped");
    expect(result.message).toContain("too short");
  });

  it("queues ingest when transcript is valid", async () => {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/transcript")) {
        return Response.json({ transcript: "x".repeat(60) });
      }
      if (url.includes("/api/sessions/ingest") && init?.method === "POST") {
        return Response.json({ job_id: "job-123", message: "queued" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const connector = new OpenSessionsConnector({
      openSessionsUrl: "http://sessions.test",
      mementosUrl: "http://mementos.test",
      defaultAgentId: "agent-1",
    });

    const result = await connector.ingestSession("sess-2");
    expect(result.status).toBe("queued");
    expect(result.jobId).toBe("job-123");
  });

  it("syncRecentSessions ingests listed sessions", async () => {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/api/sessions?")) {
        return Response.json({ sessions: [{ id: "s1" }, { id: "s2" }] });
      }
      if (url.includes("/transcript")) {
        return Response.json({ transcript: "y".repeat(80) });
      }
      if (url.includes("/api/sessions/ingest")) {
        return Response.json({ job_id: "job-x", message: "ok" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const connector = new OpenSessionsConnector({
      openSessionsUrl: "http://sessions.test",
      mementosUrl: "http://mementos.test",
    });

    const results = await connector.syncRecentSessions({ limit: 2 });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === "queued")).toBe(true);
  });
});

describe("connectorFromEnv", () => {
  const originalEnv = process.env["OPEN_SESSIONS_URL"];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["OPEN_SESSIONS_URL"];
    } else {
      process.env["OPEN_SESSIONS_URL"] = originalEnv;
    }
  });

  it("throws when OPEN_SESSIONS_URL is missing", () => {
    delete process.env["OPEN_SESSIONS_URL"];
    expect(() => connectorFromEnv()).toThrow("OPEN_SESSIONS_URL");
  });

  it("builds connector from environment", () => {
    process.env["OPEN_SESSIONS_URL"] = "http://sessions.test";
    const connector = connectorFromEnv();
    expect(connector).toBeInstanceOf(OpenSessionsConnector);
  });
});
