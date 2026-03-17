#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  cleanExpiredMemories,
  getMemoryVersions,
} from "../db/memories.js";
import { registerAgent, getAgent, listAgents, listAgentsByProject, updateAgent, touchAgent } from "../db/agents.js";
import { setFocus, getFocus, unfocus, resolveProjectId } from "../lib/focus.js";
import {
  acquireMemoryWriteLock,
  releaseMemoryWriteLock,
  checkMemoryWriteLock,
} from "../lib/memory-lock.js";
import { acquireLock, releaseLock, checkLock, listAgentLocks, cleanExpiredLocks } from "../db/locks.js";
import {
  registerProject,
  listProjects,
  getProject,
} from "../db/projects.js";
import { createEntity, getEntity, getEntityByName, listEntities, updateEntity, deleteEntity, mergeEntities } from "../db/entities.js";
import { createRelation, getRelation, listRelations, deleteRelation, getEntityGraph, findPath } from "../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity } from "../db/entity-memories.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { searchMemories } from "../lib/search.js";
import { detectProject } from "../lib/project-detect.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
  InvalidScopeError,
} from "../types/index.js";
import { parseDuration } from "../lib/duration.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryStats,
  MemoryFilter,
  CreateMemoryInput,
  Entity,
  EntityType,
} from "../types/index.js";

import { hookRegistry } from "../lib/hooks.js";
import { loadWebhooksFromDb } from "../lib/built-in-hooks.js";
import {
  createWebhookHook,
  listWebhookHooks,
  updateWebhookHook,
  deleteWebhookHook,
} from "../db/webhook_hooks.js";
import { runSynthesis, rollbackSynthesis, getSynthesisStatus } from "../lib/synthesis/index.js";
import { listSynthesisRuns } from "../db/synthesis.js";
import { createSessionJob, getSessionJob, listSessionJobs } from "../db/session-jobs.js";
import { enqueueSessionJob } from "../lib/session-queue.js";

// Read version from package.json — never hardcode
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

const server = new McpServer({
  name: "mementos",
  version: _pkg.version,
});

// ============================================================================
// Auto-project detection (lazy init, cached)
// ============================================================================

let _autoProjectInitialized = false;

