import { describe, test, expect } from "bun:test";
import { addRoute, matchRoute } from "./router.js";

describe("router param decoding", () => {
  // Register a route with a single path param.
  addRoute("GET", "/api/projects/:id", () => new Response("ok"));

  test("percent-decodes an encoded path param (project path)", () => {
    // Client sends getProject("/tmp") → GET /projects/%2Ftmp. The router must
    // hand the handler the decoded "/tmp" so it resolves by path, not "%2Ftmp".
    const matched = matchRoute("GET", "/api/projects/%2Ftmp");
    expect(matched).not.toBeNull();
    expect(matched!.params["id"]).toBe("/tmp");
  });

  test("decodes spaces in a name param", () => {
    const matched = matchRoute("GET", "/api/projects/my%20project");
    expect(matched!.params["id"]).toBe("my project");
  });

  test("passes a plain UUID through unchanged", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const matched = matchRoute("GET", `/api/projects/${id}`);
    expect(matched!.params["id"]).toBe(id);
  });

  test("falls back to the raw value on a malformed escape", () => {
    const matched = matchRoute("GET", "/api/projects/100%");
    expect(matched).not.toBeNull();
    expect(matched!.params["id"]).toBe("100%");
  });
});
