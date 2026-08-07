process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { resetDatabase } from "../db/database.js";
import { matchRoute } from "./router.js";
import "./routes/project-registration.js";

beforeEach(() => {
  resetDatabase();
});

describe("project registration server routes", () => {
  test("the canonical v1 capability request reaches the authenticated API route table", async () => {
    const matched = matchRoute("GET", "/api/project-registration/capability");
    expect(matched).not.toBeNull();
    const request = new Request("http://mementos.test/v1/project-registration/capability");
    const response = await matched!.handler(request, new URL(request.url), matched!.params);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      capability: {
        authority: "mementos",
        route: "mementos.project-registration.v1",
        supported_resources: ["project"],
        immutable_receipts: true,
        guarded_update: true,
        no_write_dry_run: true,
        expected_revision_compare_and_swap: true,
        caller_idempotency: true,
        exact_inverse_rollback: true,
      },
    });
  });
});
