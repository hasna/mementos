process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase, shortUuid } from "../../db/database.js";
import { createEntity } from "../../db/entities.js";
import { formatGraphError, resolveGraphId, resolveEntityParam } from "./graph-utils.js";

describe("graph-utils", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("formats graph errors from Error and non-Error values", () => {
    expect(formatGraphError(new Error("boom"))).toBe("boom");
    expect(formatGraphError("plain")).toBe("plain");
    expect(formatGraphError(42)).toBe("42");
  });

  it("resolves partial memory ids", () => {
    const db = getDatabase();
    const id = shortUuid();
    db.run(
      `INSERT INTO memories (id, key, value, category, scope, importance, source, status, created_at, updated_at)
       VALUES (?, 'test-key', 'value', 'knowledge', 'global', 5, 'agent', 'active', datetime('now'), datetime('now'))`,
      [id]
    );

    expect(resolveGraphId(id.slice(0, 4), "memories")).toBe(id);
    expect(() => resolveGraphId("zzzz", "memories")).toThrow("Could not resolve ID");
  });

  it("resolves entities by name, id, or partial id", () => {
    const db = getDatabase();
    const entity = createEntity({ name: "TypeScript", type: "tool" }, db);

    expect(resolveEntityParam("TypeScript").id).toBe(entity.id);
    expect(resolveEntityParam(entity.id).id).toBe(entity.id);
    expect(resolveEntityParam(entity.id.slice(0, 4)).id).toBe(entity.id);
    expect(() => resolveEntityParam("MissingEntity")).toThrow("Entity not found");
  });
});
