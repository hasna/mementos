import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  json,
  errorResponse,
  readJson,
  authenticateRequest,
  getSearchParams,
  resolveDashboardDir,
  CORS_HEADERS,
  MIME_TYPES,
} from "./helpers.js";

describe("json", () => {
  test("returns a Response with JSON body", async () => {
    const res = json({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ hello: "world" });
  });

  test("returns a custom status code", () => {
    const res = json({ error: "not found" }, 404);
    expect(res.status).toBe(404);
  });

  test("includes CORS headers", () => {
    const res = json({ ok: true });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeTruthy();
  });
});

describe("errorResponse", () => {
  test("returns error JSON with status", async () => {
    const res = errorResponse("Something went wrong", 500);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Something went wrong" });
  });

  test("includes details when provided", async () => {
    const res = errorResponse("Validation failed", 400, { field: "name" });
    const body = await res.json();
    expect(body["details"]).toEqual({ field: "name" });
  });
});

describe("readJson", () => {
  test("parses valid JSON body", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
      body: JSON.stringify({ key: "value" }),
    });
    const data = await readJson(req);
    expect(data).toEqual({ key: "value" });
  });

  test("returns null for empty body", async () => {
    const req = new Request("http://localhost/test", {
      method: "POST",
    });
    const data = await readJson(req);
    expect(data).toBeNull();
  });

  test("rejects oversized payload", async () => {
    const largeBody = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
    const req = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": String(2 * 1024 * 1024) },
      body: largeBody,
    });
    const data = await readJson(req);
    expect(data).toBeNull();
  });
});

describe("authenticateRequest", () => {
  const originalKey = process.env.MEMENTOS_API_KEY;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.MEMENTOS_API_KEY = originalKey;
    } else {
      delete process.env.MEMENTOS_API_KEY;
    }
  });

  test("returns null when no API key is configured", () => {
    delete process.env.MEMENTOS_API_KEY;
    const req = new Request("http://localhost/test");
    expect(authenticateRequest(req)).toBeNull();
  });

  test("returns null when API key matches", () => {
    process.env.MEMENTOS_API_KEY = "secret123";
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(authenticateRequest(req)).toBeNull();
  });

  test("returns 401 when no Authorization header", () => {
    process.env.MEMENTOS_API_KEY = "secret123";
    const req = new Request("http://localhost/test");
    const res = authenticateRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 401 when missing Bearer prefix", () => {
    process.env.MEMENTOS_API_KEY = "secret123";
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "secret123" },
    });
    const res = authenticateRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("returns 403 when API key does not match", () => {
    process.env.MEMENTOS_API_KEY = "secret123";
    const req = new Request("http://localhost/test", {
      headers: { Authorization: "Bearer wrongkey" },
    });
    const res = authenticateRequest(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});

describe("getSearchParams", () => {
  test("parses URL search params into an object", () => {
    const url = new URL("http://localhost/test?a=1&b=hello&c=true");
    const params = getSearchParams(url);
    expect(params).toEqual({ a: "1", b: "hello", c: "true" });
  });

  test("returns empty object for no params", () => {
    const url = new URL("http://localhost/test");
    const params = getSearchParams(url);
    expect(params).toEqual({});
  });
});

describe("resolveDashboardDir", () => {
  test("returns a string path", () => {
    const dir = resolveDashboardDir();
    expect(typeof dir).toBe("string");
    expect(dir).toContain("dashboard");
  });

  test("ends with dashboard/dist", () => {
    const dir = resolveDashboardDir();
    expect(dir.endsWith("dashboard/dist")).toBe(true);
  });
});

describe("CORS_HEADERS", () => {
  test("has allow-origin", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBeTruthy();
  });

  test("has allow-methods", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("DELETE");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("OPTIONS");
  });
});

describe("MIME_TYPES", () => {
  test("has common mime types", () => {
    expect(MIME_TYPES[".html"]).toContain("text/html");
    expect(MIME_TYPES[".js"]).toContain("javascript");
    expect(MIME_TYPES[".json"]).toContain("application/json");
    expect(MIME_TYPES[".css"]).toContain("text/css");
    expect(MIME_TYPES[".svg"]).toContain("image/svg+xml");
    expect(MIME_TYPES[".png"]).toContain("image/png");
    expect(MIME_TYPES[".ico"]).toContain("image/x-icon");
  });
});
