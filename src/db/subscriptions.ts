// ============================================================================
// Memory subscriptions domain.
//
// Agents subscribe to memory-change notifications by key/tag/scope pattern.
// Transport-aware like every domain module: API mode routes to the self-hosted
// HTTP API; local mode runs SQL against SQLite. The subscription table is a
// shared coordination surface, so in the cloud it must live server-side — the
// MCP tools that expose subscribe/unsubscribe/inject route through here.
// ============================================================================

import { SqliteAdapter as Database } from "../storage.js";
import { getDatabase } from "./database.js";
import { isApiMode, apiJson } from "./api-mode.js";

export interface Subscription {
  id: string;
  agent_id: string;
  key_pattern: string | null;
  tag_pattern: string | null;
  scope: string | null;
}

export interface CreateSubscriptionInput {
  agent_id: string;
  key_pattern?: string | null;
  tag_pattern?: string | null;
  scope?: string | null;
}

export function createSubscription(input: CreateSubscriptionInput, db?: Database): Subscription {
  if (!db && isApiMode()) {
    const { data } = apiJson<Subscription>("POST", "/subscriptions", input);
    return data;
  }
  const d = db || getDatabase();
  const id = crypto.randomUUID().slice(0, 8);
  d.run(
    `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, tag_pattern, scope, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [id, input.agent_id, input.key_pattern || null, input.tag_pattern || null, input.scope || null]
  );
  return {
    id,
    agent_id: input.agent_id,
    key_pattern: input.key_pattern || null,
    tag_pattern: input.tag_pattern || null,
    scope: input.scope || null,
  };
}

export function deleteSubscription(id: string, db?: Database): boolean {
  if (!db && isApiMode()) {
    const { status } = apiJson<{ deleted: boolean }>("DELETE", `/subscriptions/${encodeURIComponent(id)}`, undefined, { allow404: true });
    return status !== 404;
  }
  const d = db || getDatabase();
  const result = d.run("DELETE FROM memory_subscriptions WHERE id = ?", [id]);
  return result.changes > 0;
}

/**
 * Compute human-readable change notifications for an agent: recently changed
 * memories (last 10 minutes) matching that agent's subscriptions, excluding the
 * agent's own writes. Encapsulates the whole two-query workflow so callers
 * (memory_inject) never touch SQLite directly.
 */
export function getSubscriptionNotifications(agentId: string, db?: Database): string[] {
  if (!db && isApiMode()) {
    const { data } = apiJson<{ changes: string[] }>(
      "GET",
      `/subscriptions/notifications?agent_id=${encodeURIComponent(agentId)}`
    );
    return data?.changes ?? [];
  }
  const d = db || getDatabase();
  const changes: string[] = [];
  try {
    const subs = d
      .query("SELECT key_pattern, tag_pattern, scope FROM memory_subscriptions WHERE agent_id = ?")
      .all(agentId) as Array<{ key_pattern: string | null; tag_pattern: string | null; scope: string | null }>;
    if (subs.length === 0) return changes;

    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    for (const sub of subs) {
      let sql = "SELECT key, updated_at FROM memories WHERE updated_at > ? AND status = 'active'";
      const params: (string | null)[] = [cutoff];
      if (sub.key_pattern) {
        sql += " AND key LIKE ?";
        params.push(sub.key_pattern.replace(/\*/g, "%"));
      }
      if (sub.scope) {
        sql += " AND scope = ?";
        params.push(sub.scope);
      }
      sql += " AND COALESCE(agent_id, '') != ? LIMIT 5";
      params.push(agentId);
      const matches = d.query(sql).all(...params) as Array<{ key: string; updated_at: string }>;
      for (const m of matches) changes.push(`${m.key} (updated ${m.updated_at})`);
    }
  } catch {
    // memory_subscriptions table may not exist yet — no notifications
  }
  return changes;
}
