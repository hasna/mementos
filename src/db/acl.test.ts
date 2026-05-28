process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database.js";
import { setAcl, listAcls, removeAcl, checkPermission } from "./acl.js";

describe("memory ACL", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("allows all access when no ACLs exist for agent", () => {
    const db = getDatabase();
    expect(checkPermission("agent-1", "any-key", "read", db)).toBe(true);
    expect(checkPermission("agent-1", "any-key", "write", db)).toBe(true);
  });

  it("sets, lists, and upserts ACL rules", () => {
    const db = getDatabase();
    setAcl("agent-1", "project-*", "read", undefined, db);
    setAcl("agent-1", "project-*", "readwrite", undefined, db);

    const acls = listAcls("agent-1", db);
    expect(acls).toHaveLength(1);
    expect(acls[0]!.key_pattern).toBe("project-*");
    expect(acls[0]!.permission).toBe("readwrite");
  });

  it("matches glob patterns for read and write checks", () => {
    const db = getDatabase();
    setAcl("agent-1", "project-*", "read", undefined, db);
    setAcl("agent-1", "secret-*", "admin", undefined, db);

    expect(checkPermission("agent-1", "project-stack", "read", db)).toBe(true);
    expect(checkPermission("agent-1", "project-stack", "write", db)).toBe(false);
    expect(checkPermission("agent-1", "secret-key", "write", db)).toBe(true);
    expect(checkPermission("agent-1", "other-key", "read", db)).toBe(false);
  });

  it("removes ACL rules by id", () => {
    const db = getDatabase();
    const acl = setAcl("agent-1", "temp-*", "read", undefined, db);

    expect(removeAcl(acl.id, db)).toBe(true);
    expect(listAcls("agent-1", db)).toHaveLength(0);
    expect(checkPermission("agent-1", "temp-key", "read", db)).toBe(true);
    expect(removeAcl("missing", db)).toBe(false);
  });
});
