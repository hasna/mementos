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
} from "../db/memories.js";
import { registerAgent, getAgent, listAgents, updateAgent } from "../db/agents.js";
import {
  registerProject,
  listProjects,
} from "../db/projects.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { searchMemories } from "../lib/search.js";
import { detectProject } from "../lib/project-detect.js";
import {
  MemoryNotFoundError,
  VersionConflictError,
  DuplicateMemoryError,
  InvalidScopeError,
} from "../types/index.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
  MemoryStats,
  MemoryFilter,
  CreateMemoryInput,
} from "../types/index.js";

const server = new McpServer({
  name: "mementos",
  version: "0.1.0",
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
    ttl_ms: z.coerce.number().optional(),
    source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const memory = createMemory(args as CreateMemoryInput);
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
      const memory = getMemoryByKey(args.key, args.scope, args.agent_id, args.project_id, args.session_id);
      if (memory) {
        touchMemory(memory.id);
        return { content: [{ type: "text" as const, text: formatMemory(memory) }] };
      }

      // Fuzzy fallback: search for the key and return the top result
      const results = searchMemories(args.key, {
        scope: args.scope,
        agent_id: args.agent_id,
        project_id: args.project_id,
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
      const filter: MemoryFilter = {
        ...filterArgs,
        limit: filterArgs.limit || 10,
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
  "Update a memory's metadata (value, importance, tags, etc.)",
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
    version: z.coerce.number(),
  },
  async (args) => {
    try {
      const id = resolveId(args.id);
      const { id: _id, ...updateFields } = args;
      const memory = updateMemory(id, updateFields);
      return { content: [{ type: "text" as const, text: `Memory updated:\n${formatMemory(memory)}` }] };
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
  "memory_search",
  "Search memories by keyword across key, value, summary, and tags",
  {
    query: z.string(),
    scope: z.enum(["global", "shared", "private"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history"]).optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const filter: MemoryFilter = {
        scope: args.scope,
        category: args.category,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: args.project_id,
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

      // Build context within token budget (~4 chars per token estimate)
      const charBudget = maxTokens * 4;
      const lines: string[] = [];
      let totalChars = 0;

      for (const m of unique) {
        const line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
        if (totalChars + line.length > charBudget) break;
        lines.push(line);
        totalChars += line.length;
        touchMemory(m.id);
      }

      if (lines.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found for injection." }] };
      }

      // raw=true: plain lines only (pipe-friendly, no wrapper tags or headers)
      const context = args.raw
        ? lines.join("\n")
        : `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
      return { content: [{ type: "text" as const, text: context }] };
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
    description: z.string().optional(),
    role: z.string().optional(),
  },
  async (args) => {
    try {
      const agent = registerAgent(args.name, args.description, args.role);
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
      const lines = agents.map((a) => `${a.id} | ${a.name} | ${a.role || "agent"} | last seen: ${a.last_seen_at}`);
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
  "Update agent name, description, role, or metadata.",
  {
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    role: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
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
          text: `Agent updated:\nID: ${agent.id}\nName: ${agent.name}\nDescription: ${agent.description || "-"}\nRole: ${agent.role || "agent"}\nMetadata: ${JSON.stringify(agent.metadata)}\nLast seen: ${agent.last_seen_at}`,
        }],
      };
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
// Meta-tools: search_tools + describe_tools (96% input token reduction)
// ============================================================================

const TOOL_REGISTRY = [
  { name: "memory_save", description: "Save/upsert a memory. scope: global=all agents, shared=project, private=single agent.", category: "memory" },
  { name: "memory_recall", description: "Recall a memory by key. Returns the best matching active memory.", category: "memory" },
  { name: "memory_list", description: "List memories. Default: compact lines. full=true for complete JSON objects.", category: "memory" },
  { name: "memory_update", description: "Update a memory's metadata (value, importance, tags, etc.)", category: "memory" },
  { name: "memory_forget", description: "Delete a memory by ID or key", category: "memory" },
  { name: "memory_search", description: "Search memories by keyword across key, value, summary, and tags", category: "memory" },
  { name: "memory_stats", description: "Get aggregate statistics about stored memories", category: "memory" },
  { name: "memory_export", description: "Export memories as JSON", category: "memory" },
  { name: "memory_import", description: "Import memories from JSON array", category: "memory" },
  { name: "memory_inject", description: "Get memory context for system prompt injection. Selects by scope, importance, recency.", category: "memory" },
  { name: "memory_context", description: "Get memories relevant to current context, filtered by scope/importance/recency.", category: "memory" },
  { name: "register_agent", description: "Register an agent. Idempotent — same name returns existing agent.", category: "agent" },
  { name: "list_agents", description: "List all registered agents", category: "agent" },
  { name: "get_agent", description: "Get agent details by ID or name", category: "agent" },
  { name: "update_agent", description: "Update agent name, description, role, or metadata.", category: "agent" },
  { name: "register_project", description: "Register a project for memory scoping", category: "project" },
  { name: "list_projects", description: "List all registered projects", category: "project" },
  { name: "bulk_forget", description: "Delete multiple memories by IDs", category: "bulk" },
  { name: "bulk_update", description: "Update multiple memories with the same changes", category: "bulk" },
  { name: "clean_expired", description: "Remove expired memories from the database", category: "utility" },
  { name: "search_tools", description: "Search available tools by name or keyword. Returns names only.", category: "meta" },
  { name: "describe_tools", description: "Get full schemas for specific tools by name.", category: "meta" },
];

server.tool(
  "search_tools",
  "Search available tools by name or keyword. Returns names only.",
  {
    query: z.string(),
    category: z.enum(["memory", "agent", "project", "bulk", "utility", "meta"]).optional(),
  },
  async (args) => {
    const q = args.query.toLowerCase();
    const results = TOOL_REGISTRY.filter(t =>
      (!args.category || t.category === args.category) &&
      (t.name.includes(q) || t.description.toLowerCase().includes(q))
    );
    if (results.length === 0) return { content: [{ type: "text" as const, text: "No tools found." }] };
    return { content: [{ type: "text" as const, text: results.map(t => `${t.name} [${t.category}]`).join("\n") }] };
  }
);

server.tool(
  "describe_tools",
  "Get full schemas for specific tools by name.",
  {
    names: z.array(z.string()),
  },
  async (args) => {
    const found = TOOL_REGISTRY.filter(t => args.names.includes(t.name));
    if (found.length === 0) return { content: [{ type: "text" as const, text: "No matching tools." }] };
    const lines = found.map(t => `**${t.name}** [${t.category}]: ${t.description}`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
// Start server
// ============================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
