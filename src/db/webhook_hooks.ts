import { SqliteAdapter as Database } from "@hasna/cloud";
type SQLQueryBindings = string | number | null | boolean;
import { getDatabase, now, shortUuid } from "./database.js";
import type { WebhookHook, HookType } from "../types/hooks.js";

// ============================================================================
// Helpers
// ============================================================================

function parseRow(row: Record<string, unknown>): WebhookHook {
  return {
    id: row["id"] as string,
    type: row["type"] as HookType,
    handlerUrl: row["handler_url"] as string,
    priority: row["priority"] as number,
    blocking: Boolean(row["blocking"]),
    agentId: (row["agent_id"] as string) || undefined,
    projectId: (row["project_id"] as string) || undefined,
    description: (row["description"] as string) || undefined,
    enabled: Boolean(row["enabled"]),
    createdAt: row["created_at"] as string,
    invocationCount: row["invocation_count"] as number,
    failureCount: row["failure_count"] as number,
  };
}

// ============================================================================
// Create
// ============================================================================

export interface CreateWebhookHookInput {
  type: HookType;
  handlerUrl: string;
  priority?: number;
  blocking?: boolean;
  agentId?: string;
  projectId?: string;
  description?: string;
}

export function createWebhookHook(
  input: CreateWebhookHookInput,
  db?: Database
): WebhookHook {
  const d = db || getDatabase();
  const id = shortUuid();
  const timestamp = now();

  d.run(
    `INSERT INTO webhook_hooks
       (id, type, handler_url, priority, blocking, agent_id, project_id, description, enabled, created_at, invocation_count, failure_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0)`,
    [
      id,
      input.type,
      input.handlerUrl,
      input.priority ?? 50,
      input.blocking ? 1 : 0,
      input.agentId ?? null,
      input.projectId ?? null,
      input.description ?? null,
      timestamp,
    ]
  );

  return getWebhookHook(id, d)!;
}

// ============================================================================
// Read
// ============================================================================

export function getWebhookHook(id: string, db?: Database): WebhookHook | null {
  const d = db || getDatabase();
  const row = d
    .query("SELECT * FROM webhook_hooks WHERE id = ?")
    .get(id) as Record<string, unknown> | null;
  return row ? parseRow(row) : null;
}

export function listWebhookHooks(
  filter: { type?: HookType; enabled?: boolean } = {},
  db?: Database
): WebhookHook[] {
  const d = db || getDatabase();
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.type) {
    conditions.push("type = ?");
    params.push(filter.type);
  }
  if (filter.enabled !== undefined) {
    conditions.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = d
    .query(`SELECT * FROM webhook_hooks ${where} ORDER BY priority ASC, created_at ASC`)
    .all(...params) as Record<string, unknown>[];

  return rows.map(parseRow);
}

// ============================================================================
// Update
// ============================================================================

export function updateWebhookHook(
  id: string,
  updates: { enabled?: boolean; description?: string; priority?: number },
  db?: Database
): WebhookHook | null {
  const d = db || getDatabase();
  const existing = getWebhookHook(id, d);
  if (!existing) return null;

  const sets: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (updates.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(updates.enabled ? 1 : 0);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.priority !== undefined) {
    sets.push("priority = ?");
    params.push(updates.priority);
  }

  if (sets.length > 0) {
    params.push(id);
    d.run(`UPDATE webhook_hooks SET ${sets.join(", ")} WHERE id = ?`, params);
  }

  return getWebhookHook(id, d);
}

// ============================================================================
// Delete
// ============================================================================

export function deleteWebhookHook(id: string, db?: Database): boolean {
  const d = db || getDatabase();
  const result = d.run("DELETE FROM webhook_hooks WHERE id = ?", [id]);
  return result.changes > 0;
}

// ============================================================================
// Stats tracking
// ============================================================================

export function recordWebhookInvocation(
  id: string,
  success: boolean,
  db?: Database
): void {
  const d = db || getDatabase();
  if (success) {
    d.run(
      "UPDATE webhook_hooks SET invocation_count = invocation_count + 1 WHERE id = ?",
      [id]
    );
  } else {
    d.run(
      "UPDATE webhook_hooks SET invocation_count = invocation_count + 1, failure_count = failure_count + 1 WHERE id = ?",
      [id]
    );
  }
}