function ensureAutoProject(): void {
  if (_autoProjectInitialized) return;
  _autoProjectInitialized = true;
  try {
    detectProject();
  } catch {
    // Silently ignore — auto-detection is best-effort
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatError(error: unknown): string {
  if (error instanceof VersionConflictError) return `Version conflict: ${error.message}`;
  if (error instanceof MemoryNotFoundError) return `Not found: ${error.message}`;
  if (error instanceof DuplicateMemoryError) return `Duplicate: ${error.message}`;
  if (error instanceof InvalidScopeError) return `Invalid scope: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveId(partialId: string, table = "memories"): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

function formatMemory(m: Memory): string {
  const parts = [
    `ID: ${m.id}`,
    `Key: ${m.key}`,
    `Value: ${m.value}`,
    `Scope: ${m.scope}`,
    `Category: ${m.category}`,
    `Importance: ${m.importance}/10`,
    `Source: ${m.source}`,
    `Status: ${m.status}`,
  ];
  if (m.summary) parts.push(`Summary: ${m.summary}`);
  if (m.tags.length > 0) parts.push(`Tags: ${m.tags.join(", ")}`);
  if (m.pinned) parts.push(`Pinned: yes`);
  if (m.agent_id) parts.push(`Agent: ${m.agent_id}`);
  if (m.project_id) parts.push(`Project: ${m.project_id}`);
  if (m.session_id) parts.push(`Session: ${m.session_id}`);
  if (m.expires_at) parts.push(`Expires: ${m.expires_at}`);
  parts.push(`Access count: ${m.access_count}`);
  parts.push(`Version: ${m.version}`);
  parts.push(`Created: ${m.created_at}`);
  parts.push(`Updated: ${m.updated_at}`);
  if (m.accessed_at) parts.push(`Last accessed: ${m.accessed_at}`);
  return parts.join("\n");
}

// ============================================================================
// Memory Tools
// ============================================================================

server.tool(
  "memory_save",
  "Save/upsert a memory. scope: global=all agents, shared=project, private=single agent.",
  {
    key: z.string(),
    value: z.string(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    summary: z.string().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    ttl_ms: z.union([z.string(), z.number()]).optional(),
    source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const input = { ...args } as Record<string, unknown>;
      if (args.ttl_ms !== undefined) {
        input.ttl_ms = parseDuration(args.ttl_ms);
      }
      // Focus mode: auto-set project_id from agent focus if not provided
      if (!input.project_id && input.agent_id) {
        const focusedProject = resolveProjectId(input.agent_id as string, null);
        if (focusedProject) input.project_id = focusedProject;
      }
      const memory = createMemory(input as unknown as CreateMemoryInput);
      if (args.agent_id) touchAgent(args.agent_id);
      return { content: [{ type: "text" as const, text: `Saved: ${memory.key} (${memory.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_recall",
  "Recall a memory by key. Returns the best matching active memory.",
  {
    key: z.string(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      // Focus mode: auto-scope if agent is focused and no explicit scope/project_id
      let effectiveProjectId = args.project_id;
      if (!args.scope && !args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }
      const memory = getMemoryByKey(args.key, args.scope, args.agent_id, effectiveProjectId, args.session_id);
      if (memory) {
        touchMemory(memory.id);
        if (args.agent_id) touchAgent(args.agent_id);
        return { content: [{ type: "text" as const, text: formatMemory(memory) }] };
      }

      // Fuzzy fallback: search for the key and return the top result
      const results = searchMemories(args.key, {
        scope: args.scope,
        agent_id: args.agent_id,
        project_id: effectiveProjectId,
        session_id: args.session_id,
        limit: 1,
      });
      if (results.length > 0) {
        const best = results[0]!;
        touchMemory(best.memory.id);
        return {
          content: [{
            type: "text" as const,
            text: `No exact match for key "${args.key}", showing best result (score: ${best.score.toFixed(2)}, match: ${best.match_type}):\n${formatMemory(best.memory)}`,
          }],
        };
      }

      return { content: [{ type: "text" as const, text: `No memory found for key: ${args.key}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_get",
  "Get a single memory by ID.",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const id = resolveId(args.id);
      const memory = getMemory(id);
      if (!memory) {
        return { content: [{ type: "text" as const, text: `Memory not found: ${args.id}` }] };
      }
      touchMemory(memory.id);
      return { content: [{ type: "text" as const, text: formatMemory(memory) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_versions",
  "Get version history for a memory. Shows what changed across updates.",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const id = resolveId(args.id);
      const memory = getMemory(id);
      if (!memory) {
        return { content: [{ type: "text" as const, text: `Memory not found: ${args.id}` }] };
      }
      const versions = getMemoryVersions(id);
      if (versions.length === 0) {
        return { content: [{ type: "text" as const, text: `No version history for "${memory.key}" (current: v${memory.version})` }] };
      }
      const lines = versions.map(v =>
        `v${v.version} [${v.created_at.slice(0, 16)}] scope=${v.scope} importance=${v.importance} status=${v.status}\n  value: ${v.value.slice(0, 120)}${v.value.length > 120 ? "..." : ""}`
      );
      return {
        content: [{
          type: "text" as const,
          text: `Version history for "${memory.key}" (${versions.length} version${versions.length === 1 ? "" : "s"}, current: v${memory.version}):\n\n${lines.join("\n\n")}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_list",
  "List memories. Default: compact lines. full=true for complete JSON objects.",
  {
    scope: z.enum(["global", "shared", "private"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    tags: z.array(z.string()).optional(),
    min_importance: z.coerce.number().optional(),
    pinned: z.boolean().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    status: z.enum(["active", "archived", "expired"]).optional(),
    limit: z.coerce.number().optional(),
    offset: z.coerce.number().optional(),
    full: z.boolean().optional(),
    fields: z.array(z.string()).optional(),
  },
  async (args) => {
    try {
      const { full, fields, ...filterArgs } = args;
      // Focus mode: if agent is focused and no explicit scope/project_id, auto-scope
      let resolvedFilter = { ...filterArgs };
      if (!resolvedFilter.scope && !resolvedFilter.project_id && resolvedFilter.agent_id) {
        const focusedProject = resolveProjectId(resolvedFilter.agent_id, null);
        if (focusedProject) resolvedFilter.project_id = focusedProject;
      }
      const filter: MemoryFilter = {
        ...resolvedFilter,
        limit: resolvedFilter.limit || 10,
      };
      const memories = listMemories(filter);
      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories found." }] };
      }
      if (full) {
        // Full mode: complete JSON objects (strip nulls, optionally filter fields)
        const compact = memories.map(m => {
          const obj = Object.fromEntries(
            Object.entries(m).filter(([k, v]) => {
              if (v === null || v === undefined) return false;
              if (fields && fields.length > 0) return fields.includes(k);
              return true;
            })
          );
          return obj;
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(compact, null, 2) }] };
      }
      // Compact mode (default): key+value+scope+importance+id only
      const lines = memories.map((m, i) =>
        `${i + 1}. [${m.scope}/${m.category}] ${m.key} = ${m.value.slice(0, 100)}${m.value.length > 100 ? "..." : ""} (imp:${m.importance} id:${m.id.slice(0, 8)})`
      );
      return { content: [{ type: "text" as const, text: `${memories.length} memories:\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_update",
  "Update a memory's metadata (value, importance, tags, etc.). version is optional — auto-fetched if omitted.",
  {
    id: z.string(),
    value: z.string().optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    summary: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
    status: z.enum(["active", "archived", "expired"]).optional(),
    metadata: z.record(z.unknown()).optional(),
    expires_at: z.string().nullable().optional(),
    version: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const id = resolveId(args.id);
      const { id: _id, version, ...updateFields } = args;
      // Auto-fetch version if not provided (eliminates the need for a prior read)
      const resolvedVersion = version ?? getMemory(id)?.version;
      if (resolvedVersion === undefined) {
        return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }] };
      }
      const memory = updateMemory(id, { ...updateFields, version: resolvedVersion });
      return { content: [{ type: "text" as const, text: `Memory updated:\n${formatMemory(memory)}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_pin",
  "Pin or unpin a memory by ID or key. No version needed.",
  {
    id: z.string().optional(),
    key: z.string().optional(),
    pinned: z.boolean().optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      let memory = args.id ? getMemory(resolveId(args.id)) : getMemoryByKey(args.key!, args.scope, args.agent_id, args.project_id);
      if (!memory) return { content: [{ type: "text" as const, text: `Memory not found.` }] };
      const pinned = args.pinned !== false; // default to pin=true
      updateMemory(memory.id, { pinned, version: memory.version });
      return { content: [{ type: "text" as const, text: `Memory "${memory.key}" ${pinned ? "pinned" : "unpinned"}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_archive",
  "Archive a memory by ID or key (hides from lists, keeps history). No version needed.",
  {
    id: z.string().optional(),
    key: z.string().optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      let memory = args.id ? getMemory(resolveId(args.id)) : getMemoryByKey(args.key!, args.scope, args.agent_id, args.project_id);
      if (!memory) return { content: [{ type: "text" as const, text: `Memory not found.` }] };
      updateMemory(memory.id, { status: "archived", version: memory.version });
      return { content: [{ type: "text" as const, text: `Memory "${memory.key}" archived.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_forget",
  "Delete a memory by ID or key",
  {
    id: z.string().optional(),
    key: z.string().optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      if (args.id) {
        const id = resolveId(args.id);
        const deleted = deleteMemory(id);
        return { content: [{ type: "text" as const, text: deleted ? `Memory ${id} deleted.` : `Memory not found.` }] };
      }
      if (args.key) {
        const memory = getMemoryByKey(args.key, args.scope, args.agent_id, args.project_id);
        if (!memory) {
          return { content: [{ type: "text" as const, text: `No memory found for key: ${args.key}` }] };
        }
        deleteMemory(memory.id);
        return { content: [{ type: "text" as const, text: `Memory "${args.key}" (${memory.id}) deleted.` }] };
      }
      return { content: [{ type: "text" as const, text: "Either id or key must be provided." }], isError: true };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_stale",
  "Find memories not accessed recently. Useful for cleanup or review.",
  {
    days: z.coerce.number().optional(),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const days = args.days || 30;
      const db = getDatabase();
      const conditions = [
        "status = 'active'",
        `(accessed_at IS NULL OR accessed_at < datetime('now', '-${days} days'))`,
        "pinned = 0",
      ];
      const params: string[] = [];
      if (args.project_id) { conditions.push("project_id = ?"); params.push(args.project_id); }
      if (args.agent_id) { conditions.push("agent_id = ?"); params.push(args.agent_id); }
      const limit = args.limit || 20;
      const rows = db.query(
        `SELECT id, key, value, importance, scope, category, accessed_at, access_count FROM memories WHERE ${conditions.join(" AND ")} ORDER BY COALESCE(accessed_at, created_at) ASC LIMIT ?`
      ).all(...params, limit) as { id: string; key: string; value: string; importance: number; scope: string; category: string; accessed_at: string | null; access_count: number }[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No stale memories found (last accessed > ${days} days ago).` }] };
      }
      const lines = rows.map((m) =>
        `[${m.importance}] ${m.key} (${m.scope}/${m.category}) — last accessed: ${m.accessed_at?.slice(0, 10) || "never"}, ${m.access_count} reads`
      );
      return { content: [{ type: "text" as const, text: `${rows.length} stale memor${rows.length === 1 ? "y" : "ies"} (not accessed in ${days}+ days):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_search",
  "Search memories by keyword across key, value, summary, and tags",
  {
    query: z.string(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      // Focus mode: auto-scope if agent is focused and no explicit scope/project_id
      let effectiveProjectId = args.project_id;
      if (!args.scope && !args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }
      const filter: MemoryFilter = {
        scope: args.scope,
        category: args.category,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: effectiveProjectId,
        session_id: args.session_id,
        search: args.query,
        limit: args.limit || 20,
      };
      const memories = listMemories(filter);
      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: `No memories found matching "${args.query}".` }] };
      }
      const lines = memories.map((m, i) =>
        `${i + 1}. [${m.scope}/${m.category}] ${m.key} = ${m.value.slice(0, 100)}${m.value.length > 100 ? "..." : ""} (importance: ${m.importance})`
      );
      return { content: [{ type: "text" as const, text: `${memories.length} result(s) for "${args.query}":\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_stats",
  "Get aggregate statistics about stored memories",
  {},
  async () => {
    try {
      const db = getDatabase();
      const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;
      const byScope = db.query("SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY scope").all() as { scope: MemoryScope; c: number }[];
      const byCategory = db.query("SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' GROUP BY category").all() as { category: MemoryCategory; c: number }[];
      const byStatus = db.query("SELECT status, COUNT(*) as c FROM memories GROUP BY status").all() as { status: string; c: number }[];
      const pinnedCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE pinned = 1 AND status = 'active'").get() as { c: number }).c;
      const expiredCount = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))").get() as { c: number }).c;

      const stats: MemoryStats = {
        total,
        by_scope: { global: 0, shared: 0, private: 0 },
        by_category: { preference: 0, fact: 0, knowledge: 0, history: 0 },
        by_status: { active: 0, archived: 0, expired: 0 },
        by_agent: {},
        pinned_count: pinnedCount,
        expired_count: expiredCount,
      };
      for (const row of byScope) stats.by_scope[row.scope] = row.c;
      for (const row of byCategory) stats.by_category[row.category] = row.c;
      for (const row of byStatus) {
        if (row.status in stats.by_status) {
          stats.by_status[row.status as keyof typeof stats.by_status] = row.c;
        }
      }

      const byAgent = db.query("SELECT agent_id, COUNT(*) as c FROM memories WHERE status = 'active' AND agent_id IS NOT NULL GROUP BY agent_id").all() as { agent_id: string; c: number }[];
      for (const row of byAgent) stats.by_agent[row.agent_id] = row.c;

      const lines = [
        `Total active: ${stats.total}`,
        `By scope: global=${stats.by_scope.global}, shared=${stats.by_scope.shared}, private=${stats.by_scope.private}`,
        `By category: preference=${stats.by_category.preference}, fact=${stats.by_category.fact}, knowledge=${stats.by_category.knowledge}, history=${stats.by_category.history}`,
        `Pinned: ${stats.pinned_count}`,
        `Expired: ${stats.expired_count}`,
      ];
      if (Object.keys(stats.by_agent).length > 0) {
        lines.push(`By agent: ${Object.entries(stats.by_agent).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_activity",
  "Get daily memory creation activity over N days.",
  {
    days: z.coerce.number().optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const days = Math.min(args.days || 30, 365);
      const db = getDatabase();
      const conditions: string[] = ["status = 'active'"];
      const params: string[] = [];
      if (args.scope) { conditions.push("scope = ?"); params.push(args.scope); }
      if (args.agent_id) { conditions.push("agent_id = ?"); params.push(args.agent_id); }
      if (args.project_id) { conditions.push("project_id = ?"); params.push(args.project_id); }
      const where = conditions.slice(1).map(c => `AND ${c}`).join(" ");

      const rows = db.query(`
        SELECT date(created_at) AS date, COUNT(*) AS memories_created
        FROM memories
        WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${where}
        GROUP BY date(created_at)
        ORDER BY date ASC
      `).all(...params) as { date: string; memories_created: number }[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No memory activity in last ${days} days.` }] };
      }
      const total = rows.reduce((s, r) => s + r.memories_created, 0);
      const lines = rows.map(r => `${r.date}: ${r.memories_created} memor${r.memories_created === 1 ? "y" : "ies"}`);
      return { content: [{ type: "text" as const, text: `Memory activity (last ${days} days — ${total} total):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_report",
  "Get a rich summary report: totals, activity trend, top memories, scope/category breakdown.",
  {
    days: z.coerce.number().optional(),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
  },
  async (args) => {
    try {
      const days = Math.min(args.days || 7, 365);
      const db = getDatabase();
      const cond = [args.project_id ? "AND project_id = ?" : "", args.agent_id ? "AND agent_id = ?" : ""].filter(Boolean).join(" ");
      const params: string[] = [...(args.project_id ? [args.project_id] : []), ...(args.agent_id ? [args.agent_id] : [])];

      const total = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' ${cond}`).get(...params) as { c: number }).c;
      const pinned = (db.query(`SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1 ${cond}`).get(...params) as { c: number }).c;

      const actRows = db.query(`SELECT date(created_at) AS d, COUNT(*) AS cnt FROM memories WHERE status = 'active' AND date(created_at) >= date('now', '-${days} days') ${cond} GROUP BY d ORDER BY d`).all(...params) as { d: string; cnt: number }[];
      const recentTotal = actRows.reduce((s, r) => s + r.cnt, 0);
      const sparkline = actRows.length > 0 ? actRows.map(r => { const bars = "▁▂▃▄▅▆▇█"; const max = Math.max(...actRows.map(x => x.cnt), 1); return bars[Math.round((r.cnt / max) * 7)] || "▁"; }).join("") : "—";

      const byScopeRows = db.query(`SELECT scope, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY scope`).all(...params) as { scope: string; c: number }[];
      const byCatRows = db.query(`SELECT category, COUNT(*) as c FROM memories WHERE status = 'active' ${cond} GROUP BY category`).all(...params) as { category: string; c: number }[];
      const topMems = db.query(`SELECT key, value, importance FROM memories WHERE status = 'active' ${cond} ORDER BY importance DESC, access_count DESC LIMIT 5`).all(...params) as { key: string; value: string; importance: number }[];

      const lines = [
        `Memory Report (last ${days} days)`,
        `Total: ${total} (${pinned} pinned) | Recent: +${recentTotal} | Activity: ${sparkline}`,
        `Scopes: ${byScopeRows.map(r => `${r.scope}=${r.c}`).join(" ")}`,
        `Categories: ${byCatRows.map(r => `${r.category}=${r.c}`).join(" ")}`,
        topMems.length > 0 ? `\nTop memories:\n${topMems.map(m => `  [${m.importance}] ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`).join("\n")}` : "",
      ].filter(Boolean);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_export",
  "Export memories as JSON",
  {
    scope: z.enum(["global", "shared", "private"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const memories = listMemories({ ...args, limit: 10000 });
      return { content: [{ type: "text" as const, text: JSON.stringify(memories, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_import",
  "Import memories from JSON array",
  {
    memories: z.array(z.object({
      key: z.string(),
      value: z.string(),
      scope: z.enum(["global", "shared", "private"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
      importance: z.coerce.number().optional(),
      tags: z.array(z.string()).optional(),
      summary: z.string().optional(),
      source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    })),
    overwrite: z.boolean().optional(),
  },
  async (args) => {
    try {
      let imported = 0;
      const dedupeMode = args.overwrite === false ? "create" as const : "merge" as const;
      for (const mem of args.memories) {
        createMemory({ ...mem, source: mem.source || "imported" } as CreateMemoryInput, dedupeMode);
        imported++;
      }
      return { content: [{ type: "text" as const, text: `Imported ${imported} memor${imported === 1 ? "y" : "ies"}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_inject",
  "Get memory context for system prompt injection. Selects by scope, importance, recency.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    max_tokens: z.coerce.number().optional(),
    categories: z.array(z.enum(["preference", "fact", "knowledge", "history"])).optional(),
    min_importance: z.coerce.number().optional(),
    format: z.enum(["xml", "markdown", "compact", "json"]).optional(),
    raw: z.boolean().optional(),
  },
  async (args) => {
    try {
      const maxTokens = args.max_tokens || 500;
      const minImportance = args.min_importance || 3;
      const categories = args.categories || ["preference", "fact", "knowledge"];

      // Collect memories from all visible scopes
      const allMemories: Memory[] = [];

      // Global memories
      const globalMems = listMemories({
        scope: "global",
        category: categories as MemoryCategory[],
        min_importance: minImportance,
        status: "active",
        project_id: args.project_id,
        limit: 50,
      });
      allMemories.push(...globalMems);

      // Shared memories (project-scoped)
      if (args.project_id) {
        const sharedMems = listMemories({
          scope: "shared",
          category: categories as MemoryCategory[],
          min_importance: minImportance,
          status: "active",
          project_id: args.project_id,
          limit: 50,
        });
        allMemories.push(...sharedMems);
      }

      // Private memories (agent-scoped)
      if (args.agent_id) {
        const privateMems = listMemories({
          scope: "private",
          category: categories as MemoryCategory[],
          min_importance: minImportance,
          status: "active",
          agent_id: args.agent_id,
          limit: 50,
        });
        allMemories.push(...privateMems);
      }

      // Deduplicate by ID
      const seen = new Set<string>();
      const unique = allMemories.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // Sort by importance DESC, then recency
      unique.sort((a, b) => {
        if (b.importance !== a.importance) return b.importance - a.importance;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      });

      // resolve format: new `format` param takes priority, legacy `raw` maps to compact
      const fmt = args.format ?? (args.raw ? "compact" : "xml");

      // PreMemoryInject: blocking hooks can filter/reorder the memories array
      const preCtx = {
        memories: unique,
        format: fmt,
        agentId: args.agent_id,
        projectId: args.project_id,
        sessionId: args.session_id,
        timestamp: Date.now(),
      };
      const shouldProceed = await hookRegistry.runHooks("PreMemoryInject", preCtx);
      if (!shouldProceed) {
        return { content: [{ type: "text" as const, text: "Injection cancelled by hook." }] };
      }

      // Build context within token budget (~4 chars per token estimate)
      const charBudget = maxTokens * 4;
      const lines: string[] = [];
      let totalChars = 0;

      for (const m of preCtx.memories) {
        let line: string;
        if (fmt === "compact") {
          line = `${m.key}: ${m.value}`;
        } else if (fmt === "json") {
          line = JSON.stringify({ key: m.key, value: m.value, scope: m.scope, category: m.category, importance: m.importance });
        } else {
          line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
        }
        if (totalChars + line.length > charBudget) break;
        lines.push(line);
        totalChars += line.length;
        touchMemory(m.id);
      }

      if (lines.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found for injection." }] };
      }

      let context: string;
      if (fmt === "compact") {
        context = lines.join("\n");
      } else if (fmt === "json") {
        context = `[${lines.join(",")}]`;
      } else if (fmt === "markdown") {
        context = `## Agent Memories\n\n${lines.join("\n")}`;
      } else {
        context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
      }
      // PostMemoryInject: fire-and-forget
      void hookRegistry.runHooks("PostMemoryInject", {
        memoriesCount: lines.length,
        format: fmt,
        contextLength: context.length,
        agentId: args.agent_id,
        projectId: args.project_id,
        sessionId: args.session_id,
        timestamp: Date.now(),
      });

      return { content: [{ type: "text" as const, text: context }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Hook Management Tools
// ============================================================================

server.tool(
  "hook_list",
  "List all registered hooks in the in-memory registry (built-in + webhooks).",
  { type: z.string().optional() },
  async (args) => {
    try {
      const hooks = hookRegistry.list(args.type as Parameters<typeof hookRegistry.list>[0]);
      const items = hooks.map((h) => ({
        id: h.id,
        type: h.type,
        blocking: h.blocking,
        priority: h.priority,
        builtin: h.builtin ?? false,
        agentId: h.agentId,
        projectId: h.projectId,
        description: h.description,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(items, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "hook_stats",
  "Get statistics about registered hooks: total, by type, blocking vs non-blocking.",
  {},
  async () => {
    try {
      const stats = hookRegistry.stats();
      return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "webhook_create",
  "Create a persistent HTTP webhook hook. The URL will be POSTed with the hook context as JSON.",
  {
    type: z.enum([
      "PreMemorySave", "PostMemorySave", "PreMemoryUpdate", "PostMemoryUpdate",
      "PreMemoryDelete", "PostMemoryDelete", "PreEntityCreate", "PostEntityCreate",
      "PreRelationCreate", "PostRelationCreate", "OnSessionStart", "OnSessionEnd",
      "PreMemoryInject", "PostMemoryInject",
    ]),
    handler_url: z.string(),
    priority: z.coerce.number().min(0).max(100).optional(),
    blocking: z.boolean().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    description: z.string().optional(),
  },
  async (args) => {
    try {
      const { reloadWebhooks } = await import("../lib/built-in-hooks.js");
      const wh = createWebhookHook({
        type: args.type,
        handlerUrl: args.handler_url,
        priority: args.priority,
        blocking: args.blocking,
        agentId: args.agent_id,
        projectId: args.project_id,
        description: args.description,
      });
      // Reload so the new webhook is immediately active
      reloadWebhooks();
      return { content: [{ type: "text" as const, text: JSON.stringify(wh, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "webhook_list",
  "List all persisted webhook hooks.",
  { type: z.string().optional(), enabled: z.boolean().optional() },
  async (args) => {
    try {
      const webhooks = listWebhookHooks({
        type: args.type as import("../types/hooks.js").HookType | undefined,
        enabled: args.enabled,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(webhooks, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "webhook_delete",
  "Delete a persisted webhook hook by ID.",
  { id: z.string() },
  async (args) => {
    try {
      const deleted = deleteWebhookHook(args.id);
      if (!deleted) {
        return { content: [{ type: "text" as const, text: `Webhook not found: ${args.id}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Deleted webhook ${args.id}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "webhook_update",
  "Enable, disable, or update a persisted webhook hook.",
  {
    id: z.string(),
    enabled: z.boolean().optional(),
    priority: z.coerce.number().optional(),
    description: z.string().optional(),
  },
  async (args) => {
    try {
      const updated = updateWebhookHook(args.id, {
        enabled: args.enabled,
        priority: args.priority,
        description: args.description,
      });
      if (!updated) {
        return { content: [{ type: "text" as const, text: `Webhook not found: ${args.id}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(updated, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Synthesis Tools
// ============================================================================

server.tool(
  "memory_synthesize",
  "Run ALMA synthesis: analyze memory corpus, find redundancies, propose and apply consolidations.",
  {
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    dry_run: z.boolean().optional(),
    max_proposals: z.coerce.number().optional(),
    provider: z.string().optional(),
  },
  async (args) => {
    try {
      const result = await runSynthesis({
        projectId: args.project_id,
        agentId: args.agent_id,
        dryRun: args.dry_run ?? false,
        maxProposals: args.max_proposals,
        provider: args.provider,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({
        run_id: result.run.id,
        status: result.run.status,
        corpus_size: result.run.corpus_size,
        proposals_generated: result.run.proposals_generated,
        proposals_accepted: result.run.proposals_accepted,
        dry_run: result.dryRun,
        metrics: result.metrics ? { corpus_reduction: result.metrics.corpusReduction, deduplication_rate: result.metrics.deduplicationRate } : null,
      }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_synthesis_status",
  "Get the status of synthesis runs.",
  { project_id: z.string().optional(), run_id: z.string().optional() },
  async (args) => {
    try {
      const status = getSynthesisStatus(args.run_id, args.project_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_synthesis_history",
  "List past synthesis runs.",
  { project_id: z.string().optional(), limit: z.coerce.number().optional() },
  async (args) => {
    try {
      const runs = listSynthesisRuns({ project_id: args.project_id, limit: args.limit ?? 20 });
      return { content: [{ type: "text" as const, text: JSON.stringify(runs, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_synthesis_rollback",
  "Roll back a synthesis run, reversing all applied proposals.",
  { run_id: z.string() },
  async (args) => {
    try {
      const result = await rollbackSynthesis(args.run_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Agent Tools
// ============================================================================

server.tool(
  "register_agent",
  "Register an agent. Idempotent — same name returns existing agent.",
  {
    name: z.string(),
    session_id: z.string().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const agent = registerAgent(args.name, args.session_id, args.description, args.role, args.project_id);
      return {
        content: [{
          type: "text" as const,
          text: `Agent registered:\nID: ${agent.id}\nName: ${agent.name}\nRole: ${agent.role || "agent"}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "list_agents",
  "List all registered agents",
  {},
  async () => {
    try {
      const agents = listAgents();
      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: "No agents registered." }] };
      }
      const lines = agents.map((a) => `${a.id} | ${a.name} | ${a.role || "agent"} | project: ${a.active_project_id || "-"} | last seen: ${a.last_seen_at}`);
      return { content: [{ type: "text" as const, text: `${agents.length} agent(s):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "get_agent",
  "Get agent details by ID or name",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const agent = getAgent(args.id);
      if (!agent) {
        return { content: [{ type: "text" as const, text: `Agent not found: ${args.id}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Agent:\nID: ${agent.id}\nName: ${agent.name}\nDescription: ${agent.description || "-"}\nRole: ${agent.role || "agent"}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "update_agent",
  "Update agent name, description, role, metadata, or active_project_id.",
  {
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    active_project_id: z.string().nullable().optional(),
  },
  async (args) => {
    try {
      const { id, ...updates } = args;
      const agent = updateAgent(id, updates);
      if (!agent) {
        return { content: [{ type: "text" as const, text: `Agent not found: ${id}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Agent updated:\nID: ${agent.id}\nName: ${agent.name}\nDescription: ${agent.description || "-"}\nRole: ${agent.role || "agent"}\nActive project: ${agent.active_project_id || "-"}\nLast seen: ${agent.last_seen_at}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "list_agents_by_project",
  "List agents currently active on a project.",
  {
    project_id: z.string(),
  },
  async (args) => {
    try {
      const agents = listAgentsByProject(args.project_id);
      if (agents.length === 0) {
        return { content: [{ type: "text" as const, text: `No active agents for project: ${args.project_id}` }] };
      }
      const lines = agents.map((a) => `${a.id} | ${a.name} | ${a.role || "agent"} | last seen: ${a.last_seen_at}`);
      return { content: [{ type: "text" as const, text: `${agents.length} agent(s) on project ${args.project_id}:\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Project Tools
// ============================================================================

server.tool(
  "register_project",
  "Register a project for memory scoping",
  {
    name: z.string(),
    path: z.string(),
    description: z.string().optional(),
    memory_prefix: z.string().optional(),
  },
  async (args) => {
    try {
      const project = registerProject(args.name, args.path, args.description, args.memory_prefix);
      return {
        content: [{
          type: "text" as const,
          text: `Project registered:\nID: ${project.id}\nName: ${project.name}\nPath: ${project.path}\nCreated: ${project.created_at}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "list_projects",
  "List all registered projects",
  {},
  async () => {
    try {
      const projects = listProjects();
      if (projects.length === 0) {
        return { content: [{ type: "text" as const, text: "No projects registered." }] };
      }
      const lines = projects.map((p) => `${p.id.slice(0, 8)} | ${p.name} | ${p.path}`);
      return { content: [{ type: "text" as const, text: `${projects.length} project(s):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "get_project",
  "Get a project by ID, path, or name.",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const project = getProject(args.id);
      if (!project) {
        return { content: [{ type: "text" as const, text: `Project not found: ${args.id}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Project:\nID: ${project.id}\nName: ${project.name}\nPath: ${project.path}\nDescription: ${project.description || "-"}\nCreated: ${project.created_at}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Bulk Tools
// ============================================================================

server.tool(
  "bulk_forget",
  "Delete multiple memories by IDs",
  {
    ids: z.array(z.string()),
  },
  async (args) => {
    try {
      const resolvedIds = args.ids.map((id) => resolveId(id));
      const deleted = bulkDeleteMemories(resolvedIds);
      return { content: [{ type: "text" as const, text: `Deleted ${deleted} memor${deleted === 1 ? "y" : "ies"}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "bulk_update",
  "Update multiple memories with the same changes",
  {
    ids: z.array(z.string()),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    status: z.enum(["active", "archived", "expired"]).optional(),
  },
  async (args) => {
    try {
      let updated = 0;
      const { ids, ...fields } = args;
      for (const partialId of ids) {
        const id = resolveId(partialId);
        const memory = getMemory(id);
        if (memory) {
          updateMemory(id, { ...fields, version: memory.version });
          updated++;
        }
      }
      return { content: [{ type: "text" as const, text: `Updated ${updated} memor${updated === 1 ? "y" : "ies"}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Utility Tools
// ============================================================================

server.tool(
  "clean_expired",
  "Remove expired memories from the database",
  {},
  async () => {
    try {
      const cleaned = cleanExpiredMemories();
      return { content: [{ type: "text" as const, text: `Cleaned ${cleaned} expired memor${cleaned === 1 ? "y" : "ies"}.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "session_extract",
  "Extract memories from a session summary. Auto-creates structured memories from title, topics, notes.",
  {
    session_id: z.string(),
    title: z.string().optional(),
    project: z.string().optional(),
    model: z.string().optional(),
    messages: z.coerce.number().optional(),
    key_topics: z.array(z.string()).optional(),
    summary: z.string().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const { session_id, title, project, model, messages, key_topics, summary, agent_id, project_id } = args;
      const created: string[] = [];

      function saveExtracted(key: string, value: string, category: MemoryCategory, importance: number): void {
        try {
          const mem = createMemory({
            key, value, category, scope: "shared", importance,
            source: "auto", agent_id, project_id, session_id,
          } as unknown as CreateMemoryInput);
          created.push(mem.id);
        } catch { /* duplicate = already extracted */ }
      }

      if (title) {
        const meta = [project && `project: ${project}`, model && `model: ${model}`, messages && `messages: ${messages}`].filter(Boolean).join(", ");
        saveExtracted(`session-${session_id}-summary`, `${title}${meta ? ` (${meta})` : ""}`, "history", 6);
      }
      if (key_topics?.length) {
        saveExtracted(`session-${session_id}-topics`, `Key topics: ${key_topics.join(", ")}`, "knowledge", 5);
      }
      if (summary) {
        saveExtracted(`session-${session_id}-notes`, summary, "knowledge", 7);
      }

      return {
        content: [{
          type: "text" as const,
          text: `Extracted ${created.length} memor${created.length === 1 ? "y" : "ies"} from session ${session_id}.${created.length > 0 ? `\nIDs: ${created.join(", ")}` : ""}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_context",
  "Get memories relevant to current context, filtered by scope/importance/recency.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const filter: MemoryFilter = {
        scope: args.scope,
        agent_id: args.agent_id,
        project_id: args.project_id,
        status: "active",
        limit: args.limit || 30,
      };
      const memories = listMemories(filter);
      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories in current context." }] };
      }
      const lines = memories.map((m) =>
        `[${m.scope}/${m.category}] ${m.key}: ${m.value} (importance: ${m.importance})`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Knowledge Graph Tools
// ============================================================================

function resolveEntityParam(nameOrId: string, type?: string): Entity {
  const byName = getEntityByName(nameOrId, type as EntityType | undefined);
  if (byName) return byName;
  try { return getEntity(nameOrId); } catch { /* not found */ }
  const db = getDatabase();
  const id = resolvePartialId(db, "entities", nameOrId);
  if (id) return getEntity(id);
  throw new Error(`Entity not found: ${nameOrId}`);
}

server.tool(
  "entity_create",
  "Create a knowledge graph entity (person, project, tool, concept, file, api, pattern, organization).",
  {
    name: z.string(),
    type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]),
    description: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const entity = createEntity(args);
      return { content: [{ type: "text" as const, text: `Entity: ${entity.name} [${entity.type}] (${entity.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_get",
  "Get entity details by name or ID, including relations summary and memory count.",
  {
    name_or_id: z.string(),
    type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]).optional(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.name_or_id, args.type);
      const relations = listRelations({ entity_id: entity.id });
      const memories = getMemoriesForEntity(entity.id);
      const lines = [
        `ID: ${entity.id}`,
        `Name: ${entity.name}`,
        `Type: ${entity.type}`,
      ];
      if (entity.description) lines.push(`Description: ${entity.description}`);
      if (entity.project_id) lines.push(`Project: ${entity.project_id}`);
      lines.push(`Relations: ${relations.length}`);
      lines.push(`Memories: ${memories.length}`);
      lines.push(`Created: ${entity.created_at}`);
      lines.push(`Updated: ${entity.updated_at}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_list",
  "List entities. Optional filters: type, project_id, search, limit.",
  {
    type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]).optional(),
    project_id: z.string().optional(),
    search: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const entities = listEntities({ ...args, limit: args.limit || 50 });
      if (entities.length === 0) {
        return { content: [{ type: "text" as const, text: "No entities found." }] };
      }
      const lines = entities.map(e => `${e.id.slice(0, 8)} | ${e.type} | ${e.name}`);
      return { content: [{ type: "text" as const, text: `${entities.length} entit${entities.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_delete",
  "Delete an entity by name or ID.",
  {
    name_or_id: z.string(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.name_or_id);
      deleteEntity(entity.id);
      return { content: [{ type: "text" as const, text: `Deleted: ${entity.name} [${entity.type}] (${entity.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_merge",
  "Merge source entity into target. Moves all relations and memory links.",
  {
    source: z.string(),
    target: z.string(),
  },
  async (args) => {
    try {
      const sourceEntity = resolveEntityParam(args.source);
      const targetEntity = resolveEntityParam(args.target);
      const merged = mergeEntities(sourceEntity.id, targetEntity.id);
      return { content: [{ type: "text" as const, text: `Merged: ${sourceEntity.name} → ${merged.name} [${merged.type}] (${merged.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_link",
  "Link an entity to a memory with a role (subject, object, or context).",
  {
    entity_name_or_id: z.string(),
    memory_id: z.string(),
    role: z.enum(["subject", "object", "context"]).optional(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const memoryId = resolveId(args.memory_id);
      const link = linkEntityToMemory(entity.id, memoryId, args.role || "context");
      return { content: [{ type: "text" as const, text: `Linked: ${entity.name} → memory ${memoryId.slice(0, 8)} [${link.role}]` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_update",
  "Update an entity's name, description, or metadata.",
  {
    entity_name_or_id: z.string(),
    name: z.string().optional(),
    description: z.string().nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const { entity_name_or_id: _id, ...updates } = args;
      const updated = updateEntity(entity.id, updates);
      return { content: [{ type: "text" as const, text: `Updated entity: ${updated.name} (${updated.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "entity_unlink",
  "Unlink a memory from an entity.",
  {
    entity_name_or_id: z.string(),
    memory_id: z.string(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const memoryId = resolveId(args.memory_id);
      unlinkEntityFromMemory(entity.id, memoryId);
      return { content: [{ type: "text" as const, text: `Unlinked: ${entity.name} ↛ memory ${memoryId.slice(0, 8)}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "relation_get",
  "Get a relation by ID.",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const relation = getRelation(args.id);
      if (!relation) return { content: [{ type: "text" as const, text: `Relation not found: ${args.id}` }] };
      return { content: [{ type: "text" as const, text: `Relation ${relation.id.slice(0, 8)}: ${relation.source_entity_id.slice(0, 8)} —[${relation.relation_type}]→ ${relation.target_entity_id.slice(0, 8)} (weight: ${relation.weight})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "relation_create",
  "Create a relation between two entities (uses, knows, depends_on, created_by, related_to, contradicts, part_of, implements).",
  {
    source_entity: z.string(),
    target_entity: z.string(),
    relation_type: z.enum(["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"]),
    weight: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const source = resolveEntityParam(args.source_entity);
      const target = resolveEntityParam(args.target_entity);
      const relation = createRelation({
        source_entity_id: source.id,
        target_entity_id: target.id,
        relation_type: args.relation_type,
        weight: args.weight,
      });
      return { content: [{ type: "text" as const, text: `Relation: ${source.name} —[${relation.relation_type}]→ ${target.name} (${relation.id.slice(0, 8)})` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "relation_list",
  "List relations for an entity. Filter by type and direction (outgoing, incoming, both).",
  {
    entity_name_or_id: z.string(),
    relation_type: z.enum(["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"]).optional(),
    direction: z.enum(["outgoing", "incoming", "both"]).optional(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const relations = listRelations({
        entity_id: entity.id,
        relation_type: args.relation_type,
        direction: args.direction || "both",
      });
      if (relations.length === 0) {
        return { content: [{ type: "text" as const, text: `No relations found for: ${entity.name}` }] };
      }
      const lines = relations.map(r =>
        `${r.id.slice(0, 8)} | ${r.source_entity_id.slice(0, 8)} —[${r.relation_type}]→ ${r.target_entity_id.slice(0, 8)} (w:${r.weight})`
      );
      return { content: [{ type: "text" as const, text: `${relations.length} relation(s) for ${entity.name}:\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "relation_delete",
  "Delete a relation by ID.",
  {
    id: z.string(),
  },
  async (args) => {
    try {
      const id = resolveId(args.id, "relations");
      deleteRelation(id);
      return { content: [{ type: "text" as const, text: `Relation ${id.slice(0, 8)} deleted.` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "graph_query",
  "Traverse the knowledge graph from an entity up to N hops. Returns entities and relations.",
  {
    entity_name_or_id: z.string(),
    depth: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const depth = args.depth ?? 2;
      const graph = getEntityGraph(entity.id, depth);
      if (graph.entities.length === 0) {
        return { content: [{ type: "text" as const, text: `No graph found for: ${entity.name}` }] };
      }
      const entityLines = graph.entities.map(e => `  ${e.id.slice(0, 8)} | ${e.type} | ${e.name}`);
      const relationLines = graph.relations.map(r =>
        `  ${r.source_entity_id.slice(0, 8)} —[${r.relation_type}]→ ${r.target_entity_id.slice(0, 8)}`
      );
      const lines = [
        `Graph for ${entity.name} (depth ${depth}):`,
        `Entities (${graph.entities.length}):`,
        ...entityLines,
      ];
      if (relationLines.length > 0) {
        lines.push(`Relations (${graph.relations.length}):`, ...relationLines);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "graph_path",
  "Find shortest path between two entities in the knowledge graph.",
  {
    from_entity: z.string(),
    to_entity: z.string(),
    max_depth: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const from = resolveEntityParam(args.from_entity);
      const to = resolveEntityParam(args.to_entity);
      const maxDepth = args.max_depth ?? 5;
      const path = findPath(from.id, to.id, maxDepth);
      if (!path || path.length === 0) {
        return { content: [{ type: "text" as const, text: `No path found: ${from.name} → ${to.name} (max depth ${maxDepth})` }] };
      }
      const pathStr = path.map(e => e.name).join(" → ");
      return { content: [{ type: "text" as const, text: `Path: ${pathStr}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "graph_stats",
  "Get entity and relation counts by type.",
  {},
  async () => {
    try {
      const db = getDatabase();
      const entityTotal = (db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
      const byType = db.query("SELECT type, COUNT(*) as c FROM entities GROUP BY type").all() as { type: string; c: number }[];
      const relationTotal = (db.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }).c;
      const byRelType = db.query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type").all() as { relation_type: string; c: number }[];
      const linkTotal = (db.query("SELECT COUNT(*) as c FROM entity_memories").get() as { c: number }).c;

      const lines = [
        `Entities: ${entityTotal}`,
      ];
      if (byType.length > 0) {
        lines.push(`  By type: ${byType.map(r => `${r.type}=${r.c}`).join(", ")}`);
      }
      lines.push(`Relations: ${relationTotal}`);
      if (byRelType.length > 0) {
        lines.push(`  By type: ${byRelType.map(r => `${r.relation_type}=${r.c}`).join(", ")}`);
      }
      lines.push(`Entity-memory links: ${linkTotal}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Meta-tools: search_tools + describe_tools (lean stubs — on-demand schema docs)
// ============================================================================

type ToolParam = {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string; enum?: string[] };
};

type ToolSchema = {
  description: string;
  category: string;
  params: Record<string, ToolParam>;
  example?: string;
};

const FULL_SCHEMAS: Record<string, ToolSchema> = {
  memory_save: {
    description: "Save/upsert a memory. Creates new or merges with existing key.",
    category: "memory",
    params: {
      key: { type: "string", description: "Unique key for the memory (kebab-case recommended)", required: true },
      value: { type: "string", description: "The memory content", required: true },
      scope: { type: "string", description: "Visibility: global=all agents, shared=project, private=single agent", enum: ["global", "shared", "private"] },
      category: { type: "string", description: "Memory type", enum: ["preference", "fact", "knowledge", "history"] },
      importance: { type: "number", description: "Priority 1-10 (10=critical)" },
      tags: { type: "array", description: "Searchable tags", items: { type: "string" } },
      summary: { type: "string", description: "Short summary for display" },
      agent_id: { type: "string", description: "Agent UUID to scope this memory to" },
      project_id: { type: "string", description: "Project UUID to scope this memory to" },
      session_id: { type: "string", description: "Session UUID" },
      ttl_ms: { type: "string|number", description: "Time-to-live e.g. '7d', '2h', or ms integer" },
      source: { type: "string", description: "Origin of the memory", enum: ["user", "agent", "system", "auto", "imported"] },
      metadata: { type: "object", description: "Arbitrary JSON metadata" },
    },
    example: '{"key":"preferred-language","value":"TypeScript","scope":"global","importance":8,"tags":["language","preference"]}',
  },
  memory_versions: {
    description: "Get full version history for a memory — all past values, scopes, importance scores.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)", required: true },
    },
    example: '{"id":"abc12345"}',
  },
  memory_get: {
    description: "Get a single memory by ID (partial IDs resolved).",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (full or partial)", required: true },
    },
    example: '{"id":"abc12345"}',
  },
  memory_recall: {
    description: "Recall a memory by exact key. Falls back to fuzzy search if no exact match.",
    category: "memory",
    params: {
      key: { type: "string", description: "Key to look up", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session UUID filter" },
    },
    example: '{"key":"preferred-language","scope":"global"}',
  },
  memory_list: {
    description: "List memories with optional filters. Returns compact lines by default.",
    category: "memory",
    params: {
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history"] },
      tags: { type: "array", description: "Filter by tags (AND logic)", items: { type: "string" } },
      min_importance: { type: "number", description: "Minimum importance threshold" },
      pinned: { type: "boolean", description: "Filter to pinned memories only" },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session UUID filter" },
      status: { type: "string", description: "Memory status filter", enum: ["active", "archived", "expired"] },
      limit: { type: "number", description: "Max results (default 50)" },
      offset: { type: "number", description: "Pagination offset" },
      full: { type: "boolean", description: "Return full JSON objects instead of compact lines" },
      fields: { type: "array", description: "Fields to include in full mode", items: { type: "string" } },
    },
    example: '{"scope":"global","min_importance":7,"limit":20}',
  },
  memory_update: {
    description: "Update a memory's fields. version is optional — auto-fetched if omitted (eliminates 2-round-trip pattern).",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)", required: true },
      version: { type: "number", description: "Current version for conflict detection (omit to auto-fetch)" },
      value: { type: "string", description: "New value" },
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history"] },
      scope: { type: "string", description: "New scope", enum: ["global", "shared", "private"] },
      importance: { type: "number", description: "New importance 1-10" },
      tags: { type: "array", description: "New tags (replaces all)", items: { type: "string" } },
      summary: { type: "string", description: "New summary (null to clear)" },
      pinned: { type: "boolean", description: "Pin/unpin the memory" },
      status: { type: "string", description: "New status", enum: ["active", "archived", "expired"] },
      metadata: { type: "object", description: "New metadata (replaces existing)" },
      expires_at: { type: "string", description: "New expiry ISO timestamp (null to clear)" },
    },
    example: '{"id":"abc123","version":1,"importance":9,"tags":["correction","important"]}',
  },
  memory_pin: {
    description: "Pin or unpin a memory by ID or key. No version required.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID" },
      key: { type: "string", description: "Memory key (alternative to id)" },
      pinned: { type: "boolean", description: "true=pin (default), false=unpin" },
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private"] },
    },
    example: '{"key":"project-stack","pinned":true}',
  },
  memory_archive: {
    description: "Archive a memory by ID or key. Hides from lists, preserves history. No version required.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID" },
      key: { type: "string", description: "Memory key (alternative to id)" },
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private"] },
    },
    example: '{"key":"old-project-stack"}',
  },
  memory_forget: {
    description: "Delete a memory by ID or key.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)" },
      key: { type: "string", description: "Memory key" },
      scope: { type: "string", description: "Scope for key lookup", enum: ["global", "shared", "private"] },
      agent_id: { type: "string", description: "Agent UUID for key lookup" },
      project_id: { type: "string", description: "Project UUID for key lookup" },
    },
    example: '{"key":"old-preference","scope":"global"}',
  },
  memory_stale: {
    description: "Find memories not accessed recently — useful for cleanup review (same pattern as get_stale_tasks in todos).",
    category: "memory",
    params: {
      days: { type: "number", description: "Stale threshold in days (default 30)" },
      project_id: { type: "string", description: "Filter by project" },
      agent_id: { type: "string", description: "Filter by agent" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"days":14,"project_id":"proj-uuid"}',
  },
  memory_search: {
    description: "Full-text search across key, value, summary, and tags.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history"] },
      tags: { type: "array", description: "Tag filter", items: { type: "string" } },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session ID filter" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"typescript","scope":"global","limit":10}',
  },
  memory_activity: {
    description: "Get daily memory creation counts over N days (max 365). Like 'git log --stat' for memories.",
    category: "memory",
    params: {
      days: { type: "number", description: "Number of days to look back (default 30)" },
      scope: { type: "string", description: "Filter by scope", enum: ["global", "shared", "private"] },
      agent_id: { type: "string", description: "Filter by agent" },
      project_id: { type: "string", description: "Filter by project" },
    },
    example: '{"days":14,"project_id":"proj-uuid"}',
  },
  memory_stats: {
    description: "Aggregate statistics: total, by scope, by category, pinned, expired counts.",
    category: "memory",
    params: {},
    example: "{}",
  },
  memory_export: {
    description: "Export memories as a JSON array.",
    category: "memory",
    params: {
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"scope":"global"}',
  },
  memory_import: {
    description: "Import memories from a JSON array. Merges by key by default.",
    category: "memory",
    params: {
      memories: { type: "array", description: "Array of memory objects with key+value (required), plus optional fields", required: true, items: { type: "object" } },
      overwrite: { type: "boolean", description: "false=create-only (skip existing keys), default=merge" },
    },
    example: '{"memories":[{"key":"foo","value":"bar","scope":"global","importance":7}]}',
  },
  memory_inject: {
    description: "Get formatted memory context for system prompt injection. Respects token budget.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID to include private memories" },
      project_id: { type: "string", description: "Project UUID to include shared memories" },
      session_id: { type: "string", description: "Session UUID" },
      max_tokens: { type: "number", description: "Approximate token budget (default 500)" },
      categories: { type: "array", description: "Categories to include (default: preference, fact, knowledge)", items: { type: "string", enum: ["preference", "fact", "knowledge", "history"] } },
      min_importance: { type: "number", description: "Minimum importance (default 3)" },
      format: { type: "string", description: "Output format: xml (default, <agent-memories>), compact (key: value, ~60% smaller), markdown, json", enum: ["xml", "compact", "markdown", "json"] },
      raw: { type: "boolean", description: "Deprecated: use format=compact instead. true=plain lines only" },
    },
    example: '{"project_id":"proj-uuid","max_tokens":300,"min_importance":5,"format":"compact"}',
  },
  session_extract: {
    description: "Auto-create memories from a session summary (title, topics, notes, project). Designed for sessions→mementos integration.",
    category: "memory",
    params: {
      session_id: { type: "string", description: "Session ID to link memories to", required: true },
      title: { type: "string", description: "Session title" },
      project: { type: "string", description: "Project name" },
      model: { type: "string", description: "Model used" },
      messages: { type: "number", description: "Message count" },
      key_topics: { type: "array", description: "Key topics extracted from session", items: { type: "string" } },
      summary: { type: "string", description: "Free-form session summary text" },
      agent_id: { type: "string", description: "Agent ID to associate memories with" },
      project_id: { type: "string", description: "Project ID to scope memories to" },
    },
    example: '{"session_id":"abc123","title":"Fix auth middleware","project":"alumia","key_topics":["jwt","compliance"],"agent_id":"galba-id"}',
  },
  memory_context: {
    description: "Get active memories for the current context (agent/project/scope).",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private"] },
      limit: { type: "number", description: "Max results (default 30)" },
    },
    example: '{"project_id":"proj-uuid","scope":"shared","limit":20}',
  },
  register_agent: {
    description: "Register an agent. Idempotent — same name returns existing agent.",
    category: "agent",
    params: {
      name: { type: "string", description: "Agent name (e.g. 'maximus', 'cassius')", required: true },
      description: { type: "string", description: "Agent description" },
      role: { type: "string", description: "Agent role (default: 'agent')" },
    },
    example: '{"name":"maximus","role":"developer"}',
  },
  list_agents: {
    description: "List all registered agents with IDs, names, roles, and last-seen timestamps.",
    category: "agent",
    params: {},
    example: "{}",
  },
  get_agent: {
    description: "Get agent details by UUID or name.",
    category: "agent",
    params: {
      id: { type: "string", description: "Agent UUID or name", required: true },
    },
    example: '{"id":"maximus"}',
  },
  update_agent: {
    description: "Update agent name, description, role, metadata, or active_project_id. Call on session start to bind agent to current project.",
    category: "agent",
    params: {
      id: { type: "string", description: "Agent UUID or name", required: true },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description" },
      role: { type: "string", description: "New role" },
      metadata: { type: "object", description: "New metadata" },
      active_project_id: { type: "string", description: "Project ID this agent is currently working on (null to clear)" },
    },
    example: '{"id":"galba","active_project_id":"80a0be92-e0cc-4710-bce4-fb8a2e78e69e"}',
  },
  list_agents_by_project: {
    description: "List all agents currently active on a specific project.",
    category: "agent",
    params: {
      project_id: { type: "string", description: "Project ID", required: true },
    },
    example: '{"project_id":"80a0be92-e0cc-4710-bce4-fb8a2e78e69e"}',
  },
  register_project: {
    description: "Register a project for memory scoping. Idempotent by name.",
    category: "project",
    params: {
      name: { type: "string", description: "Project name (use git repo name)", required: true },
      path: { type: "string", description: "Absolute path to project root", required: true },
      description: { type: "string", description: "Project description" },
      memory_prefix: { type: "string", description: "Key prefix for project memories" },
    },
    example: '{"name":"open-mementos","path":"/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-mementos"}',
  },
  list_projects: {
    description: "List all registered projects with IDs, names, and paths.",
    category: "project",
    params: {},
    example: "{}",
  },
  get_project: {
    description: "Get a project by ID, path, or name.",
    category: "project",
    params: {
      id: { type: "string", description: "Project ID, path, or name", required: true },
    },
    example: '{"id":"open-mementos"}',
  },
  bulk_forget: {
    description: "Delete multiple memories by IDs in one call.",
    category: "bulk",
    params: {
      ids: { type: "array", description: "Array of memory IDs (partials OK)", required: true, items: { type: "string" } },
    },
    example: '{"ids":["abc123","def456"]}',
  },
  bulk_update: {
    description: "Apply the same field updates to multiple memories.",
    category: "bulk",
    params: {
      ids: { type: "array", description: "Array of memory IDs (partials OK)", required: true, items: { type: "string" } },
      importance: { type: "number", description: "New importance 1-10" },
      tags: { type: "array", description: "New tags (replaces all)", items: { type: "string" } },
      pinned: { type: "boolean", description: "Pin/unpin" },
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history"] },
      status: { type: "string", description: "New status", enum: ["active", "archived", "expired"] },
    },
    example: '{"ids":["abc123","def456"],"importance":9,"tags":["important"]}',
  },
  clean_expired: {
    description: "Remove expired memories from the database. Returns count of removed entries.",
    category: "utility",
    params: {},
    example: "{}",
  },
  memory_report: {
    description: "Rich summary: total/pinned counts, sparkline activity, scope/category breakdown, top 5 memories by importance.",
    category: "memory",
    params: {
      days: { type: "number", description: "Activity window in days (default 7)" },
      project_id: { type: "string", description: "Filter by project" },
      agent_id: { type: "string", description: "Filter by agent" },
    },
    example: '{"days":7,"project_id":"proj-uuid"}',
  },
  entity_update: {
    description: "Update an entity's name, description, or metadata.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description (null to clear)" },
      metadata: { type: "object", description: "New metadata" },
    },
    example: '{"entity_name_or_id":"TypeScript","description":"Typed superset of JavaScript by Microsoft"}',
  },
  entity_unlink: {
    description: "Remove the link between an entity and a memory.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
    },
    example: '{"entity_name_or_id":"TypeScript","memory_id":"abc12345"}',
  },
  relation_get: {
    description: "Get a specific relation by ID.",
    category: "graph",
    params: {
      id: { type: "string", description: "Relation ID", required: true },
    },
    example: '{"id":"rel-uuid"}',
  },
  entity_create: {
    description: "Create a knowledge graph entity.",
    category: "graph",
    params: {
      name: { type: "string", description: "Entity name", required: true },
      type: { type: "string", description: "Entity type", required: true, enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
      description: { type: "string", description: "Entity description" },
      project_id: { type: "string", description: "Project UUID to scope this entity" },
    },
    example: '{"name":"TypeScript","type":"tool","description":"Typed superset of JavaScript"}',
  },
  entity_get: {
    description: "Get entity details including relations summary and linked memory count.",
    category: "graph",
    params: {
      name_or_id: { type: "string", description: "Entity name or ID (partial OK)", required: true },
      type: { type: "string", description: "Type hint for name disambiguation", enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
    },
    example: '{"name_or_id":"TypeScript"}',
  },
  entity_list: {
    description: "List entities with optional type, project, and search filters.",
    category: "graph",
    params: {
      type: { type: "string", description: "Type filter", enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
      project_id: { type: "string", description: "Project UUID filter" },
      search: { type: "string", description: "Name search string" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    example: '{"type":"tool","limit":20}',
  },
  entity_delete: {
    description: "Delete an entity and all its relations.",
    category: "graph",
    params: {
      name_or_id: { type: "string", description: "Entity name or ID (partial OK)", required: true },
    },
    example: '{"name_or_id":"OldEntity"}',
  },
  entity_merge: {
    description: "Merge source entity into target — moves all relations and memory links.",
    category: "graph",
    params: {
      source: { type: "string", description: "Source entity name or ID (will be deleted)", required: true },
      target: { type: "string", description: "Target entity name or ID (will be kept)", required: true },
    },
    example: '{"source":"OldName","target":"NewName"}',
  },
  entity_link: {
    description: "Link an entity to a memory with a semantic role.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
      role: { type: "string", description: "Semantic role (default: context)", enum: ["subject", "object", "context"] },
    },
    example: '{"entity_name_or_id":"TypeScript","memory_id":"abc123","role":"subject"}',
  },
  relation_create: {
    description: "Create a typed relation between two entities.",
    category: "graph",
    params: {
      source_entity: { type: "string", description: "Source entity name or ID", required: true },
      target_entity: { type: "string", description: "Target entity name or ID", required: true },
      relation_type: { type: "string", description: "Relation type", required: true, enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] },
      weight: { type: "number", description: "Relation weight 0-1 (default 1.0)" },
    },
    example: '{"source_entity":"MyApp","target_entity":"TypeScript","relation_type":"uses"}',
  },
  relation_list: {
    description: "List relations for an entity, with optional type and direction filters.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      relation_type: { type: "string", description: "Type filter", enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] },
      direction: { type: "string", description: "Direction filter (default: both)", enum: ["outgoing", "incoming", "both"] },
    },
    example: '{"entity_name_or_id":"MyApp","direction":"outgoing"}',
  },
  relation_delete: {
    description: "Delete a relation by ID.",
    category: "graph",
    params: {
      id: { type: "string", description: "Relation ID (partial OK)", required: true },
    },
    example: '{"id":"rel-abc123"}',
  },
  graph_query: {
    description: "Traverse the knowledge graph from an entity up to N hops. Returns entities and relations.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Starting entity name or ID", required: true },
      depth: { type: "number", description: "Max traversal depth (default 2)" },
    },
    example: '{"entity_name_or_id":"MyApp","depth":3}',
  },
  graph_path: {
    description: "Find the shortest path between two entities in the knowledge graph.",
    category: "graph",
    params: {
      from_entity: { type: "string", description: "Starting entity name or ID", required: true },
      to_entity: { type: "string", description: "Target entity name or ID", required: true },
      max_depth: { type: "number", description: "Max search depth (default 5)" },
    },
    example: '{"from_entity":"Agent","to_entity":"Database","max_depth":4}',
  },
  graph_stats: {
    description: "Get entity and relation counts broken down by type.",
    category: "graph",
    params: {},
    example: "{}",
  },
  search_tools: {
    description: "Search available tools by name or keyword. Returns matching tool names and categories.",
    category: "meta",
    params: {
      query: { type: "string", description: "Search keyword (matches tool name or description)", required: true },
      category: { type: "string", description: "Category filter", enum: ["memory", "agent", "project", "bulk", "utility", "graph", "meta"] },
    },
    example: '{"query":"memory","category":"memory"}',
  },
  describe_tools: {
    description: "Get full parameter schemas and examples for specific tools. Omit names to list all tools.",
    category: "meta",
    params: {
      names: { type: "array", description: "Tool names to describe (omit for all tools)", items: { type: "string" } },
    },
    example: '{"names":["memory_save","memory_recall"]}',
  },
};

const TOOL_REGISTRY = Object.entries(FULL_SCHEMAS).map(([name, schema]) => ({
  name,
  description: schema.description,
  category: schema.category,
}));

server.tool(
  "search_tools",
  "Search available tools by name or keyword. Returns names only.",
  {
    query: z.string(),
    category: z.enum(["memory", "agent", "project", "bulk", "utility", "graph", "meta"]).optional(),
  },
  async (args) => {
    const q = args.query.toLowerCase();
    const results = TOOL_REGISTRY.filter(t =>
      (!args.category || t.category === args.category) &&
      (t.name.includes(q) || t.description.toLowerCase().includes(q))
    );
    if (results.length === 0) return { content: [{ type: "text" as const, text: "No tools found." }] };
    return { content: [{ type: "text" as const, text: results.map(t => `${t.name} [${t.category}]: ${t.description}`).join("\n") }] };
  }
);

server.tool(
  "describe_tools",
  "Get full parameter schemas and examples for tools. Omit names to list all tools.",
  {
    names: z.array(z.string()).optional(),
  },
  async (args) => {
    const targets = (args.names && args.names.length > 0)
      ? args.names
      : Object.keys(FULL_SCHEMAS);
    const results = targets
      .filter(name => name in FULL_SCHEMAS)
      .map(name => {
        const schema = FULL_SCHEMAS[name]!;
        const paramLines = Object.entries(schema.params).map(([pname, p]) => {
          const req = p.required ? " [required]" : "";
          const enumStr = p.enum ? ` (${p.enum.join("|")})` : "";
          return `  ${pname}${req}: ${p.type}${enumStr} — ${p.description}`;
        });
        const lines = [
          `### ${name} [${schema.category}]`,
          schema.description,
        ];
        if (paramLines.length > 0) {
          lines.push("Params:", ...paramLines);
        } else {
          lines.push("Params: none");
        }
        if (schema.example) lines.push(`Example: ${schema.example}`);
        return lines.join("\n");
      });
    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No matching tools." }] };
    }
    return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
  }
);

// ============================================================================
// Resources
// ============================================================================

server.resource(
  "memories",
  "mementos://memories",
  { description: "All active memories", mimeType: "application/json" },
  async () => {
    const memories = listMemories({ status: "active", limit: 1000 });
    return { contents: [{ uri: "mementos://memories", text: JSON.stringify(memories, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "agents",
  "mementos://agents",
  { description: "All registered agents", mimeType: "application/json" },
  async () => {
    const agents = listAgents();
    return { contents: [{ uri: "mementos://agents", text: JSON.stringify(agents, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "projects",
  "mementos://projects",
  { description: "All registered projects", mimeType: "application/json" },
  async () => {
    const projects = listProjects();
    return { contents: [{ uri: "mementos://projects", text: JSON.stringify(projects, null, 2), mimeType: "application/json" }] };
  }
);

// ============================================================================
// Memory locking tools (OPE4-00111)
// ============================================================================

server.tool(
  "memory_lock",
  "Acquire an exclusive write lock on a memory key to prevent concurrent writes.",
  {
    agent_id: z.string(),
    key: z.string(),
    scope: z.string().optional().default("shared"),
    project_id: z.string().optional(),
    ttl_seconds: z.number().optional().default(30),
  },
  async (args) => {
    const lock = acquireMemoryWriteLock(args.agent_id, args.key, args.scope, args.project_id, args.ttl_seconds);
    if (!lock) {
      const existing = checkMemoryWriteLock(args.key, args.scope, args.project_id);
      return {
        content: [{
          type: "text" as const,
          text: `Lock conflict: memory key "${args.key}" is write-locked by agent ${existing?.agent_id ?? "unknown"} (expires ${existing?.expires_at ?? "unknown"}). Retry after a few seconds.`,
        }],
        isError: true,
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: `Lock acquired: ${lock.id} on key "${args.key}" (expires ${lock.expires_at})`,
      }],
    };
  }
);

server.tool(
  "memory_unlock",
  "Release a memory write lock.",
  {
    lock_id: z.string(),
    agent_id: z.string(),
  },
  async (args) => {
    const released = releaseMemoryWriteLock(args.lock_id, args.agent_id);
    return {
      content: [{
        type: "text" as const,
        text: released ? `Lock ${args.lock_id} released.` : `Lock ${args.lock_id} not found or not owned by ${args.agent_id}.`,
      }],
    };
  }
);

server.tool(
  "memory_check_lock",
  "Check if a memory key is currently write-locked.",
  {
    key: z.string(),
    scope: z.string().optional().default("shared"),
    project_id: z.string().optional(),
  },
  async (args) => {
    const lock = checkMemoryWriteLock(args.key, args.scope, args.project_id);
    return {
      content: [{
        type: "text" as const,
        text: lock
          ? `Locked: key "${args.key}" held by agent ${lock.agent_id} (expires ${lock.expires_at})`
          : `Unlocked: key "${args.key}" is free to write.`,
      }],
    };
  }
);

server.tool(
  "resource_lock",
  "Acquire a lock on any resource (project, memory, entity, agent, connector).",
  {
    agent_id: z.string(),
    resource_type: z.enum(["project", "memory", "entity", "agent", "connector"]),
    resource_id: z.string(),
    lock_type: z.enum(["advisory", "exclusive"]).optional().default("exclusive"),
    ttl_seconds: z.number().optional().default(300),
  },
  async (args) => {
    const lock = acquireLock(args.agent_id, args.resource_type, args.resource_id, args.lock_type, args.ttl_seconds);
    if (!lock) {
      return {
        content: [{ type: "text" as const, text: `Lock conflict on ${args.resource_type}:${args.resource_id}. Another agent holds an exclusive lock.` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: `Lock acquired: ${lock.id} (expires ${lock.expires_at})` }],
    };
  }
);

server.tool(
  "resource_unlock",
  "Release a resource lock.",
  {
    lock_id: z.string(),
    agent_id: z.string(),
  },
  async (args) => {
    const released = releaseLock(args.lock_id, args.agent_id);
    return {
      content: [{ type: "text" as const, text: released ? `Released.` : `Not found or not owned.` }],
    };
  }
);

server.tool(
  "resource_check_lock",
  "Check active locks on a resource.",
  {
    resource_type: z.enum(["project", "memory", "entity", "agent", "connector"]),
    resource_id: z.string(),
    lock_type: z.enum(["advisory", "exclusive"]).optional(),
  },
  async (args) => {
    const locks = checkLock(args.resource_type, args.resource_id, args.lock_type);
    return {
      content: [{ type: "text" as const, text: locks.length === 0 ? "No active locks." : JSON.stringify(locks, null, 2) }],
    };
  }
);

server.tool(
  "list_agent_locks",
  "List all active resource locks held by an agent.",
  { agent_id: z.string() },
  async (args) => {
    const locks = listAgentLocks(args.agent_id);
    return {
      content: [{ type: "text" as const, text: locks.length === 0 ? "No active locks." : JSON.stringify(locks, null, 2) }],
    };
  }
);

server.tool(
  "clean_expired_locks",
  "Delete all expired resource locks.",
  {},
  async () => {
    const count = cleanExpiredLocks();
    return { content: [{ type: "text" as const, text: `Cleaned ${count} expired lock(s).` }] };
  }
);

// ============================================================================
// Focus mode tools (OPE4-00113)
// ============================================================================

server.tool(
  "set_focus",
  "Set focus for an agent on a project. Memory ops will auto-scope to that project's shared + agent private + global memories.",
  {
    agent_id: z.string(),
    project_id: z.string().nullable().optional(),
  },
  async (args) => {
    try {
      const projectId = args.project_id ?? null;
      setFocus(args.agent_id, projectId);
      return {
        content: [{
          type: "text" as const,
          text: projectId
            ? `Focus set: agent ${args.agent_id} is now focused on project ${projectId}. Memory ops will auto-scope.`
            : `Focus cleared for agent ${args.agent_id}.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "get_focus",
  "Get the current focus project for an agent.",
  { agent_id: z.string() },
  async (args) => {
    try {
      const projectId = getFocus(args.agent_id);
      return {
        content: [{
          type: "text" as const,
          text: projectId
            ? `Agent ${args.agent_id} is focused on project: ${projectId}`
            : `Agent ${args.agent_id} has no active focus.`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "unfocus",
  "Remove focus for an agent (clears project scoping).",
  { agent_id: z.string() },
  async (args) => {
    try {
      unfocus(args.agent_id);
      return {
        content: [{ type: "text" as const, text: `Focus cleared for agent ${args.agent_id}. Memory ops will no longer auto-scope.` }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Auto-Memory Tools
// ============================================================================

import {
  processConversationTurn,
  getAutoMemoryStats,
  configureAutoMemory,
} from "../lib/auto-memory.js";
import { providerRegistry } from "../lib/providers/registry.js";

server.tool(
  "memory_auto_process",
  "Enqueue a conversation turn or text for async LLM memory extraction. Returns immediately (non-blocking). Set async=false to run synchronously and return extracted memories.",
  {
    turn: z.string().describe("The text / conversation turn to extract memories from"),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    async: z.boolean().optional().default(true),
  },
  async (args) => {
    try {
      if (args.async !== false) {
        processConversationTurn(args.turn, {
          agentId: args.agent_id,
          projectId: args.project_id,
          sessionId: args.session_id,
        });
        const stats = getAutoMemoryStats();
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ queued: true, queue: stats }),
          }],
        };
      }

      // Synchronous mode — run extraction and return results
      const provider = providerRegistry.getAvailable();
      if (!provider) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, or XAI_API_KEY." }) }], isError: true };
      }
      const memories = await provider.extractMemories(args.turn, {
        agentId: args.agent_id,
        projectId: args.project_id,
        sessionId: args.session_id,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ extracted: memories, count: memories.length }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_auto_status",
  "Get the current auto-memory extraction queue stats (pending, processing, processed, failed, dropped).",
  {},
  async () => {
    try {
      const stats = getAutoMemoryStats();
      const config = providerRegistry.getConfig();
      const health = providerRegistry.health();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ queue: stats, config, providers: health }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_auto_config",
  "Update auto-memory configuration at runtime (no restart needed). Set provider, model, enabled, minImportance, autoEntityLink.",
  {
    provider: z.enum(["anthropic", "openai", "cerebras", "grok"]).optional(),
    model: z.string().optional(),
    enabled: z.boolean().optional(),
    min_importance: z.number().min(0).max(10).optional(),
    auto_entity_link: z.boolean().optional(),
  },
  async (args) => {
    try {
      configureAutoMemory({
        ...(args.provider && { provider: args.provider }),
        ...(args.model && { model: args.model }),
        ...(args.enabled !== undefined && { enabled: args.enabled }),
        ...(args.min_importance !== undefined && { minImportance: args.min_importance }),
        ...(args.auto_entity_link !== undefined && { autoEntityLink: args.auto_entity_link }),
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ updated: true, config: providerRegistry.getConfig() }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_auto_test",
  "Test memory extraction on text WITHOUT saving anything. Returns what would be extracted. Useful for tuning prompts and checking provider output.",
  {
    turn: z.string().describe("Text to test extraction on"),
    provider: z.enum(["anthropic", "openai", "cerebras", "grok"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      let provider;
      if (args.provider) {
        provider = providerRegistry.getProvider(args.provider);
        if (!provider) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Provider '${args.provider}' not available — no API key configured.` }) }], isError: true };
        }
      } else {
        provider = providerRegistry.getAvailable();
        if (!provider) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No LLM provider configured." }) }], isError: true };
        }
      }
      const memories = await provider.extractMemories(args.turn, {
        agentId: args.agent_id,
        projectId: args.project_id,
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ provider: provider.name, model: provider.config.model, extracted: memories, count: memories.length, note: "DRY RUN — nothing was saved" }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Session ingestion tools
// ============================================================================

server.tool(
  "memory_ingest_session",
  "Submit a session transcript for async memory extraction. Returns job_id to track progress.",
  {
    transcript: z.string(),
    session_id: z.string(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    source: z.enum(["claude-code", "codex", "manual", "open-sessions"]).optional(),
  },
  async (args) => {
    try {
      const job = createSessionJob({
        session_id: args.session_id,
        transcript: args.transcript,
        source: args.source ?? "manual",
        agent_id: args.agent_id,
        project_id: args.project_id,
      });
      enqueueSessionJob(job.id);
      return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, status: "queued" }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_session_status",
  "Get the status of a session memory extraction job.",
  { job_id: z.string() },
  async (args) => {
    try {
      const job = getSessionJob(args.job_id);
      if (!job) return { content: [{ type: "text" as const, text: `Job not found: ${args.job_id}` }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_session_list",
  "List session memory extraction jobs.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const jobs = listSessionJobs({ agent_id: args.agent_id, project_id: args.project_id, status: args.status, limit: args.limit ?? 20 });
      return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Start server
// ============================================================================

async function main(): Promise<void> {
  // Load persisted webhooks into the in-memory registry
  loadWebhooksFromDb();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
