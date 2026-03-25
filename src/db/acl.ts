/**
 * Memory Access Control Lists (ACLs).
 *
 * Fine-grained permissions beyond scopes: read-only, read-write, admin
 * per agent per key pattern. Default: no ACLs = full access (backward compat).
 */

import { SqliteAdapter as Database } from "@hasna/cloud";
import { getDatabase, uuid } from "./database.js";

export type AclPermission = "read" | "readwrite" | "admin";

export interface MemoryAcl {
  id: string;
  agent_id: string;
  key_pattern: string;
  permission: AclPermission;
  project_id: string | null;
  created_at: string;
}

/**
 * Set an ACL rule. Upserts by agent_id + key_pattern.
 */
export function setAcl(
  agentId: string,
  keyPattern: string,
  permission: AclPermission,
  projectId?: string,
  db?: Database
): MemoryAcl {
  const d = db || getDatabase();
  const id = uuid();
  d.run(
    `INSERT INTO memory_acl (id, agent_id, key_pattern, permission, project_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, key_pattern) DO UPDATE SET permission=excluded.permission`,
    [id, agentId, keyPattern, permission, projectId || null]
  );
  // Need unique index for upsert — add it if not exists
  try {
    d.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_acl_agent_pattern ON memory_acl(agent_id, key_pattern)");
  } catch { /* already exists */ }

  return { id, agent_id: agentId, key_pattern: keyPattern, permission, project_id: projectId || null, created_at: new Date().toISOString() };
}

/**
 * List ACLs for an agent.
 */
export function listAcls(agentId: string, db?: Database): MemoryAcl[] {
  const d = db || getDatabase();
  return d.query("SELECT * FROM memory_acl WHERE agent_id = ? ORDER BY key_pattern").all(agentId) as MemoryAcl[];
}

/**
 * Remove an ACL rule.
 */
export function removeAcl(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM memory_acl WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Check if an agent has the required permission for a memory key.
 * Returns true if allowed (no ACLs = full access).
 */
export function checkPermission(
  agentId: string,
  memoryKey: string,
  requiredPermission: "read" | "write",
  db?: Database
): boolean {
  const d = db || getDatabase();

  // If no ACLs exist for this agent, allow everything (backward compat)
  const aclCount = (d.query("SELECT COUNT(*) as c FROM memory_acl WHERE agent_id = ?").get(agentId) as { c: number }).c;
  if (aclCount === 0) return true;

  // Find matching ACL rules (glob pattern match using LIKE)
  const acls = d.query(
    "SELECT permission FROM memory_acl WHERE agent_id = ? AND ? LIKE REPLACE(REPLACE(key_pattern, '*', '%'), '?', '_')"
  ).all(agentId, memoryKey) as { permission: AclPermission }[];

  if (acls.length === 0) {
    // Agent has ACLs but none match this key — deny by default
    return false;
  }

  // Check if any matching ACL grants sufficient permission
  const permLevel: Record<AclPermission, number> = { read: 1, readwrite: 2, admin: 3 };
  const requiredLevel = requiredPermission === "read" ? 1 : 2;
  return acls.some((acl) => permLevel[acl.permission] >= requiredLevel);
}
