#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
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
  semanticSearch,
  indexMemoryEmbedding,
  parseMemoryRow,
} from "../db/memories.js";
import { registerAgent, getAgent, listAgents, listAgentsByProject, updateAgent, touchAgent } from "../db/agents.js";
import { setFocus, getFocus, unfocus, resolveProjectId } from "../lib/focus.js";
import {
  acquireMemoryWriteLock,
  releaseMemoryWriteLock,
  checkMemoryWriteLock,
} from "../lib/memory-lock.js";
import { acquireLock, releaseLock, checkLock, listAgentLocks, cleanExpiredLocksWithInfo } from "../db/locks.js";
import {
  registerProject,
  listProjects,
  getProject,
} from "../db/projects.js";
import { registerMachine, listMachines, getMachine, renameMachine, getCurrentMachineId } from "../db/machines.js";
import { createEntity, getEntity, getEntityByName, listEntities, updateEntity, deleteEntity, mergeEntities, graphTraverse } from "../db/entities.js";
import { createRelation, getRelation, listRelations, deleteRelation, getEntityGraph, findPath } from "../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity } from "../db/entity-memories.js";
import { getDatabase, resolvePartialId } from "../db/database.js";
import { searchMemories, hybridSearch, searchWithBm25 } from "../lib/search.js";
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
import { buildFileDependencyGraph } from "../lib/file-deps.js";
import { synthesizeProfile } from "../lib/profile-synthesizer.js";
import { saveToolEvent, getToolStats, getToolLessons, getToolEvents } from "../db/tool-events.js";
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
import { startAutoInject, stopAutoInject, getAutoInjectConfig, updateAutoInjectConfig, getAutoInjectStatus } from "../lib/auto-inject-orchestrator.js";
import { findActivatedMemories } from "../lib/activation-matcher.js";
import { asmrRecall } from "../lib/asmr/index.js";
import { ensembleAnswer } from "../lib/asmr/ensemble.js";

// Read version from package.json — never hardcode
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

/** Exported so other modules can push channel notifications via the underlying Server. */
export let mcpServer: McpServer | null = null;

const server = new McpServer(
  {
    name: "mementos",
    version: _pkg.version,
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: `Mementos is the persistent memory layer for AI agents. It stores, searches, and manages memories across sessions and projects.

When running with --dangerously-load-development-channels, mementos will proactively push relevant memories into your conversation via channel notifications. These appear as <channel source="mementos"> tags. They contain memories activated by your current task context — use them to inform your work. You don't need to call memory_inject when auto-inject is active.`,
  },
);

mcpServer = server;

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
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("UNIQUE constraint failed: projects.")) {
      return `Project already registered at this path. Use list_projects to find it.`;
    }
    if (msg.includes("UNIQUE constraint failed")) {
      const table = msg.match(/UNIQUE constraint failed: (\w+)\./)?.[1] ?? "unknown";
      return `Duplicate entry in ${table}. The record already exists — use the list or get tool to find it.`;
    }
    if (msg.includes("FOREIGN KEY constraint failed")) {
      return `Referenced record not found. Check that the project_id or agent_id exists.`;
    }
    return msg;
  }
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

function formatAsmrResult(result: import("../lib/asmr/types.js").AsmrResult, query: string): string {
  const sections: string[] = [];

  sections.push(`[deep] ASMR recall for "${query}" (${result.duration_ms}ms, agents: ${result.agents_used.join(", ")})`);

  if (result.memories.length > 0) {
    const memLines = result.memories.map((m, i) =>
      `${i + 1}. [${m.source_agent}] [score:${m.score.toFixed(3)}] [${m.memory.scope}/${m.memory.category}] ${m.memory.key} = ${m.memory.value.slice(0, 120)}${m.memory.value.length > 120 ? "..." : ""}`,
    );
    sections.push(`Memories (${result.memories.length}):\n${memLines.join("\n")}`);
  }

  if (result.facts.length > 0) {
    sections.push(`Facts:\n${result.facts.map((f) => `- ${f}`).join("\n")}`);
  }

  if (result.timeline.length > 0) {
    sections.push(`Timeline:\n${result.timeline.map((t) => `- ${t}`).join("\n")}`);
  }

  if (result.reasoning) {
    sections.push(`Reasoning: ${result.reasoning}`);
  }

  return sections.join("\n\n");
}

// ============================================================================
// Memory Tools
// ============================================================================

server.tool(
  "memory_save",
  "Save/upsert a memory. scope: global=all agents, shared=project, private=single agent, working=transient session scratchpad (auto-expires in 1h, excluded from ALMA synthesis). conflict controls what happens when key already exists.",
  {
    key: z.string(),
    value: z.string(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    summary: z.string().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    ttl_ms: z.union([z.string(), z.number()]).optional(),
    source: z.enum(["user", "agent", "system", "auto", "imported"]).optional(),
    metadata: z.record(z.unknown()).optional(),
    conflict: z.enum(["merge", "overwrite", "error", "version-fork"]).optional()
      .describe("Conflict strategy: merge=upsert(default), overwrite=same as merge, error=fail if key exists, version-fork=always create new"),
    conflict_strategy: z.enum(["last_writer_wins", "reject"]).optional()
      .describe("Vector clock conflict strategy: last_writer_wins (default) proceeds even if diverged, reject returns error on divergence"),
    machine_id: z.string().optional().describe("Machine ID (from register_machine). If omitted, auto-detected from current hostname."),
    when_to_use: z.string().optional().describe("Activation context — describes WHEN this memory should be retrieved. Used for intent-based retrieval. Example: 'when deploying to production' or 'when debugging database issues'. If set, semantic search matches against this instead of the value."),
    sequence_group: z.string().optional().describe("Chain/sequence group ID — links memories into an ordered procedural sequence. Use memory_chain_get to retrieve the full chain."),
    sequence_order: z.coerce.number().optional().describe("Position within the sequence group (1-based). Memories in a chain are returned ordered by this field."),
    dedup_mode: z.enum(["key", "semantic", "llm"]).optional().default("key").describe("Dedup strategy: 'key' = current key-based (default), 'semantic' = skip if >0.92 embedding similarity to existing memory, 'llm' = ask LLM if content is already covered"),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const { conflict, dedup_mode, ...restArgs } = args as typeof args & { conflict?: string; dedup_mode?: string };
      const input = { ...restArgs } as Record<string, unknown>;
      if ((restArgs as Record<string, unknown>).ttl_ms !== undefined) {
        input.ttl_ms = parseDuration((restArgs as Record<string, unknown>).ttl_ms as string | number);
      }
      // Focus mode: auto-set project_id from agent focus if not provided
      if (!input.project_id && input.agent_id) {
        const focusedProject = resolveProjectId(input.agent_id as string, null);
        if (focusedProject) input.project_id = focusedProject;
      }
      // Auto-detect machine_id if not provided
      if (!input.machine_id) {
        try { input.machine_id = getCurrentMachineId(); } catch { /* ignore — machine registry optional */ }
      }
      const dedupeMode = (conflict as import("../types/index.js").DedupeMode | undefined) ?? "merge";
      const conflictStrategy = (args as Record<string, unknown>).conflict_strategy as string | undefined ?? "last_writer_wins";

      // Vector clock conflict detection (Task 2)
      // Before creating/updating, check if existing memory has a diverged vector clock
      if (conflictStrategy === "reject" && input.agent_id) {
        const db = getDatabase();
        try {
          const existing = db.query(
            `SELECT vector_clock FROM memories WHERE key = ? AND scope = ? AND COALESCE(agent_id, '') = ? AND COALESCE(project_id, '') = ? AND COALESCE(session_id, '') = ? AND status = 'active'`
          ).get(
            input.key as string,
            (input.scope as string) || "private",
            (input.agent_id as string) || "",
            (input.project_id as string) || "",
            (input.session_id as string) || ""
          ) as { vector_clock: string } | null;

          if (existing?.vector_clock) {
            const existingClock = JSON.parse(existing.vector_clock) as Record<string, number>;
            const agentEntry = existingClock[input.agent_id as string] || 0;
            // If another agent has written since our last write, the clock has diverged
            const otherWrites = Object.entries(existingClock).some(
              ([aid, count]) => aid !== input.agent_id && count > 0
            );
            if (otherWrites && agentEntry === 0) {
              return { content: [{ type: "text" as const, text: `Vector clock conflict: memory was modified by another agent. Use conflict_strategy='last_writer_wins' to override.` }], isError: true };
            }
          }
        } catch {
          // vector_clock column may not exist yet — skip check
        }
      }

      // ── Semantic dedup: check embedding similarity before saving ──────────
      if (dedup_mode === "semantic") {
        try {
          const textToEmbed = (input.when_to_use as string) || (input.value as string);
          const results = await semanticSearch(textToEmbed, {
            threshold: 0.3,
            limit: 5,
            scope: input.scope as string | undefined,
            agent_id: input.agent_id as string | undefined,
            project_id: input.project_id as string | undefined,
          });
          const SEMANTIC_THRESHOLD = 0.92;
          for (const result of results) {
            if (result.score >= SEMANTIC_THRESHOLD) {
              return { content: [{ type: "text" as const, text: `Skipped: content similar to existing memory ${result.memory.id.slice(0, 8)} (similarity: ${result.score.toFixed(2)})` }] };
            }
          }
        } catch {
          // Embedding infrastructure unavailable — fall through to normal save
        }
      }

      // ── LLM dedup: ask Haiku if content is already covered ─────────────────
      if (dedup_mode === "llm") {
        try {
          const textToEmbed = (input.when_to_use as string) || (input.value as string);
          const candidates = await semanticSearch(textToEmbed, {
            threshold: 0.3,
            limit: 5,
            scope: input.scope as string | undefined,
            agent_id: input.agent_id as string | undefined,
            project_id: input.project_id as string | undefined,
          });
          if (candidates.length > 0) {
            const anthropicKey = process.env["ANTHROPIC_API_KEY"];
            if (anthropicKey) {
              const existingList = candidates.map((c, i) =>
                `[${i + 1}] key="${c.memory.key}" value="${c.memory.value}" (similarity: ${c.score.toFixed(2)})`
              ).join("\n");
              const llmPrompt = `New memory to save:\nkey="${input.key}"\nvalue="${input.value}"\n\nExisting similar memories:\n${existingList}\n\nIs the new memory already covered by these existing memories? Reply with JSON only:\n{"action": "skip" | "merge" | "add", "reason": "string", "merge_text": "string if action=merge — the merged content combining new and existing"}`;
              const llmRes = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                  "x-api-key": anthropicKey,
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  model: "claude-haiku-4-5-20251001",
                  max_tokens: 300,
                  system: "You are a deduplication assistant. Given a new memory and existing similar memories, decide: skip (already covered), merge (combine with existing), or add (genuinely new). Reply with JSON only.",
                  messages: [{ role: "user", content: llmPrompt }],
                }),
                signal: AbortSignal.timeout(15_000),
              });
              if (llmRes.ok) {
                const llmData = await llmRes.json() as { content: { type: string; text: string }[] };
                const llmText = llmData.content?.[0]?.text?.trim() ?? "";
                // Extract JSON from response (handle markdown code fences)
                const jsonMatch = llmText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const decision = JSON.parse(jsonMatch[0]) as { action: string; reason: string; merge_text?: string };
                  if (decision.action === "skip") {
                    return { content: [{ type: "text" as const, text: `Skipped (LLM dedup): ${decision.reason}` }] };
                  }
                  if (decision.action === "merge" && decision.merge_text && candidates[0]) {
                    const target = candidates[0].memory;
                    try {
                      updateMemory(target.id, { value: decision.merge_text, version: target.version });
                      return { content: [{ type: "text" as const, text: JSON.stringify({
                        merged_into: target.id.slice(0, 8),
                        key: target.key,
                        reason: decision.reason,
                      }) }] };
                    } catch {
                      // Merge failed (version conflict etc.) — fall through to normal save
                    }
                  }
                  // action === "add" — fall through to normal save
                }
              }
            }
          }
        } catch {
          // LLM dedup failed — fall through to normal save
        }
      }

      const memory = createMemory(input as unknown as CreateMemoryInput, dedupeMode);

      // Update vector_clock with agent_id entry incremented
      if (input.agent_id) {
        try {
          const db = getDatabase();
          const row = db.query("SELECT vector_clock FROM memories WHERE id = ?").get(memory.id) as { vector_clock: string } | null;
          const clock = JSON.parse(row?.vector_clock || "{}") as Record<string, number>;
          clock[input.agent_id as string] = (clock[input.agent_id as string] || 0) + 1;
          db.run("UPDATE memories SET vector_clock = ? WHERE id = ?", [JSON.stringify(clock), memory.id]);
        } catch {
          // vector_clock column may not exist in older DBs — ignore
        }
      }

      if (args.agent_id) touchAgent(args.agent_id);

      // Auto-broadcast shared memories to active agents via conversations MCP
      if (memory.scope === 'shared' && memory.project_id && args.agent_id) {
        try {
          const { broadcastSharedMemory } = await import('./memory-broadcast.js');
          broadcastSharedMemory(memory, args.agent_id as string).catch(() => {/* non-blocking */});
        } catch { /* conversations MCP not available */ }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({
        saved: memory.key,
        id: memory.id.slice(0, 8),
        version: memory.version,
        conflict_mode: dedupeMode,
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_recall",
  "Recall a memory by key. Returns the best matching active memory. Use as_of for temporal queries (what was true at a specific date).",
  {
    key: z.string(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    as_of: z.string().optional().describe("ISO8601 date — recall what was known at this point in time (bi-temporal query)"),
  },
  async (args) => {
    try {
      ensureAutoProject();
      // Focus mode: auto-scope if agent is focused and no explicit scope/project_id
      let effectiveProjectId = args.project_id;
      if (!args.scope && !args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }
      const memory = getMemoryByKey(args.key, args.scope, args.agent_id, effectiveProjectId, args.session_id, undefined, args.as_of);
      if (memory) {
        touchMemory(memory.id);
        if (args.agent_id) touchAgent(args.agent_id);
        let text = formatMemory(memory);

        // If memory belongs to a chain, include chain context
        if (memory.sequence_group) {
          try {
            const db = getDatabase();
            const chainRows = db.prepare(
              "SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC"
            ).all(memory.sequence_group) as Record<string, unknown>[];
            if (chainRows.length > 1) {
              const steps = chainRows.map(parseMemoryRow);
              const chainLine = steps.map(s => `[${s.sequence_order ?? "?"}] ${s.key}`).join(" → ");
              text += `\n\nChain context: ${chainLine}`;
            }
          } catch {
            // chain lookup non-critical
          }
        }

        return { content: [{ type: "text" as const, text }] };
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

      // Proactive save suggestion when nothing found
      const suggestedKey = args.key.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const suggestedCategory = suggestedKey.includes("prefer") ? "preference"
        : suggestedKey.includes("how") || suggestedKey.includes("process") || suggestedKey.includes("step") ? "procedural"
        : suggestedKey.includes("stack") || suggestedKey.includes("arch") ? "fact"
        : "knowledge";
      return { content: [{ type: "text" as const, text: `No memory found for key: "${args.key}".\n\n💡 Save suggestion: memory_save(key="${suggestedKey}", value="...", category="${suggestedCategory}", scope="shared")` }] };
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    tags: z.array(z.string()).optional(),
    min_importance: z.coerce.number().optional(),
    pinned: z.boolean().optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    status: z.enum(["active", "archived", "expired"]).optional(),
    as_of: z.string().optional().describe("ISO8601 date — list memories valid at this point in time (bi-temporal query)"),
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
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    summary: z.string().nullable().optional(),
    pinned: z.boolean().optional(),
    status: z.enum(["active", "archived", "expired"]).optional(),
    metadata: z.record(z.unknown()).optional(),
    expires_at: z.string().nullable().optional(),
    version: z.coerce.number().optional(),
    when_to_use: z.string().optional().describe("Update the activation context for this memory"),
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
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
  "memory_flag",
  "Flag a memory for attention: needs-review, outdated, verify, or any custom flag. Flagged memories surface at the top of memory_context. Pass flag=null to clear.",
  {
    id: z.string().optional().describe("Memory ID or partial ID"),
    key: z.string().optional().describe("Memory key"),
    flag: z.string().nullable().optional().describe("Flag value: needs-review | outdated | verify | important | null (to clear)"),
    agent_id: z.string().optional(),
  },
  async (args) => {
    try {
      const db = getDatabase();
      let memId: string | null = null;
      if (args.id) {
        memId = resolvePartialId(db, "memories", args.id) ?? args.id;
      } else if (args.key) {
        const row = db.query("SELECT id FROM memories WHERE key = ? AND status = 'active' LIMIT 1").get(args.key) as { id: string } | null;
        memId = row?.id ?? null;
      }
      if (!memId) return { content: [{ type: "text" as const, text: `Memory not found: ${args.id || args.key}` }], isError: true };
      const memory = getMemory(memId);
      if (!memory) return { content: [{ type: "text" as const, text: `Memory not found: ${memId}` }], isError: true };
      const flagVal = args.flag ?? null;
      db.run("UPDATE memories SET flag = ?, updated_at = ? WHERE id = ?", [flagVal, new Date().toISOString(), memId]);
      const flagStr = args.flag ?? null;
      return { content: [{ type: "text" as const, text: flagStr ? `Flagged "${memory.key}" as: ${flagStr}` : `Cleared flag on "${memory.key}"` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_health",
  "Comprehensive health check for memories. Detects: stale (old + 0 access), high-importance-forgotten (importance>=7 + not accessed in 60d), and possibly-superseded (newer memory with similar key). Returns actionable summary.",
  {
    stale_days: z.coerce.number().optional().describe("Days with no access to consider a memory stale (default: 30)"),
    forgotten_days: z.coerce.number().optional().describe("Days since access for high-importance memories (default: 60)"),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.coerce.number().optional().describe("Max per category (default: 10)"),
  },
  async (args) => {
    try {
      const db = getDatabase();
      const staleDays = args.stale_days ?? 30;
      const forgottenDays = args.forgotten_days ?? 60;
      const limit = args.limit ?? 10;
      const extraWhere = [
        ...(args.project_id ? ["project_id = ?"] : []),
        ...(args.agent_id ? ["agent_id = ?"] : []),
      ].join(" AND ");
      const extraParams: string[] = [
        ...(args.project_id ? [args.project_id] : []),
        ...(args.agent_id ? [args.agent_id] : []),
      ];
      const base = `status = 'active' AND pinned = 0${extraWhere ? " AND " + extraWhere : ""}`;

      // 1. Stale: never accessed or not accessed in staleDays, access_count == 0
      const stale = db.prepare(
        `SELECT id, key, value, importance, scope, created_at FROM memories
         WHERE ${base} AND access_count = 0 AND created_at < datetime('now', '-${staleDays} days')
         ORDER BY created_at ASC LIMIT ?`
      ).all(...extraParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; created_at: string}>;

      // 2. High-importance forgotten: importance >= 7, not accessed in forgottenDays
      const forgotten = db.prepare(
        `SELECT id, key, value, importance, scope, accessed_at FROM memories
         WHERE ${base} AND importance >= 7
           AND (accessed_at IS NULL OR accessed_at < datetime('now', '-${forgottenDays} days'))
         ORDER BY importance DESC, COALESCE(accessed_at, created_at) ASC LIMIT ?`
      ).all(...extraParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; accessed_at: string|null}>;

      // 3. Possibly superseded: multiple active memories with same key prefix (similar key)
      const dupes = db.prepare(
        `SELECT key, COUNT(*) as cnt, MAX(updated_at) as latest, MIN(created_at) as oldest
         FROM memories WHERE ${base}
         GROUP BY key HAVING cnt > 1
         ORDER BY cnt DESC LIMIT ?`
      ).all(...extraParams, limit) as Array<{key: string; cnt: number; latest: string; oldest: string}>;

      const parts: string[] = ["Memory Health Report\n"];

      if (stale.length > 0) {
        parts.push(`⚠️  STALE (${stale.length}) — created ${staleDays}d+ ago, never accessed:`);
        for (const m of stale) {
          parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — created ${m.created_at.slice(0, 10)}`);
        }
        parts.push("");
      }

      if (forgotten.length > 0) {
        parts.push(`🔔  HIGH-IMPORTANCE FORGOTTEN (${forgotten.length}) — importance≥7, not accessed in ${forgottenDays}d+:`);
        for (const m of forgotten) {
          parts.push(`  • [${m.importance}] ${m.key} (${m.scope}) — last: ${m.accessed_at?.slice(0, 10) || "never"}`);
        }
        parts.push("");
      }

      if (dupes.length > 0) {
        parts.push(`🔄  POSSIBLY SUPERSEDED (${dupes.length}) — same key with multiple versions:`);
        for (const d of dupes) {
          parts.push(`  • ${d.key} × ${d.cnt} copies — newest: ${d.latest.slice(0, 10)}`);
        }
        parts.push("");
      }

      if (stale.length === 0 && forgotten.length === 0 && dupes.length === 0) {
        parts.push("✓ No health issues found. All memories look fresh.");
      } else {
        parts.push(`Summary: ${stale.length} stale, ${forgotten.length} forgotten, ${dupes.length} possibly-superseded.`);
        parts.push("Suggested actions: archive stale memories, review forgotten ones, merge duplicates.");
      }

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_diff",
  "Show what changed between two versions of a memory. Compares value, importance, scope. Omit v1/v2 to diff the two most recent versions.",
  {
    id: z.string().optional().describe("Memory ID or partial ID"),
    key: z.string().optional().describe("Memory key (alternative to id)"),
    v1: z.coerce.number().optional().describe("First version number (default: second-to-last)"),
    v2: z.coerce.number().optional().describe("Second version number (default: current/latest)"),
  },
  async (args) => {
    try {
      let memId: string | undefined;
      if (args.id) {
        memId = resolvePartialId(getDatabase(), "memories", args.id) ?? args.id;
      } else if (args.key) {
        const row = getDatabase().query("SELECT id FROM memories WHERE key = ? LIMIT 1").get(args.key) as { id: string } | null;
        memId = row?.id;
      }
      if (!memId) return { content: [{ type: "text" as const, text: `Memory not found: ${args.id || args.key}` }], isError: true };

      const memory = getMemory(memId);
      if (!memory) return { content: [{ type: "text" as const, text: `Memory not found: ${memId}` }], isError: true };

      const versions = getMemoryVersions(memId);
      // Add current version as a pseudo-version
      const allVersions = [
        ...versions,
        { version: memory.version, value: memory.value, importance: memory.importance, scope: memory.scope, created_at: memory.updated_at, summary: memory.summary },
      ].sort((a, b) => a.version - b.version);

      if (allVersions.length < 2) {
        return { content: [{ type: "text" as const, text: `Only 1 version exists for "${memory.key}". No diff available.` }] };
      }

      const v1Num = args.v1 ?? allVersions[allVersions.length - 2]?.version ?? 1;
      const v2Num = args.v2 ?? allVersions[allVersions.length - 1]?.version ?? memory.version;

      const ver1 = allVersions.find(v => v.version === v1Num);
      const ver2 = allVersions.find(v => v.version === v2Num);

      if (!ver1 || !ver2) {
        return { content: [{ type: "text" as const, text: `Versions not found: v${v1Num}, v${v2Num}. Available: ${allVersions.map(v => `v${v.version}`).join(", ")}` }], isError: true };
      }

      const parts = [`Diff for "${memory.key}" (v${v1Num} → v${v2Num})`];
      parts.push(`Time: ${ver1.created_at?.slice(0, 16)} → ${ver2.created_at?.slice(0, 16)}`);

      if (ver1.value !== ver2.value) {
        parts.push(`\n--- v${v1Num} value ---`);
        parts.push(ver1.value.slice(0, 500) + (ver1.value.length > 500 ? "..." : ""));
        parts.push(`\n+++ v${v2Num} value +++`);
        parts.push(ver2.value.slice(0, 500) + (ver2.value.length > 500 ? "..." : ""));
      } else {
        parts.push("value: unchanged");
      }
      if (ver1.importance !== ver2.importance) parts.push(`importance: ${ver1.importance} → ${ver2.importance}`);
      if (ver1.scope !== ver2.scope) parts.push(`scope: ${ver1.scope} → ${ver2.scope}`);

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_chain_get",
  "Retrieve an ordered memory chain/sequence by group ID. Returns all steps in order.",
  {
    sequence_group: z.string().describe("The chain/sequence group ID to retrieve"),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const db = getDatabase();
      let effectiveProjectId = args.project_id;

      const conditions = ["sequence_group = ?", "status = 'active'"];
      const params: (string | number)[] = [args.sequence_group];

      if (effectiveProjectId) {
        conditions.push("project_id = ?");
        params.push(effectiveProjectId);
      }

      const rows = db.prepare(
        `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY sequence_order ASC`
      ).all(...params) as Record<string, unknown>[];

      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No chain found for sequence_group: "${args.sequence_group}"` }] };
      }

      const memories = rows.map(parseMemoryRow);
      const chainSteps = memories.map((m, i) =>
        `[Step ${m.sequence_order ?? i + 1}] ${m.key}: ${m.value}`
      ).join("\n");

      const header = `Chain "${args.sequence_group}" (${memories.length} steps):\n`;
      return { content: [{ type: "text" as const, text: header + chainSteps }] };
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
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
        const sugKey = args.query.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        return { content: [{ type: "text" as const, text: `No memories found matching "${args.query}".\n\n💡 Consider saving relevant information: memory_save(key="${sugKey}", value="...", scope="shared")` }] };
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
  "memory_search_semantic",
  "Semantic (meaning-based) memory search using vector embeddings. Finds memories by conceptual similarity, not keyword match. Uses OpenAI embeddings if OPENAI_API_KEY is set, otherwise TF-IDF.",
  {
    query: z.string().describe("Natural language query"),
    threshold: z.coerce.number().min(0).max(1).optional().describe("Minimum cosine similarity score (default: 0.5)"),
    limit: z.coerce.number().optional().describe("Max results (default: 10)"),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    index_missing: z.coerce.boolean().optional().describe("If true, index any memories that lack embeddings before searching"),
  },
  async (args) => {
    try {
      ensureAutoProject();

      // Optionally index all unembedded memories first
      if (args.index_missing) {
        const db = getDatabase();
        const unindexed = db.prepare(
          `SELECT id, value, summary, when_to_use FROM memories
           WHERE status = 'active' AND id NOT IN (SELECT memory_id FROM memory_embeddings)
           LIMIT 100`
        ).all() as Array<{ id: string; value: string; summary: string | null; when_to_use: string | null }>;
        await Promise.all(
          unindexed.map((m) =>
            indexMemoryEmbedding(m.id, m.when_to_use || [m.value, m.summary].filter(Boolean).join(" "))
          )
        );
      }

      let effectiveProjectId = args.project_id;
      if (!args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }

      const results = await semanticSearch(args.query, {
        threshold: args.threshold,
        limit: args.limit,
        scope: args.scope,
        agent_id: args.agent_id,
        project_id: effectiveProjectId,
      });

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No semantically similar memories found for: "${args.query}". Try a lower threshold or call with index_missing:true to generate embeddings first.` }] };
      }

      const lines = results.map((r, i) =>
        `${i + 1}. [score:${r.score}] [${r.memory.scope}/${r.memory.category}] ${r.memory.key} = ${r.memory.value.slice(0, 120)}${r.memory.value.length > 120 ? "..." : ""}`
      );
      return { content: [{ type: "text" as const, text: `${results.length} semantic result(s) for "${args.query}":\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_search_hybrid",
  "Hybrid search combining keyword (FTS5) and semantic (embedding) search using Reciprocal Rank Fusion (RRF). Best of both worlds: keyword precision + semantic recall.",
  {
    query: z.string().describe("Search query (natural language or keywords)"),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    semantic_threshold: z.coerce.number().min(0).max(1).optional().describe("Minimum cosine similarity for semantic results (default: 0.3)"),
    limit: z.coerce.number().optional().describe("Max results (default: 20)"),
  },
  async (args) => {
    try {
      ensureAutoProject();
      let effectiveProjectId = args.project_id;
      if (!args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }
      const filter: MemoryFilter = {
        scope: args.scope,
        category: args.category,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: effectiveProjectId,
      };
      const results = await hybridSearch(args.query, {
        filter,
        semantic_threshold: args.semantic_threshold,
        limit: args.limit,
      });
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via hybrid search.` }] };
      }
      const lines = results.map((r, i) => {
        const kw = r.keyword_rank !== null ? `kw:#${r.keyword_rank}` : "kw:—";
        const sem = r.semantic_rank !== null ? `sem:#${r.semantic_rank}` : "sem:—";
        return `${i + 1}. [rrf:${r.score.toFixed(4)}] [${kw} ${sem}] [${r.memory.scope}/${r.memory.category}] ${r.memory.key} = ${r.memory.value.slice(0, 100)}${r.memory.value.length > 100 ? "..." : ""}`;
      });
      return { content: [{ type: "text" as const, text: `${results.length} hybrid result(s) for "${args.query}":\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_search_bm25",
  "Search memories using FTS5 BM25 ranking. Returns results scored by term frequency, document length, and field weights (key=10, value=5, summary=3).",
  {
    query: z.string().describe("Search query"),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.coerce.number().optional().describe("Max results (default: 20)"),
  },
  async (args) => {
    try {
      ensureAutoProject();
      let effectiveProjectId = args.project_id;
      if (!args.project_id && args.agent_id) {
        effectiveProjectId = resolveProjectId(args.agent_id, null) ?? undefined;
      }
      const filter: MemoryFilter = {
        scope: args.scope,
        category: args.category,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: effectiveProjectId,
        limit: args.limit || 20,
      };
      const results = searchWithBm25(args.query, filter);
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via BM25 search.` }] };
      }
      const lines = results.map((r, i) =>
        `${i + 1}. [bm25:${r.score.toFixed(3)}] [${r.memory.scope}/${r.memory.category}] ${r.memory.key} = ${r.memory.value.slice(0, 100)}${r.memory.value.length > 100 ? "..." : ""}`
      );
      return { content: [{ type: "text" as const, text: `${results.length} BM25 result(s) for "${args.query}":\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_recall_deep",
  "Deep memory recall using ASMR (Agentic Search and Memory Retrieval) — runs 3 parallel search agents (facts, context, temporal) for high-accuracy retrieval with optional ensemble answering",
  {
    query: z.string().describe("Natural language query"),
    mode: z.enum(["fast", "deep", "auto"]).default("deep").describe("fast=FTS+semantic, deep=ASMR 3-agent, auto=fast then escalate"),
    max_results: z.coerce.number().default(20),
    ensemble: z.coerce.boolean().default(false).describe("Use ensemble answering with majority voting"),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const db = getDatabase();

      const FAST_SCORE_THRESHOLD = 0.6;

      // ── Fast mode: hybrid search (FTS + semantic) ─────────────────────
      if (args.mode === "fast") {
        const results = await hybridSearch(args.query, {
          filter: { project_id: args.project_id, limit: args.max_results },
          limit: args.max_results,
        });
        if (results.length === 0) {
          return { content: [{ type: "text" as const, text: `No memories found for "${args.query}" via fast search.` }] };
        }
        const lines = results.map((r, i) =>
          `${i + 1}. [score:${r.score.toFixed(3)}] [${r.memory.scope}/${r.memory.category}] ${r.memory.key} = ${r.memory.value.slice(0, 120)}${r.memory.value.length > 120 ? "..." : ""}`,
        );
        return { content: [{ type: "text" as const, text: `[fast] ${results.length} result(s) for "${args.query}":\n${lines.join("\n")}` }] };
      }

      // ── Deep mode: ASMR 3-agent recall ────────────────────────────────
      if (args.mode === "deep") {
        const asmrResult = await asmrRecall(db, args.query, {
          max_results: args.max_results,
          project_id: args.project_id,
        });

        let text = formatAsmrResult(asmrResult, args.query);

        if (args.ensemble) {
          try {
            const answer = await ensembleAnswer(asmrResult, args.query);
            text += `\n\n--- Ensemble Answer (confidence: ${(answer.confidence * 100).toFixed(0)}%, consensus: ${answer.consensus_reached ? "yes" : "no"}, escalated: ${answer.escalated ? "yes" : "no"}) ---\n${answer.answer}\n\nReasoning: ${answer.reasoning}`;
          } catch (ensErr) {
            text += `\n\n[Ensemble failed: ${ensErr instanceof Error ? ensErr.message : "unknown error"}]`;
          }
        }

        return { content: [{ type: "text" as const, text }] };
      }

      // ── Auto mode: fast first, escalate to deep if low quality ────────
      const fastResults = await hybridSearch(args.query, {
        filter: { project_id: args.project_id, limit: args.max_results },
        limit: args.max_results,
      });

      const topScore = fastResults.length > 0 ? fastResults[0]!.score : 0;

      if (topScore >= FAST_SCORE_THRESHOLD && fastResults.length >= 3) {
        // Fast results are good enough
        const lines = fastResults.map((r, i) =>
          `${i + 1}. [score:${r.score.toFixed(3)}] [${r.memory.scope}/${r.memory.category}] ${r.memory.key} = ${r.memory.value.slice(0, 120)}${r.memory.value.length > 120 ? "..." : ""}`,
        );
        return { content: [{ type: "text" as const, text: `[auto/fast] ${fastResults.length} result(s) for "${args.query}" (top score ${topScore.toFixed(3)} >= threshold):\n${lines.join("\n")}` }] };
      }

      // Escalate to deep ASMR
      const asmrResult = await asmrRecall(db, args.query, {
        max_results: args.max_results,
        project_id: args.project_id,
      });

      let text = `[auto/escalated] Fast search top score ${topScore.toFixed(3)} < ${FAST_SCORE_THRESHOLD} threshold — escalated to ASMR deep recall.\n\n${formatAsmrResult(asmrResult, args.query)}`;

      if (args.ensemble) {
        try {
          const answer = await ensembleAnswer(asmrResult, args.query);
          text += `\n\n--- Ensemble Answer (confidence: ${(answer.confidence * 100).toFixed(0)}%, consensus: ${answer.consensus_reached ? "yes" : "no"}, escalated: ${answer.escalated ? "yes" : "no"}) ---\n${answer.answer}\n\nReasoning: ${answer.reasoning}`;
        } catch (ensErr) {
          text += `\n\n[Ensemble failed: ${ensErr instanceof Error ? ensErr.message : "unknown error"}]`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  },
);

server.tool(
  "memory_check_contradiction",
  "Check if a new memory would contradict existing high-importance facts. Call before saving to detect conflicts. Returns contradiction details if found.",
  {
    key: z.string().describe("Memory key to check"),
    value: z.string().describe("New value to check for contradictions"),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    project_id: z.string().optional(),
    min_importance: z.coerce.number().optional().describe("Only check against memories with importance >= this (default: 7)"),
  },
  async (args) => {
    try {
      const { detectContradiction } = await import("../lib/contradiction.js");
      const result = await detectContradiction(args.key, args.value, {
        scope: args.scope,
        project_id: args.project_id,
        min_importance: args.min_importance,
      });
      if (result.contradicts) {
        const mem = result.conflicting_memory;
        return { content: [{ type: "text" as const, text: `⚠ CONTRADICTION DETECTED (confidence: ${(result.confidence * 100).toFixed(0)}%)\n${result.reasoning}\n\nExisting memory: [${mem?.scope}/${mem?.category}] ${mem?.key} = ${mem?.value?.slice(0, 200)}\nImportance: ${mem?.importance}\nID: ${mem?.id?.slice(0, 8)}` }] };
      }
      return { content: [{ type: "text" as const, text: `No contradiction detected for key "${args.key}". ${result.reasoning}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_invalidate",
  "Invalidate an existing fact by setting valid_until to now. Use when a contradiction is confirmed and the old fact should be superseded. Optionally link to the new superseding memory.",
  {
    old_memory_id: z.string().describe("ID of the memory to invalidate"),
    new_memory_id: z.string().optional().describe("ID of the new memory that supersedes the old one"),
  },
  async (args) => {
    try {
      const { invalidateFact } = await import("../lib/contradiction.js");
      const oldId = resolveId(args.old_memory_id);
      const existing = getMemory(oldId);
      if (!existing) {
        return { content: [{ type: "text" as const, text: `Memory not found: ${args.old_memory_id}` }] };
      }
      const result = invalidateFact(oldId, args.new_memory_id);
      return { content: [{ type: "text" as const, text: `Invalidated "${existing.key}" (valid_until: ${result.valid_until})${result.new_memory_id ? ` — superseded by ${result.new_memory_id.slice(0, 8)}` : ""}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_audit_trail",
  "Get the immutable audit trail for a specific memory. Shows all create/update/delete operations with timestamps and agent IDs.",
  {
    memory_id: z.string().describe("Memory ID to get audit trail for"),
    limit: z.coerce.number().optional().describe("Max entries (default: 50)"),
  },
  async (args) => {
    try {
      const { getMemoryAuditTrail } = await import("../db/audit.js");
      const id = resolveId(args.memory_id);
      const entries = getMemoryAuditTrail(id, args.limit);
      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: `No audit entries for memory ${args.memory_id}` }] };
      }
      const lines = entries.map((e) =>
        `[${e.created_at}] ${e.operation} by ${e.agent_id || "system"} — ${JSON.stringify(e.changes)}`
      );
      return { content: [{ type: "text" as const, text: `Audit trail (${entries.length} entries):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_audit_export",
  "Export the full immutable audit log for compliance reporting. Supports date range and operation type filtering.",
  {
    since: z.string().optional().describe("Start date (ISO8601)"),
    until: z.string().optional().describe("End date (ISO8601)"),
    operation: z.enum(["create", "update", "delete", "archive", "restore"]).optional(),
    agent_id: z.string().optional(),
    limit: z.coerce.number().optional().describe("Max entries (default: 1000)"),
  },
  async (args) => {
    try {
      const { exportAuditLog } = await import("../db/audit.js");
      const entries = exportAuditLog(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_sync_push",
  "Push local memories to a remote mementos-serve instance. Set MEMENTOS_REMOTE_URL or pass url.",
  {
    url: z.string().optional().describe("Remote URL (e.g. http://apple01:19428). Defaults to MEMENTOS_REMOTE_URL env var."),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.coerce.number().optional(),
  },
  async (args) => {
    try {
      const { pushToRemote } = await import("../lib/remote-sync.js");
      const result = await pushToRemote({ remoteUrl: args.url, scope: args.scope, agentId: args.agent_id, projectId: args.project_id, limit: args.limit });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_sync_pull",
  "Pull memories from a remote mementos-serve instance into local DB. Set MEMENTOS_REMOTE_URL or pass url.",
  {
    url: z.string().optional().describe("Remote URL. Defaults to MEMENTOS_REMOTE_URL env var."),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.coerce.number().optional(),
    overwrite: z.coerce.boolean().optional().describe("Overwrite existing memories with same key (default: false = keep newer)"),
  },
  async (args) => {
    try {
      const { pullFromRemote } = await import("../lib/remote-sync.js");
      const result = await pullFromRemote({ remoteUrl: args.url, scope: args.scope, agentId: args.agent_id, projectId: args.project_id, limit: args.limit, overwrite: args.overwrite });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_sync_status",
  "Check if a remote mementos-serve is reachable. Set MEMENTOS_REMOTE_URL or pass url.",
  {
    url: z.string().optional().describe("Remote URL. Defaults to MEMENTOS_REMOTE_URL env var."),
  },
  async (args) => {
    try {
      const { pingRemote } = await import("../lib/remote-sync.js");
      const result = await pingRemote(args.url);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
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
        by_scope: { global: 0, shared: 0, private: 0, working: 0 },
        by_category: { preference: 0, fact: 0, knowledge: 0, history: 0, procedural: 0, resource: 0 },
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
        `By scope: global=${stats.by_scope.global}, shared=${stats.by_scope.shared}, private=${stats.by_scope.private}, working=${stats.by_scope.working}`,
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
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
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
  "Export memories. format='json' (default) returns JSON array. format='v1' returns mementos-export-v1 JSONL with entity links.",
  {
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    format: z.enum(["json", "v1"]).optional().describe("Export format: json (default) or v1 (JSONL with entity links)"),
  },
  async (args) => {
    try {
      if (args.format === "v1") {
        const { exportV1, toJsonl } = await import("../lib/export-v1.js");
        const entries = exportV1({ ...args });
        return { content: [{ type: "text" as const, text: toJsonl(entries) }] };
      }
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
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
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
  "Get memory context for system prompt injection. Selects by scope, importance, recency. Use strategy='smart' with a query for embedding-based relevance scoring.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
    max_tokens: z.coerce.number().optional(),
    categories: z.array(z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"])).optional(),
    min_importance: z.coerce.number().optional(),
    format: z.enum(["xml", "markdown", "compact", "json"]).optional(),
    raw: z.boolean().optional(),
    strategy: z.enum(["default", "smart"]).optional().describe("Injection strategy: 'default' uses importance+recency, 'smart' uses embedding similarity+importance+recency"),
    query: z.string().optional().describe("Query for smart injection relevance scoring. Required when strategy='smart'."),
    task_context: z.string().optional().describe("What the agent is about to do. When provided, activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories."),
    mode: z.enum(["full", "hints"]).optional().default("full").describe("'full' = inject complete memory content (default), 'hints' = inject lightweight topic summary with counts, saving 60-70% tokens. Agent uses memory_recall to pull details as needed."),
  },
  async (args) => {
    try {
      // Smart strategy: delegate to full smartInject pipeline (skip for hints mode — fall through to hints handler below)
      if (args.strategy === "smart" && args.task_context && args.mode !== "hints") {
        const { smartInject } = await import("../lib/injector.js");
        const result = await smartInject({
          task_context: args.task_context,
          project_id: args.project_id,
          agent_id: args.agent_id,
          session_id: args.session_id,
          max_tokens: args.max_tokens,
          min_importance: args.min_importance,
        });
        return { content: [{ type: "text" as const, text: result.output }] };
      }

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

      // Working memories (session-scoped transient scratchpad — always relevant to current context)
      if (args.session_id || args.agent_id) {
        const workingMems = listMemories({
          scope: "working",
          status: "active",
          ...(args.session_id ? { session_id: args.session_id } : {}),
          ...(args.agent_id ? { agent_id: args.agent_id } : {}),
          ...(args.project_id ? { project_id: args.project_id } : {}),
          limit: 50,
        });
        allMemories.push(...workingMems);
      }

      // Deduplicate by ID
      const seen = new Set<string>();
      const unique = allMemories.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      // task_context activation: semantic search against when_to_use embeddings
      // Activation-matched memories get a +3 importance boost for sorting
      const activationBoostedIds = new Set<string>();
      if (args.task_context) {
        try {
          const activationResults = await semanticSearch(args.task_context, {
            threshold: 0.3,
            limit: 20,
            scope: undefined,
            agent_id: args.agent_id,
            project_id: args.project_id,
          });
          for (const r of activationResults) {
            activationBoostedIds.add(r.memory.id);
            // Merge activation-matched memories not already in unique
            if (!seen.has(r.memory.id)) {
              seen.add(r.memory.id);
              unique.push(r.memory);
            }
          }
        } catch { /* Non-critical: proceed without activation matching if semantic search fails */ }
      }

      // Smart strategy: score by embedding similarity + importance + recency
      if (args.strategy === "smart" && args.query) {
        const { generateEmbedding: genEmb, cosineSimilarity: cosSim, deserializeEmbedding: deserEmb } = await import("../lib/embeddings.js");
        const { getDatabase: getDb } = await import("../db/database.js");
        const d = getDb();
        const { embedding: queryEmbedding } = await genEmb(args.query);

        // Load embeddings for candidate memories
        const embeddingMap = new Map<string, number[]>();
        if (unique.length > 0) {
          const rows = d.prepare(
            `SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id IN (${unique.map(() => "?").join(",")})`
          ).all(...unique.map((m) => m.id)) as Array<{ memory_id: string; embedding: string }>;
          for (const row of rows) {
            try { embeddingMap.set(row.memory_id, deserEmb(row.embedding)); } catch { /* skip malformed */ }
          }
        }

        if (embeddingMap.size > 0) {
          // Compute recency reference
          const nowMs = Date.now();
          const oldestMs = Math.min(...unique.map((m) => new Date(m.updated_at).getTime()));
          const timeRange = nowMs - oldestMs || 1;

          // Score: similarity * 0.4 + importance/10 * 0.3 + recency * 0.3 + pin bonus + activation boost
          const scores = new Map<string, number>();
          for (const m of unique) {
            const memEmb = embeddingMap.get(m.id);
            const similarity = memEmb ? cosSim(queryEmbedding, memEmb) : 0;
            const importanceScore = (m.importance + (activationBoostedIds.has(m.id) ? 3 : 0)) / 10;
            const recencyScore = (new Date(m.updated_at).getTime() - oldestMs) / timeRange;
            const pinBonus = m.pinned ? 0.5 : 0;
            scores.set(m.id, similarity * 0.4 + importanceScore * 0.3 + recencyScore * 0.3 + pinBonus);
          }
          unique.sort((a, b) => (scores.get(b.id) || 0) - (scores.get(a.id) || 0));
        } else {
          // No embeddings — fall back to default sort with activation boost
          unique.sort((a, b) => {
            const aImp = a.importance + (activationBoostedIds.has(a.id) ? 3 : 0);
            const bImp = b.importance + (activationBoostedIds.has(b.id) ? 3 : 0);
            if (bImp !== aImp) return bImp - aImp;
            return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
          });
        }
      } else {
        // Default strategy: sort by importance DESC (with activation boost), then recency
        unique.sort((a, b) => {
          const aImp = a.importance + (activationBoostedIds.has(a.id) ? 3 : 0);
          const bImp = b.importance + (activationBoostedIds.has(b.id) ? 3 : 0);
          if (bImp !== aImp) return bImp - aImp;
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });
      }

      // Hints mode: return lightweight topic summary instead of full content
      if (args.mode === "hints") {
        if (unique.length === 0) {
          return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
        }

        // Group memories by category
        const groups = new Map<string, Memory[]>();
        for (const m of unique) {
          const cat = m.category || "knowledge";
          if (!groups.has(cat)) groups.set(cat, []);
          groups.get(cat)!.push(m);
        }

        // Extract topic keywords from memory keys: split on '-', dedupe, take meaningful words
        const stopWords = new Set(["the", "a", "an", "is", "in", "on", "at", "to", "for", "of", "and", "or", "with", "my", "this", "that"]);
        function extractTopics(memories: Memory[], maxTopics: number = 8): string[] {
          const wordCounts = new Map<string, number>();
          for (const m of memories) {
            // Extract words from key
            const keyWords = m.key.split(/[-_\s]+/).filter((w: string) => w.length > 2 && !stopWords.has(w.toLowerCase()));
            for (const w of keyWords) {
              const lower = w.toLowerCase();
              wordCounts.set(lower, (wordCounts.get(lower) || 0) + 1);
            }
            // Extract words from tags
            if (m.tags) {
              const tags = Array.isArray(m.tags) ? m.tags : (typeof m.tags === "string" ? (m.tags as string).split(",") : []);
              for (const t of tags) {
                const tag = (t as string).trim().toLowerCase();
                if (tag.length > 2 && !stopWords.has(tag)) {
                  wordCounts.set(tag, (wordCounts.get(tag) || 0) + 1);
                }
              }
            }
          }
          // Sort by frequency descending, take top N
          return Array.from(wordCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxTopics)
            .map(([word]) => word);
        }

        // Category display names
        const categoryLabels: Record<string, string> = {
          fact: "Facts",
          preference: "Preferences",
          knowledge: "Knowledge",
          history: "History",
          procedural: "Procedures",
          resource: "Resources",
        };

        const hintLines: string[] = ["You have relevant memories available:"];
        // Order: fact, knowledge, preference, procedural, history, resource
        const categoryOrder = ["fact", "knowledge", "preference", "procedural", "history", "resource"];
        for (const cat of categoryOrder) {
          const mems = groups.get(cat);
          if (!mems || mems.length === 0) continue;
          const label = categoryLabels[cat] || cat;
          const topics = extractTopics(mems);
          hintLines.push(`- ${label} (${mems.length}): ${topics.join(", ")}`);
        }
        // Include any categories not in the standard order
        for (const [cat, mems] of groups) {
          if (categoryOrder.includes(cat)) continue;
          const topics = extractTopics(mems);
          hintLines.push(`- ${cat} (${mems.length}): ${topics.join(", ")}`);
        }

        hintLines.push("");
        hintLines.push('Use memory_recall(key="...") to access any of these. Use memory_search(query="...") for broader searches.');

        return { content: [{ type: "text" as const, text: hintLines.join("\n") }] };
      }

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

      // Task 6: Check for subscription notifications
      if (args.agent_id) {
        try {
          const db = getDatabase();
          const subs = db.query(
            "SELECT key_pattern, tag_pattern, scope FROM memory_subscriptions WHERE agent_id = ?"
          ).all(args.agent_id) as Array<{ key_pattern: string | null; tag_pattern: string | null; scope: string | null }>;

          if (subs.length > 0) {
            // Find recently changed memories matching subscriptions (last 10 minutes)
            const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
            const changes: string[] = [];
            for (const sub of subs) {
              let sql = "SELECT key, updated_at FROM memories WHERE updated_at > ? AND status = 'active'";
              const params: (string | null)[] = [cutoff];
              if (sub.key_pattern) {
                const like = sub.key_pattern.replace(/\*/g, "%");
                sql += " AND key LIKE ?";
                params.push(like);
              }
              if (sub.scope) {
                sql += " AND scope = ?";
                params.push(sub.scope);
              }
              // Exclude agent's own writes
              sql += " AND COALESCE(agent_id, '') != ?";
              params.push(args.agent_id);
              sql += " LIMIT 5";
              const matches = db.query(sql).all(...params) as Array<{ key: string; updated_at: string }>;
              for (const m of matches) {
                changes.push(`${m.key} (updated ${m.updated_at})`);
              }
            }
            if (changes.length > 0) {
              const changeSection = `\n\n## Changes\n${changes.map((c) => `- ${c}`).join("\n")}`;
              context += changeSection;
            }
          }
        } catch {
          // memory_subscriptions table may not exist — ignore
        }
      }

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

// ── Machine registry ──────────────────────────────────────────────────────────

server.tool(
  "register_machine",
  "Register the current machine in the mementos machine registry. Auto-detects hostname. Idempotent by hostname.",
  { name: z.string().optional().describe("Human-readable name (e.g. 'apple01'). Defaults to hostname.") },
  async (args) => {
    try {
      const machine = registerMachine(args.name);
      return { content: [{ type: "text" as const, text: `Machine: ${machine.name} | ${machine.id.slice(0, 8)} | hostname:${machine.hostname} | platform:${machine.platform}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "list_machines",
  "List all registered machines with their hostname, platform, and last seen time.",
  {},
  async () => {
    try {
      const machines = listMachines();
      return { content: [{ type: "text" as const, text: JSON.stringify(machines) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "rename_machine",
  "Rename a machine by its ID or current name.",
  { id: z.string().describe("Machine ID or name"), new_name: z.string() },
  async (args) => {
    try {
      const machine = getMachine(args.id);
      if (!machine) return { content: [{ type: "text" as const, text: `Machine not found: ${args.id}` }], isError: true };
      const updated = renameMachine(machine.id, args.new_name);
      return { content: [{ type: "text" as const, text: `Renamed: ${machine.name} → ${updated.name}` }] };
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
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
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
  "memory_briefing",
  "Lightweight delta briefing: what memories changed since an agent's last session. Use at session start instead of memory_context to avoid re-reading everything.",
  {
    agent_id: z.string().optional().describe("Agent ID or name. If provided, defaults since to agent's last_seen_at."),
    since: z.string().optional().describe("ISO 8601 timestamp. Defaults to agent's last_seen_at if agent_id provided, otherwise 24h ago."),
    project_id: z.string().optional(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    limit: z.coerce.number().optional().describe("Max memories per category (default: 20)"),
  },
  async (args) => {
    try {
      const db = getDatabase();
      const limit = args.limit || 20;

      // Resolve 'since': agent's last_seen_at → explicit param → 24h ago
      let since = args.since;
      if (!since && args.agent_id) {
        const ag = getAgent(args.agent_id);
        if (ag?.last_seen_at) since = ag.last_seen_at;
      }
      if (!since) {
        since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      }

      const scopeClause = args.scope ? `AND scope = ?` : "";
      const projectClause = args.project_id ? `AND project_id = ?` : "";
      const extraParams = [
        ...(args.scope ? [args.scope] : []),
        ...(args.project_id ? [args.project_id] : []),
      ];

      // New memories
      const newMems = db.prepare(
        `SELECT id, key, value, summary, importance, scope, category, agent_id, created_at
         FROM memories WHERE status = 'active' AND created_at > ? ${scopeClause} ${projectClause}
         ORDER BY importance DESC, created_at DESC LIMIT ?`
      ).all(since, ...extraParams, limit) as Array<{id: string; key: string; value: string; summary: string|null; importance: number; scope: string; category: string; agent_id: string|null; created_at: string}>;

      // Updated memories (updated_at > since but created before since)
      const updatedMems = db.prepare(
        `SELECT id, key, value, summary, importance, scope, category, agent_id, updated_at
         FROM memories WHERE status = 'active' AND updated_at > ? AND created_at <= ? ${scopeClause} ${projectClause}
         ORDER BY importance DESC, updated_at DESC LIMIT ?`
      ).all(since, since, ...extraParams, limit) as Array<{id: string; key: string; summary: string|null; importance: number; scope: string; value: string; agent_id: string|null; updated_at: string}>;

      // Expired/archived memories
      const expiredMems = db.prepare(
        `SELECT id, key, scope, category, updated_at, status
         FROM memories WHERE status != 'active' AND updated_at > ? ${scopeClause} ${projectClause}
         ORDER BY updated_at DESC LIMIT ?`
      ).all(since, ...extraParams, Math.min(limit, 10)) as Array<{id: string; key: string; scope: string; category: string; updated_at: string; status: string}>;

      const parts: string[] = [`Memory briefing since ${since}`];
      if (newMems.length > 0) {
        parts.push(`\n**New (${newMems.length}):**`);
        for (const m of newMems) {
          parts.push(`• [${m.scope}/${m.category}] ${m.key} (importance:${m.importance}${m.agent_id ? `, by:${m.agent_id}` : ""}): ${(m.summary || m.value).slice(0, 100)}`);
        }
      }
      if (updatedMems.length > 0) {
        parts.push(`\n**Updated (${updatedMems.length}):**`);
        for (const m of updatedMems) {
          parts.push(`• [${m.scope}] ${m.key}: ${(m.summary || m.value).slice(0, 80)}`);
        }
      }
      if (expiredMems.length > 0) {
        parts.push(`\n**Expired/archived (${expiredMems.length}):**`);
        for (const m of expiredMems) {
          parts.push(`• [${m.scope}] ${m.key} — ${m.status}`);
        }
      }
      if (newMems.length === 0 && updatedMems.length === 0 && expiredMems.length === 0) {
        parts.push("\nNo memory changes since last session.");
      }
      parts.push(`\nSummary: ${newMems.length} new, ${updatedMems.length} updated, ${expiredMems.length} expired.`);

      return { content: [{ type: "text" as const, text: parts.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_context",
  "Get memories relevant to current context. Uses time-weighted scoring: score = importance × decay(age). Pinned memories are exempt. Returns effective_score on each memory.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    limit: z.coerce.number().optional(),
    decay_halflife_days: z.coerce.number().optional().describe("Importance half-life in days (default: 90). Lower = more weight on recent memories."),
    no_decay: z.coerce.boolean().optional().describe("Set true to disable decay and sort purely by importance."),
    task_context: z.string().optional().describe("What the agent is about to do. When provided, activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories."),
    strategy: z.enum(["default", "smart"]).optional().default("default").describe("Injection strategy: 'default' = decay-scored, 'smart' = activation-matched + layered + tool-aware (requires task_context)"),
  },
  async (args) => {
    try {
      // Smart strategy: delegate to full smartInject pipeline
      if (args.strategy === "smart" && args.task_context) {
        const { smartInject } = await import("../lib/injector.js");
        const result = await smartInject({
          task_context: args.task_context,
          project_id: args.project_id,
          agent_id: args.agent_id,
          max_tokens: args.limit ? args.limit * 20 : undefined,
        });
        return { content: [{ type: "text" as const, text: result.output }] };
      }

      const filter: MemoryFilter = {
        scope: args.scope,
        agent_id: args.agent_id,
        project_id: args.project_id,
        status: "active",
        limit: (args.limit || 30) * 2, // fetch 2x, then rerank by effective score
      };
      const memories = listMemories(filter);

      // task_context activation: semantic search against when_to_use embeddings
      // Activation-matched memories get a +3 importance boost for scoring
      const activationBoostedIds = new Set<string>();
      if (args.task_context) {
        try {
          const activationResults = await semanticSearch(args.task_context, {
            threshold: 0.3,
            limit: 20,
            scope: args.scope,
            agent_id: args.agent_id,
            project_id: args.project_id,
          });
          const seenIds = new Set(memories.map((m) => m.id));
          for (const r of activationResults) {
            activationBoostedIds.add(r.memory.id);
            // Merge activation-matched memories not already in the list
            if (!seenIds.has(r.memory.id)) {
              seenIds.add(r.memory.id);
              memories.push(r.memory);
            }
          }
        } catch { /* Non-critical: proceed without activation matching if semantic search fails */ }
      }

      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories in current context." }] };
      }

      const halflifeDays = args.decay_halflife_days ?? 90;
      const now = Date.now();

      // Compute effective score with optional time-decay
      // Flagged memories get a bonus to always surface near top
      // Activation-matched memories get +3 importance boost
      const scored = memories.map((m) => {
        const activationBoost = activationBoostedIds.has(m.id) ? 3 : 0;
        let effectiveScore = m.importance + activationBoost;
        if (!args.no_decay && !m.pinned) {
          const ageMs = now - new Date(m.updated_at).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const decayFactor = Math.pow(0.5, ageDays / halflifeDays);
          effectiveScore = (m.importance + activationBoost) * decayFactor;
        }
        // Flagged memories always surface (boost to 11 equivalent — above max importance 10)
        if (m.flag) effectiveScore = Math.max(effectiveScore, 11);
        return { ...m, effective_score: Math.round(effectiveScore * 100) / 100 };
      });

      // Sort by effective_score descending, take top N
      const limit = args.limit || 30;
      scored.sort((a, b) => b.effective_score - a.effective_score);
      const top = scored.slice(0, limit);

      // Increment access_count for returned memories
      for (const m of top) {
        touchMemory(m.id);
      }

      const lines = top.map((m) =>
        `[${m.scope}/${m.category}] ${m.key}: ${m.value} (score: ${m.effective_score}, raw: ${m.importance}${m.pinned ? ", pinned" : ""}${m.flag ? `, flag: ${m.flag}` : ""})`
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_context_layered",
  "Structured multi-section memory context: Core Facts, Recent History, Relevant Knowledge, Active Decisions. Better than flat lists for agent prompts.",
  {
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    query: z.string().optional().describe("Query to find relevant knowledge (populates Relevant Knowledge section)"),
    max_per_section: z.coerce.number().optional().describe("Max memories per section (default: 10)"),
  },
  async (args) => {
    try {
      const { assembleContext, formatLayeredContext } = await import("../lib/context.js");
      const ctx = assembleContext({
        project_id: args.project_id,
        agent_id: args.agent_id,
        scope: args.scope,
        query: args.query,
        max_per_section: args.max_per_section,
      });
      if (ctx.total_memories === 0) {
        return { content: [{ type: "text" as const, text: "No memories found for layered context." }] };
      }
      const formatted = formatLayeredContext(ctx);
      return { content: [{ type: "text" as const, text: `${formatted}\n---\n${ctx.total_memories} memories, ~${ctx.token_estimate} tokens` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_profile",
  "Synthesize a coherent profile from preference and fact memories using LLM. Cached for 24h, auto-refreshed when preferences change. Returns markdown profile.",
  {
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    scope: z.enum(["agent", "project", "global"]).optional().default("project"),
    force_refresh: z.boolean().optional().default(false).describe("Force re-synthesis even if cached profile exists"),
  },
  async (args) => {
    try {
      ensureAutoProject();
      const result = await synthesizeProfile(args);
      if (!result) {
        return { content: [{ type: "text" as const, text: "No preference or fact memories found to synthesize a profile from." }] };
      }
      return { content: [{ type: "text" as const, text: `${result.from_cache ? "[cached] " : "[synthesized] "}(${result.memory_count} memories)\n\n${result.profile}` }] };
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
  "Comprehensive knowledge graph statistics: entity/relation counts by type, most-connected entities, orphan count, average degree.",
  {},
  async () => {
    try {
      const db = getDatabase();
      const entityTotal = (db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
      const byType = db.query("SELECT type, COUNT(*) as c FROM entities GROUP BY type").all() as { type: string; c: number }[];
      const relationTotal = (db.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }).c;
      const byRelType = db.query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type").all() as { relation_type: string; c: number }[];
      const linkTotal = (db.query("SELECT COUNT(*) as c FROM entity_memories").get() as { c: number }).c;

      // Most-connected entities (top 10 by total degree)
      const mostConnected = db.query(`
        SELECT e.id, e.name, e.type,
          (SELECT COUNT(*) FROM relations WHERE source_entity_id = e.id) +
          (SELECT COUNT(*) FROM relations WHERE target_entity_id = e.id) as degree
        FROM entities e ORDER BY degree DESC LIMIT 10
      `).all() as { id: string; name: string; type: string; degree: number }[];

      // Orphan entities (no relations)
      const orphanCount = (db.query(`
        SELECT COUNT(*) as c FROM entities e
        WHERE NOT EXISTS (SELECT 1 FROM relations WHERE source_entity_id = e.id OR target_entity_id = e.id)
      `).get() as { c: number }).c;

      // Average degree
      const avgDegree = entityTotal > 0 ? (relationTotal * 2) / entityTotal : 0;

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
      lines.push(`Avg degree: ${avgDegree.toFixed(1)}`);
      lines.push(`Orphan entities: ${orphanCount}`);
      if (mostConnected.length > 0 && mostConnected[0]!.degree > 0) {
        lines.push(`Most connected:`);
        for (const e of mostConnected.filter(e => e.degree > 0)) {
          lines.push(`  ${e.name} (${e.type}) — ${e.degree} connections`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "graph_traverse",
  "Multi-hop graph traversal from an entity. Returns all paths with entities and relations at each hop. Supports direction and relation-type filtering.",
  {
    entity_name_or_id: z.string().describe("Starting entity name or ID"),
    max_depth: z.coerce.number().optional().describe("Max traversal depth (default 2)"),
    relation_types: z.array(z.string()).optional().describe("Filter by relation types"),
    direction: z.enum(["outgoing", "incoming", "both"]).optional().describe("Traversal direction (default both)"),
    limit: z.coerce.number().optional().describe("Max paths to return (default 50)"),
  },
  async (args) => {
    try {
      const entity = resolveEntityParam(args.entity_name_or_id);
      const result = graphTraverse(entity.id, {
        max_depth: args.max_depth,
        relation_types: args.relation_types,
        direction: args.direction,
        limit: args.limit,
      });

      if (result.total_paths === 0) {
        return { content: [{ type: "text" as const, text: `No paths found from: ${entity.name}` }] };
      }

      const lines = [
        `Traversal from ${entity.name} (${result.total_paths} paths, ${result.visited_entities.length} entities):`,
      ];

      for (const path of result.paths) {
        const pathStr = path.entities.map(e => e.name).join(" -> ");
        const relStr = path.relations.map(r => r.relation_type).join(", ");
        lines.push(`  [depth ${path.depth}] ${pathStr} (${relStr})`);
      }

      lines.push(`\nVisited entities:`);
      for (const ve of result.visited_entities) {
        lines.push(`  ${ve.id.slice(0, 8)} | ${ve.type} | ${ve.name}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "build_file_dep_graph",
  "Scan a codebase directory and build a file dependency graph: creates 'file' entities and 'depends_on' relations based on import/require statements. Use graph_query to find blast radius of a file change.",
  {
    root_dir: z.string().describe("Root directory to scan"),
    project_id: z.string().optional().describe("Project to associate file entities with"),
    extensions: z.array(z.string()).optional().describe("File extensions to scan (default: .ts .tsx .js .jsx .py .go .rs)"),
    exclude_patterns: z.array(z.string()).optional().describe("Directory/file patterns to skip (default: node_modules, dist, .git, etc.)"),
    incremental: z.boolean().optional().describe("Skip files that already have entities (default: true)"),
  },
  async (args) => {
    try {
      const result = await buildFileDependencyGraph({
        root_dir: args.root_dir,
        project_id: args.project_id ? resolvePartialId(getDatabase(), "projects", args.project_id) ?? args.project_id : undefined,
        extensions: args.extensions,
        exclude_patterns: args.exclude_patterns,
        incremental: args.incremental ?? true,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_tool_insights",
  "Get usage stats, lessons learned, and recommendations for MCP tools. Helps agents avoid past mistakes and reuse successful patterns.",
  {
    tool_name: z.string().optional().describe("Specific tool to get insights for. If omitted, returns insights for all tools."),
    task_context: z.string().optional().describe("What the agent is about to do — used to find relevant tool lessons via semantic match"),
    project_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.coerce.number().optional().default(10).describe("Max lessons to return per tool"),
  },
  async (args) => {
    try {
      const db = getDatabase();
      const projId = args.project_id ? resolvePartialId(db, "projects", args.project_id) ?? args.project_id : undefined;
      const limit = args.limit ?? 10;

      // Determine which tools to report on
      let toolNames: string[];
      if (args.tool_name) {
        toolNames = [args.tool_name];
      } else {
        // Get unique tool names from recent events
        const filters: Parameters<typeof getToolEvents>[0] = { limit: 200 };
        if (projId) filters.project_id = projId;
        if (args.agent_id) filters.agent_id = args.agent_id;
        const events = getToolEvents(filters);
        toolNames = [...new Set(events.map(e => e.tool_name))];
      }

      if (toolNames.length === 0) {
        return { content: [{ type: "text" as const, text: "No tool events recorded yet." }] };
      }

      const sections: string[] = [];

      for (const tn of toolNames) {
        const stats = getToolStats(tn, projId);
        const lessons = getToolLessons(tn, projId, limit);

        // Build stats line
        const successPct = stats.total_calls > 0 ? Math.round(stats.success_rate * 100) : 0;
        const avgTok = stats.avg_tokens != null ? Math.round(stats.avg_tokens) : "?";
        const avgLat = stats.avg_latency_ms != null ? (stats.avg_latency_ms / 1000).toFixed(1) : "?";
        let section = `## Tool: ${tn}\nStats: ${stats.total_calls} calls | ${successPct}% success | avg ${avgTok} tokens | avg ${avgLat}s`;

        // Common errors
        if (stats.common_errors.length > 0) {
          const errParts = stats.common_errors.map(e => `${e.error_type} (${e.count})`);
          section += `\nCommon errors: ${errParts.join(", ")}`;
        }

        // Recommendations from lessons
        if (lessons.length > 0) {
          const dos: string[] = [];
          const donts: string[] = [];
          for (const l of lessons) {
            const ctx = (l.when_to_use || "").toLowerCase();
            if (ctx.includes("fail") || ctx.includes("error") || ctx.includes("avoid") || ctx.includes("don't") || ctx.includes("never")) {
              donts.push(l.lesson);
            } else {
              dos.push(l.lesson);
            }
          }

          if (dos.length > 0 || donts.length > 0) {
            section += "\n\n### Recommendations";
            for (const d of dos.slice(0, 5)) section += `\n✅ DO: ${d}`;
            for (const d of donts.slice(0, 5)) section += `\n❌ DON'T: ${d}`;
          }

          // Full lesson list
          section += "\n\n### Lessons (newest first)";
          for (const l of lessons) {
            const when = l.when_to_use ? ` (when: ${l.when_to_use})` : "";
            section += `\n- ${l.lesson}${when}`;
          }
        }

        sections.push(section);
      }

      // If task_context provided, highlight which lessons are most relevant
      let header = "";
      if (args.task_context) {
        header = `> Context: "${args.task_context}"\n> Showing insights filtered for relevance.\n\n`;
      }

      return { content: [{ type: "text" as const, text: header + sections.join("\n\n---\n\n") }] };
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
      scope: { type: "string", description: "Visibility: global=all agents, shared=project, private=single agent, working=transient session scratchpad (auto-expires 1h)", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Memory type", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      importance: { type: "number", description: "Priority 1-10 (10=critical)" },
      tags: { type: "array", description: "Searchable tags", items: { type: "string" } },
      summary: { type: "string", description: "Short summary for display" },
      agent_id: { type: "string", description: "Agent UUID to scope this memory to" },
      project_id: { type: "string", description: "Project UUID to scope this memory to" },
      session_id: { type: "string", description: "Session UUID" },
      ttl_ms: { type: "string|number", description: "Time-to-live e.g. '7d', '2h', or ms integer" },
      source: { type: "string", description: "Origin of the memory", enum: ["user", "agent", "system", "auto", "imported"] },
      metadata: { type: "object", description: "Arbitrary JSON metadata" },
      when_to_use: { type: "string", description: "Activation context — describes WHEN this memory should be retrieved. Used for intent-based retrieval. Example: 'when deploying to production'" },
      sequence_group: { type: "string", description: "Chain/sequence group ID — links memories into an ordered procedural sequence" },
      sequence_order: { type: "number", description: "Position within the sequence group (1-based)" },
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
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session UUID filter" },
    },
    example: '{"key":"preferred-language","scope":"global"}',
  },
  memory_chain_get: {
    description: "Retrieve an ordered memory chain/sequence by group ID. Returns all steps in procedural order.",
    category: "memory",
    params: {
      sequence_group: { type: "string", description: "The chain/sequence group ID to retrieve", required: true },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"sequence_group":"deploy-to-production"}',
  },
  memory_list: {
    description: "List memories with optional filters. Returns compact lines by default.",
    category: "memory",
    params: {
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
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
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      scope: { type: "string", description: "New scope", enum: ["global", "shared", "private", "working"] },
      importance: { type: "number", description: "New importance 1-10" },
      tags: { type: "array", description: "New tags (replaces all)", items: { type: "string" } },
      summary: { type: "string", description: "New summary (null to clear)" },
      pinned: { type: "boolean", description: "Pin/unpin the memory" },
      status: { type: "string", description: "New status", enum: ["active", "archived", "expired"] },
      metadata: { type: "object", description: "New metadata (replaces existing)" },
      expires_at: { type: "string", description: "New expiry ISO timestamp (null to clear)" },
      when_to_use: { type: "string", description: "Update the activation context for this memory" },
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
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"key":"project-stack","pinned":true}',
  },
  memory_archive: {
    description: "Archive a memory by ID or key. Hides from lists, preserves history. No version required.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID" },
      key: { type: "string", description: "Memory key (alternative to id)" },
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"key":"old-project-stack"}',
  },
  memory_forget: {
    description: "Delete a memory by ID or key.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)" },
      key: { type: "string", description: "Memory key" },
      scope: { type: "string", description: "Scope for key lookup", enum: ["global", "shared", "private", "working"] },
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
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      tags: { type: "array", description: "Tag filter", items: { type: "string" } },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session ID filter" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"typescript","scope":"global","limit":10}',
  },
  memory_search_hybrid: {
    description: "Hybrid search combining keyword (FTS5) and semantic (embedding) search via Reciprocal Rank Fusion. Best retrieval quality.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query (natural language or keywords)", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      semantic_threshold: { type: "number", description: "Min cosine similarity for semantic results (default 0.3)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"how does the auth system work","project_id":"proj-uuid"}',
  },
  memory_search_bm25: {
    description: "FTS5 BM25-ranked search. Field weights: key=10, value=5, summary=3.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"database migration","limit":5}',
  },
  memory_recall_deep: {
    description: "Deep memory recall using ASMR 3-agent search (facts, context, temporal). Modes: fast (hybrid), deep (ASMR), auto (fast then escalate). Optional ensemble answering.",
    category: "memory",
    params: {
      query: { type: "string", description: "Natural language query", required: true },
      mode: { type: "string", description: "fast=FTS+semantic, deep=ASMR 3-agent, auto=fast then escalate", enum: ["fast", "deep", "auto"] },
      max_results: { type: "number", description: "Max results (default 20)" },
      ensemble: { type: "boolean", description: "Use ensemble answering with majority voting (default false)" },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"query":"what is the deployment process","mode":"deep","ensemble":true}',
  },
  memory_activity: {
    description: "Get daily memory creation counts over N days (max 365). Like 'git log --stat' for memories.",
    category: "memory",
    params: {
      days: { type: "number", description: "Number of days to look back (default 30)" },
      scope: { type: "string", description: "Filter by scope", enum: ["global", "shared", "private", "working"] },
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
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
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
    description: "Get formatted memory context for system prompt injection. Respects token budget. Use strategy='smart' with task_context for full activation-matched + layered + tool-aware pipeline. Use mode='hints' for a lightweight topic summary (60-70% fewer tokens) — agent can then use memory_recall for details on demand.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID to include private memories" },
      project_id: { type: "string", description: "Project UUID to include shared memories" },
      session_id: { type: "string", description: "Session UUID" },
      max_tokens: { type: "number", description: "Approximate token budget (default 500)" },
      categories: { type: "array", description: "Categories to include (default: preference, fact, knowledge)", items: { type: "string", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] } },
      min_importance: { type: "number", description: "Minimum importance (default 3)" },
      format: { type: "string", description: "Output format: xml (default, <agent-memories>), compact (key: value, ~60% smaller), markdown, json", enum: ["xml", "compact", "markdown", "json"] },
      raw: { type: "boolean", description: "Deprecated: use format=compact instead. true=plain lines only" },
      strategy: { type: "string", description: "Injection strategy: 'default' = decay-scored (importance+recency), 'smart' = full pipeline (activation-matched + layered + tool-aware). Smart requires task_context.", enum: ["default", "smart"] },
      query: { type: "string", description: "Query for smart injection relevance scoring. Required when strategy='smart'." },
      task_context: { type: "string", description: "What the agent is about to do. Required for strategy='smart'. Activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories." },
      mode: { type: "string", description: "Injection mode: 'full' (default) = inject complete memory content, 'hints' = lightweight topic summary with counts per category, saving 60-70% tokens. In hints mode, use memory_recall(key=...) or memory_search(query=...) to pull details on demand.", enum: ["full", "hints"] },
    },
    example: '{"project_id":"proj-uuid","max_tokens":300,"strategy":"smart","task_context":"writing database migration for user table"}',
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
    description: "Get active memories for the current context (agent/project/scope). Supports intent-based retrieval via task_context. Use strategy='smart' for full activation-matched + layered + tool-aware pipeline.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      limit: { type: "number", description: "Max results (default 30)" },
      task_context: { type: "string", description: "What the agent is about to do. Required for strategy='smart'. Activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories." },
      strategy: { type: "string", description: "Injection strategy: 'default' = decay-scored, 'smart' = activation-matched + layered + tool-aware (requires task_context)", enum: ["default", "smart"] },
    },
    example: '{"project_id":"proj-uuid","scope":"shared","limit":20,"strategy":"smart","task_context":"deploying to production"}',
  },
  memory_profile: {
    description: "Synthesize a coherent profile from preference and fact memories using LLM. Cached for 24h, auto-refreshed when preferences change.",
    category: "memory",
    params: {
      project_id: { type: "string", description: "Project UUID to scope profile to" },
      agent_id: { type: "string", description: "Agent UUID to scope profile to" },
      scope: { type: "string", description: "Profile scope", enum: ["agent", "project", "global"] },
      force_refresh: { type: "boolean", description: "Force re-synthesis even if cached profile exists (default false)" },
    },
    example: '{"project_id":"proj-uuid","scope":"project"}',
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
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
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
  graph_traverse: {
    description: "Multi-hop graph traversal from an entity. Returns all paths with entities and relations at each hop. Supports direction and relation-type filtering.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Starting entity name or ID", required: true },
      max_depth: { type: "number", description: "Max traversal depth (default 2)" },
      relation_types: { type: "array", description: "Filter by relation types", items: { type: "string", enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] } },
      direction: { type: "string", description: "Traversal direction (default both)", enum: ["outgoing", "incoming", "both"] },
      limit: { type: "number", description: "Max paths to return (default 50)" },
    },
    example: '{"entity_name_or_id":"MyApp","max_depth":3,"direction":"outgoing","relation_types":["uses","depends_on"]}',
  },
  memory_audit: {
    description: "Review low-trust memories flagged by poisoning detection heuristic.",
    category: "memory",
    params: {
      threshold: { type: "number", description: "Trust score threshold (default 0.8). Returns memories below this." },
      project_id: { type: "string", description: "Project UUID filter" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    example: '{"threshold":0.7,"limit":20}',
  },
  memory_rate: {
    description: "Rate a memory as useful or not useful for quality tracking.",
    category: "memory",
    params: {
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
      useful: { type: "boolean", description: "Was this memory useful?", required: true },
      agent_id: { type: "string", description: "Agent providing the rating" },
      context: { type: "string", description: "Optional context about why" },
    },
    example: '{"memory_id":"abc12345","useful":true,"context":"Helped debug issue"}',
  },
  memory_evict: {
    description: "Enforce memory bounds per scope — archives lowest-utility memories when any scope exceeds limit.",
    category: "memory",
    params: {
      project_id: { type: "string", description: "Optional project ID to scope eviction to" },
    },
    example: '{"project_id":"proj-uuid"}',
  },
  memory_save_image: {
    description: "Save an image memory. Auto-extracts description via GPT-4o-mini vision if OPENAI_API_KEY set.",
    category: "memory",
    params: {
      key: { type: "string", description: "Memory key", required: true },
      image_url: { type: "string", description: "URL of the image to describe" },
      image_description: { type: "string", description: "Manual description" },
      scope: { type: "string", description: "Visibility scope", enum: ["global", "shared", "private", "working"] },
      importance: { type: "number", description: "Priority 1-10" },
      tags: { type: "array", description: "Tags", items: { type: "string" } },
      agent_id: { type: "string", description: "Agent UUID" },
      project_id: { type: "string", description: "Project UUID" },
    },
    example: '{"key":"screenshot-auth-bug","image_url":"https://example.com/screenshot.png","importance":7}',
  },
  entity_disambiguate: {
    description: "Find potential duplicate entities by name similarity (trigram).",
    category: "graph",
    params: {
      threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.8)" },
    },
    example: '{"threshold":0.7}',
  },
  memory_compress: {
    description: "Compress multiple memories into a single summary. Uses LLM if available, otherwise truncates.",
    category: "memory",
    params: {
      memory_ids: { type: "array", description: "Memory IDs to compress", required: true, items: { type: "string" } },
      max_length: { type: "number", description: "Max chars (default 500)" },
    },
    example: '{"memory_ids":["abc12345","def67890"]}',
  },
  memory_subscribe: {
    description: "Subscribe an agent to memory change notifications by key/tag pattern.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent ID", required: true },
      key_pattern: { type: "string", description: "Key glob pattern (e.g. 'architecture-*')" },
      tag_pattern: { type: "string", description: "Tag pattern to match" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"agent_id":"maximus","key_pattern":"architecture-*"}',
  },
  memory_unsubscribe: {
    description: "Remove a memory subscription.",
    category: "memory",
    params: {
      id: { type: "string", description: "Subscription ID", required: true },
    },
    example: '{"id":"sub-abc12"}',
  },
  memory_tool_insights: {
    description: "Get usage stats, lessons learned, and recommendations for MCP tools. Helps agents avoid past mistakes and reuse successful patterns.",
    category: "utility",
    params: {
      tool_name: { type: "string", description: "Specific tool to get insights for. If omitted, returns insights for all tools." },
      task_context: { type: "string", description: "What the agent is about to do — used to find relevant tool lessons via semantic match" },
      project_id: { type: "string", description: "Project ID filter" },
      agent_id: { type: "string", description: "Agent ID filter" },
      limit: { type: "number", description: "Max lessons to return per tool (default: 10)" },
    },
    example: '{"tool_name":"bash","limit":5}',
  },
  memory_save_tool_event: {
    description: "Record a tool call event (success/failure, latency, tokens). Optionally saves a lesson as a shared memory.",
    category: "memory",
    params: {
      tool_name: { type: "string", description: "Name of the tool that was called", required: true },
      action: { type: "string", description: "What was attempted" },
      success: { type: "boolean", description: "Whether the tool call succeeded", required: true },
      error_type: { type: "string", description: "Error category if failed", enum: ["timeout", "permission", "not_found", "syntax", "rate_limit", "other"] },
      error_message: { type: "string", description: "Raw error text if failed" },
      tokens_used: { type: "number", description: "Tokens consumed by the tool call" },
      latency_ms: { type: "number", description: "Time taken in milliseconds" },
      context: { type: "string", description: "What task triggered this tool call" },
      lesson: { type: "string", description: "Qualitative insight learned from this call" },
      when_to_use: { type: "string", description: "Activation context for the lesson" },
      agent_id: { type: "string", description: "Agent ID" },
      project_id: { type: "string", description: "Project ID" },
      session_id: { type: "string", description: "Session ID" },
    },
    example: '{"tool_name":"bash","action":"npm install","success":false,"error_type":"timeout","lesson":"npm install hangs on large monorepos — use --prefer-offline","when_to_use":"when installing deps in a monorepo"}',
  },
  memory_autoinject_config: {
    description: "Get or set auto-inject orchestrator config (channel-based proactive memory push). Controls throttle, debounce, rate limits, similarity thresholds.",
    category: "utility",
    params: {
      action: { type: "string", description: "Get or set auto-inject config", enum: ["get", "set"], required: true },
      throttle_ms: { type: "number", description: "Min ms between pushes (default 30000)" },
      debounce_ms: { type: "number", description: "Wait ms after last message before processing (default 2000)" },
      max_pushes_per_5min: { type: "number", description: "Rate limit per 5-minute window (default 5)" },
      min_similarity: { type: "number", description: "Minimum activation match threshold 0-1 (default 0.4)" },
      enabled: { type: "boolean", description: "Enable/disable auto-inject" },
      session_briefing: { type: "boolean", description: "Push session-start briefing (default true)" },
    },
    example: '{"action":"set","throttle_ms":15000,"min_similarity":0.5}',
  },
  memory_autoinject_status: {
    description: "Get auto-inject orchestrator status: running state, session watcher, push history, rate limit counters, and full config.",
    category: "utility",
    params: {},
    example: '{}',
  },
  memory_autoinject_test: {
    description: "Test what memories would be activated by a given context WITHOUT pushing. Shows what the auto-inject pipeline would match — useful for tuning min_similarity.",
    category: "utility",
    params: {
      context_text: { type: "string", description: "Simulated context to test activation matching", required: true },
      project_id: { type: "string", description: "Scope to a specific project" },
      min_similarity: { type: "number", description: "Minimum similarity threshold (default 0.4)" },
    },
    example: '{"context_text":"debugging a SQLite FTS5 index issue","min_similarity":0.3}',
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
    resource_type: z.enum(["project", "memory", "entity", "agent", "connector", "file"]),
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
    resource_type: z.enum(["project", "memory", "entity", "agent", "connector", "file"]),
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
  "Delete all expired resource locks. Notifies holding agents via conversations DM.",
  {},
  async () => {
    const expired = cleanExpiredLocksWithInfo();
    const count = expired.length;

    // Notify agents whose locks expired via conversations API (non-blocking)
    if (count > 0) {
      const conversationsUrl = process.env.CONVERSATIONS_API_URL || 'http://localhost:7020';
      for (const lock of expired) {
        const msg = `Your ${lock.lock_type} lock on ${lock.resource_type}/${lock.resource_id} has expired. Another agent may now acquire it.`;
        fetch(`${conversationsUrl}/api/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'system', to: lock.agent_id, content: msg }),
          signal: AbortSignal.timeout(2000),
        }).catch(() => {/* non-blocking */});
      }
    }

    return { content: [{ type: "text" as const, text: `Cleaned ${count} expired lock(s)${count > 0 ? ` and notified ${count} agent(s)` : ''}.` }] };
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
  "heartbeat",
  "Update agent last_seen_at to signal active session. Call periodically during long tasks to prevent being marked stale.",
  { agent_id: z.string().describe("Agent ID or name") },
  async (args) => {
    try {
      const agent = getAgent(args.agent_id);
      if (!agent) return { content: [{ type: "text" as const, text: `Agent not found: ${args.agent_id}` }], isError: true };
      touchAgent(agent.id);
      return { content: [{ type: "text" as const, text: `♥ ${agent.name} (${agent.id}) — last_seen_at updated` }] };
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
// Memory Poisoning & Ratings
// ============================================================================

server.tool(
  "memory_audit",
  "Review low-trust memories (trust_score < threshold). Returns memories flagged by the poisoning detection heuristic for manual review.",
  {
    threshold: z.coerce.number().optional().describe("Trust score threshold (default 0.8). Returns memories below this."),
    project_id: z.string().optional(),
    limit: z.coerce.number().optional().describe("Max results (default 50)"),
  },
  async (args) => {
    try {
      const db = getDatabase();
      const threshold = args.threshold ?? 0.8;
      const limit = args.limit ?? 50;
      const conditions: string[] = ["trust_score < ?", "status = 'active'"];
      const params: (string | number)[] = [threshold];
      if (args.project_id) {
        const resolved = resolvePartialId(db, "projects", args.project_id);
        conditions.push("project_id = ?");
        params.push(resolved ?? args.project_id);
      }
      params.push(limit);
      const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY trust_score ASC LIMIT ?`;
      const rows = db.query(sql).all(...params) as Record<string, unknown>[];
      if (rows.length === 0) {
        return { content: [{ type: "text" as const, text: `No low-trust memories found (threshold: ${threshold})` }] };
      }
      const { parseMemoryRow } = await import("../db/memories.js");
      const memories = rows.map(parseMemoryRow);
      const lines = memories.map((m) =>
        `[trust=${(m.trust_score ?? 1.0).toFixed(2)}] ${m.id.slice(0, 8)} ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`
      );
      return { content: [{ type: "text" as const, text: `Low-trust memories (${rows.length}, threshold < ${threshold}):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_rate",
  "Rate a memory as useful or not useful. Provides feedback for memory quality tracking.",
  {
    memory_id: z.string().describe("Memory ID (partial OK)"),
    useful: z.coerce.boolean().describe("Was this memory useful?"),
    agent_id: z.string().optional().describe("Agent providing the rating"),
    context: z.string().optional().describe("Optional context about why the rating was given"),
  },
  async (args) => {
    try {
      const id = resolveId(args.memory_id);
      const { rateMemory, getRatingsSummary } = await import("../db/ratings.js");
      const rating = rateMemory(id, args.useful, args.agent_id, args.context);
      const summary = getRatingsSummary(id);
      return { content: [{ type: "text" as const, text: JSON.stringify({
        rated: rating.id.slice(0, 8),
        memory_id: id.slice(0, 8),
        useful: rating.useful,
        total_ratings: summary.total,
        usefulness_ratio: summary.usefulness_ratio.toFixed(2),
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// GDPR & ACLs
// ============================================================================

server.tool(
  "memory_gdpr_erase",
  "GDPR right to be forgotten: erase all memories containing a PII identifier. Replaces content with [REDACTED], preserves anonymized audit trail. IRREVERSIBLE.",
  {
    identifier: z.string().describe("PII to search for and erase (name, email, etc.)"),
    project_id: z.string().optional(),
    dry_run: z.boolean().optional().describe("Preview what would be erased without actually erasing (default: false)"),
  },
  async (args) => {
    try {
      const { gdprErase } = await import("../lib/gdpr.js");
      const result = gdprErase(args.identifier, { project_id: args.project_id, dry_run: args.dry_run });
      const action = args.dry_run ? "Would erase" : "Erased";
      return { content: [{ type: "text" as const, text: `${action} ${result.erased_count} memor${result.erased_count === 1 ? "y" : "ies"} containing "${args.identifier}".${args.dry_run ? " (dry run — no changes made)" : ""}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_acl_set",
  "Set an access control rule for an agent. Patterns use * for glob matching (e.g., 'architecture-*' matches all architecture keys).",
  {
    agent_id: z.string().describe("Agent ID to set ACL for"),
    key_pattern: z.string().describe("Key pattern (glob: * matches anything)"),
    permission: z.enum(["read", "readwrite", "admin"]).describe("Permission level"),
    project_id: z.string().optional(),
  },
  async (args) => {
    try {
      const { setAcl } = await import("../db/acl.js");
      setAcl(args.agent_id, args.key_pattern, args.permission, args.project_id);
      return { content: [{ type: "text" as const, text: `ACL set: ${args.agent_id} → ${args.key_pattern} = ${args.permission}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_acl_list",
  "List access control rules for an agent.",
  {
    agent_id: z.string().describe("Agent ID to list ACLs for"),
  },
  async (args) => {
    try {
      const { listAcls } = await import("../db/acl.js");
      const acls = listAcls(args.agent_id);
      if (acls.length === 0) {
        return { content: [{ type: "text" as const, text: `No ACLs set for agent ${args.agent_id} (full access by default)` }] };
      }
      const lines = acls.map((a) => `${a.key_pattern} → ${a.permission}`);
      return { content: [{ type: "text" as const, text: `ACLs for ${args.agent_id}:\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// TASK 1: memory_evict — bounded memory with utility-based eviction
// ============================================================================

server.tool(
  "memory_evict",
  "Enforce memory bounds per scope. Archives lowest-utility memories (using decay score) when any scope exceeds its configured limit.",
  {
    project_id: z.string().optional().describe("Optional project ID to scope eviction to"),
  },
  async (args) => {
    try {
      const { enforceMemoryBounds } = await import("../lib/retention.js");
      const result = enforceMemoryBounds(args.project_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// TASK 2: memory_save conflict_strategy with vector clocks
// (conflict_strategy param is already handled via the existing 'conflict' param —
//  vector clock logic is added inline in memory_save via the save path)
// ============================================================================

// Vector clock update is done via a PostMemorySave-style approach.
// On every memory_save, we update the vector_clock column with the agent_id entry incremented.

// ============================================================================
// TASK 3: memory_save_image — image/screenshot memory with vision API
// ============================================================================

server.tool(
  "memory_save_image",
  "Save an image memory. If OPENAI_API_KEY is set and image_url provided, auto-extracts a description via GPT-4o-mini vision. Saves with content_type='image'.",
  {
    key: z.string(),
    image_url: z.string().optional().describe("URL of the image to describe"),
    image_description: z.string().optional().describe("Manual description if no auto-extraction needed"),
    scope: z.enum(["global", "shared", "private", "working"]).optional(),
    category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
    importance: z.coerce.number().min(1).max(10).optional(),
    tags: z.array(z.string()).optional(),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
  },
  async (args) => {
    try {
      ensureAutoProject();
      let description = args.image_description || "";

      // If image_url is provided and OPENAI_API_KEY is set, extract description via vision API
      if (args.image_url && process.env.OPENAI_API_KEY && !description) {
        try {
          const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              messages: [{
                role: "user",
                content: [
                  { type: "text", text: "Describe this image concisely for an AI agent's memory. Focus on what is shown, any text visible, and key details." },
                  { type: "image_url", image_url: { url: args.image_url } },
                ],
              }],
              max_tokens: 300,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (resp.ok) {
            const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
            description = data.choices?.[0]?.message?.content || "";
          }
        } catch {
          // Vision API failed — fall back to URL-only
        }
      }

      if (!description && args.image_url) {
        description = `Image at: ${args.image_url}`;
      }
      if (!description) {
        return { content: [{ type: "text" as const, text: "Error: Provide either image_url or image_description" }], isError: true };
      }

      const metadata: Record<string, unknown> = {};
      if (args.image_url) metadata.resource_uri = args.image_url;

      const memory = createMemory({
        key: args.key,
        value: description,
        scope: args.scope,
        category: args.category || "knowledge",
        importance: args.importance,
        tags: args.tags,
        agent_id: args.agent_id,
        project_id: args.project_id,
        session_id: args.session_id,
        metadata,
      });

      // Set content_type to 'image'
      const db = getDatabase();
      db.run("UPDATE memories SET content_type = 'image' WHERE id = ?", [memory.id]);

      return { content: [{ type: "text" as const, text: JSON.stringify({
        saved: memory.key,
        id: memory.id.slice(0, 8),
        content_type: "image",
        has_vision_description: !!args.image_url && description !== `Image at: ${args.image_url}`,
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// TASK 4: entity_disambiguate — find duplicate entities
// ============================================================================

server.tool(
  "entity_disambiguate",
  "Find potential duplicate entities by name similarity (trigram). Returns pairs above the threshold within same type+project.",
  {
    threshold: z.coerce.number().min(0).max(1).optional().describe("Similarity threshold 0-1 (default 0.8)"),
  },
  async (args) => {
    try {
      const { findDuplicateEntities } = await import("../db/entities.js");
      const pairs = findDuplicateEntities(args.threshold ?? 0.8);
      if (pairs.length === 0) {
        return { content: [{ type: "text" as const, text: "No duplicate entities found." }] };
      }
      const lines = pairs.map((p) =>
        `${p.entity_a.name} <-> ${p.entity_b.name} [${p.entity_a.type}] similarity=${p.similarity.toFixed(2)}`
      );
      return { content: [{ type: "text" as const, text: `Found ${pairs.length} potential duplicate(s):\n${lines.join("\n")}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// TASK 5: memory_compress — active context compression
// ============================================================================

server.tool(
  "memory_compress",
  "Compress multiple memories into a single summary memory. Uses LLM if available, otherwise truncates.",
  {
    memory_ids: z.array(z.string()).describe("Memory IDs to compress"),
    max_length: z.coerce.number().optional().describe("Max chars for compression (default 500)"),
  },
  async (args) => {
    try {
      const maxLen = args.max_length || 500;

      // Resolve and fetch all memories
      const memories: Memory[] = [];
      for (const mid of args.memory_ids) {
        const id = resolveId(mid);
        const m = getMemory(id);
        if (m) memories.push(m);
      }

      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: "No valid memories found for the given IDs." }], isError: true };
      }

      const concatenated = memories.map((m) => `[${m.key}]: ${m.value}`).join("\n\n");

      let compressed: string;

      // Try LLM summarization
      try {
        const { providerRegistry } = await import("../lib/providers/registry.js");
        const provider = providerRegistry.getAvailable();
        if (provider) {
          const result = await provider.extractMemories(
            `Summarize these memories into a single concise paragraph (max ${maxLen} chars). Preserve key facts and decisions:\n\n${concatenated}`,
            {}
          );
          compressed = result?.[0]?.content || concatenated.slice(0, maxLen);
        } else {
          // No LLM available — simple truncation
          compressed = concatenated.slice(0, maxLen);
          if (concatenated.length > maxLen) compressed += "...";
        }
      } catch {
        // LLM failed — fall back to truncation
        compressed = concatenated.slice(0, maxLen);
        if (concatenated.length > maxLen) compressed += "...";
      }

      // Save compressed result as new memory
      const timestamp = Date.now();
      const compressedMemory = createMemory({
        key: `compressed-${timestamp}`,
        value: compressed,
        category: "knowledge",
        scope: memories[0]!.scope,
        importance: Math.max(...memories.map((m) => m.importance)),
        tags: ["compressed"],
        agent_id: memories[0]!.agent_id || undefined,
        project_id: memories[0]!.project_id || undefined,
        metadata: {
          source_memory_ids: memories.map((m) => m.id),
          compression_ratio: concatenated.length > 0 ? (compressed.length / concatenated.length).toFixed(2) : "1.00",
        },
      });

      return { content: [{ type: "text" as const, text: JSON.stringify({
        compressed_id: compressedMemory.id.slice(0, 8),
        key: compressedMemory.key,
        source_count: memories.length,
        original_length: concatenated.length,
        compressed_length: compressed.length,
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// TASK 6: memory_subscribe / memory_unsubscribe — memory subscriptions
// ============================================================================

server.tool(
  "memory_subscribe",
  "Subscribe an agent to memory change notifications. Matches by key pattern (glob) and/or tag pattern.",
  {
    agent_id: z.string().describe("Agent ID to subscribe"),
    key_pattern: z.string().optional().describe("Key glob pattern (e.g. 'architecture-*')"),
    tag_pattern: z.string().optional().describe("Tag pattern to match"),
    scope: z.enum(["global", "shared", "private", "working"]).optional().describe("Scope filter"),
  },
  async (args) => {
    try {
      if (!args.key_pattern && !args.tag_pattern) {
        return { content: [{ type: "text" as const, text: "Error: Provide at least one of key_pattern or tag_pattern" }], isError: true };
      }
      const db = getDatabase();
      const id = crypto.randomUUID().slice(0, 8);
      db.run(
        `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, tag_pattern, scope, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [id, args.agent_id, args.key_pattern || null, args.tag_pattern || null, args.scope || null]
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({
        subscription_id: id,
        agent_id: args.agent_id,
        key_pattern: args.key_pattern || null,
        tag_pattern: args.tag_pattern || null,
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_unsubscribe",
  "Remove a memory subscription by ID.",
  {
    id: z.string().describe("Subscription ID to remove"),
  },
  async (args) => {
    try {
      const db = getDatabase();
      const result = db.run("DELETE FROM memory_subscriptions WHERE id = ?", [args.id]);
      if (result.changes === 0) {
        return { content: [{ type: "text" as const, text: `Subscription not found: ${args.id}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: `Unsubscribed: ${args.id}` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Tool event tracking
// ============================================================================

server.tool(
  "memory_save_tool_event",
  "Record a tool call event (success/failure, latency, tokens). Optionally saves a lesson as a shared memory.",
  {
    tool_name: z.string().describe("Name of the tool that was called (e.g. 'bash', 'read', 'grep')"),
    action: z.string().optional().describe("What was attempted (e.g. 'npm install', 'git push')"),
    success: z.boolean().describe("Whether the tool call succeeded"),
    error_type: z.enum(["timeout", "permission", "not_found", "syntax", "rate_limit", "other"]).optional().describe("Error category if failed"),
    error_message: z.string().optional().describe("Raw error text if failed"),
    tokens_used: z.number().optional().describe("Tokens consumed by the tool call"),
    latency_ms: z.number().optional().describe("Time taken in milliseconds"),
    context: z.string().optional().describe("What task triggered this tool call"),
    lesson: z.string().optional().describe("Qualitative insight learned from this call"),
    when_to_use: z.string().optional().describe("Activation context for the lesson"),
    agent_id: z.string().optional(),
    project_id: z.string().optional(),
    session_id: z.string().optional(),
  },
  async (args) => {
    try {
      const event = saveToolEvent(args);

      // If a lesson was provided, also persist it as a shared knowledge memory
      if (args.lesson) {
        try {
          createMemory({
            key: `tool-lesson-${args.tool_name}-${Date.now()}`,
            value: args.lesson,
            category: "knowledge",
            scope: "shared",
            importance: 7,
            tags: ["tool-memory", args.tool_name],
            when_to_use: args.when_to_use,
            agent_id: args.agent_id,
            project_id: args.project_id,
            session_id: args.session_id,
            source: "auto",
          } as unknown as CreateMemoryInput);
        } catch { /* duplicate or other non-critical error */ }
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({
        id: event.id,
        tool_name: event.tool_name,
        success: event.success,
        error_type: event.error_type,
        lesson_saved: !!args.lesson,
        created_at: event.created_at,
      }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Auto-Inject Orchestrator Tools (channel-based memory push)
// ============================================================================

server.tool(
  "memory_autoinject_config",
  "Get or set auto-inject orchestrator config (channel-based memory push). Controls throttle, debounce, rate limits, and similarity thresholds for proactive memory injection.",
  {
    action: z.enum(["get", "set"]).describe("Get or set auto-inject config"),
    throttle_ms: z.number().optional().describe("Min ms between pushes (default 30000)"),
    debounce_ms: z.number().optional().describe("Wait ms after last message before processing (default 2000)"),
    max_pushes_per_5min: z.number().optional().describe("Rate limit per 5-minute window (default 5)"),
    min_similarity: z.number().optional().describe("Minimum activation match threshold 0-1 (default 0.4)"),
    enabled: z.boolean().optional().describe("Enable/disable auto-inject"),
    session_briefing: z.boolean().optional().describe("Push session-start briefing (default true)"),
  },
  async (args) => {
    try {
      if (args.action === "get") {
        return { content: [{ type: "text" as const, text: JSON.stringify(getAutoInjectConfig(), null, 2) }] };
      }
      // action === "set"
      const updates: Record<string, unknown> = {};
      if (args.throttle_ms !== undefined) updates.throttle_ms = args.throttle_ms;
      if (args.debounce_ms !== undefined) updates.debounce_ms = args.debounce_ms;
      if (args.max_pushes_per_5min !== undefined) updates.max_pushes_per_5min = args.max_pushes_per_5min;
      if (args.min_similarity !== undefined) updates.min_similarity = args.min_similarity;
      if (args.enabled !== undefined) updates.enabled = args.enabled;
      if (args.session_briefing !== undefined) updates.session_briefing = args.session_briefing;
      const updated = updateAutoInjectConfig(updates);
      return { content: [{ type: "text" as const, text: JSON.stringify({ updated: true, config: updated }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_autoinject_status",
  "Get auto-inject orchestrator status: running state, session watcher, push history, rate limit counters, and full config.",
  {},
  async () => {
    try {
      const status = getAutoInjectStatus();
      const lines = [
        `Running: ${status.running}`,
        `Session ID: ${status.session_id || "none"}`,
        `Watcher active: ${status.watcher.active}`,
        `Watching file: ${status.watcher.watching_file || "none"}`,
        `Last offset: ${status.watcher.last_offset}`,
        ``,
        `Pushes:`,
        `  Total: ${status.pushes.total}`,
        `  Last 5 min: ${status.pushes.last_5min}`,
        `  Recently pushed memories: ${status.pushes.recently_pushed_memories}`,
        `  Next available in: ${status.pushes.next_available_in_ms}ms`,
        ``,
        `Config:`,
        `  Enabled: ${status.config.enabled}`,
        `  Throttle: ${status.config.throttle_ms}ms`,
        `  Debounce: ${status.config.debounce_ms}ms`,
        `  Max pushes/5min: ${status.config.max_pushes_per_5min}`,
        `  Min similarity: ${status.config.min_similarity}`,
        `  Session briefing: ${status.config.session_briefing}`,
      ];
      if (status.history.length > 0) {
        lines.push(``, `Recent push history:`);
        for (const h of status.history) {
          lines.push(`  [${h.timestamp}] ${h.memory_count} memories — "${h.context}"`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

server.tool(
  "memory_autoinject_test",
  "Test what memories would be activated by a given context WITHOUT pushing. Shows what the auto-inject pipeline would match — useful for tuning min_similarity.",
  {
    context_text: z.string().describe("Simulated context to test activation matching"),
    project_id: z.string().optional().describe("Scope to a specific project"),
    min_similarity: z.number().optional().default(0.4).describe("Minimum similarity threshold (default 0.4)"),
  },
  async (args) => {
    try {
      const memories = await findActivatedMemories(args.context_text, {
        project_id: args.project_id,
        min_similarity: args.min_similarity,
      });
      if (memories.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories matched the given context. Try lowering min_similarity or broadening the context text." }] };
      }
      const lines = [`${memories.length} memories would be activated:\n`];
      for (const m of memories) {
        lines.push(`- [${m.id.slice(0, 8)}] ${m.key}: ${m.value.slice(0, 200)}${m.value.length > 200 ? "…" : ""}`);
        if (m.tags.length > 0) lines.push(`  Tags: ${m.tags.join(", ")}`);
        lines.push(`  Scope: ${m.scope} | Importance: ${m.importance}/10`);
      }
      lines.push(`\nNote: DRY RUN — nothing was pushed.`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
    }
  }
);

// ============================================================================
// Start server
// ============================================================================

async function ensureRestServerRunning(): Promise<void> {
  // Check if server is already up
  try {
    const res = await fetch("http://127.0.0.1:19428/api/memories?limit=0", {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok || res.status === 200) return; // already running
  } catch {
    // Not running — spawn it
  }

  // Spawn mementos-serve as a detached background process
  const proc = Bun.spawn(["mementos-serve"], {
    detached: true,
    stdout: Bun.file("/tmp/mementos.log"),
    stderr: Bun.file("/tmp/mementos.log"),
  });
  proc.unref(); // Don't wait for it

  // Wait up to 3 seconds for it to start
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch("http://127.0.0.1:19428/api/memories?limit=0", {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok || res.status === 200) return;
    } catch {
      // Still starting
    }
  }
  // If it didn't start, continue anyway — tools will return errors gracefully
}

server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string(),
    email: z.string().optional(),
    category: z.enum(["bug", "feature", "general"]).optional(),
  },
  async (params) => {
    try {
      const db = getDatabase();
      const pkg = require("../../package.json");
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message, params.email || null, params.category || "general", pkg.version,
      ]);
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  },
);

async function main(): Promise<void> {
  await ensureRestServerRunning();

  // Load persisted webhooks into the in-memory registry
  loadWebhooksFromDb();

  const transport = new StdioServerTransport();
  registerCloudTools(server, "mementos");
  await server.connect(transport);

  // Start auto-inject orchestrator if enabled (non-blocking)
  const autoProject = detectProject();
  void startAutoInject({
    server,
    project_id: autoProject?.id,
    project_name: autoProject?.name,
    cwd: process.cwd(),
  }).catch(() => { /* non-critical — auto-inject is best-effort */ });

  // Clean up auto-inject on process exit
  process.on("SIGINT", () => { stopAutoInject(); process.exit(0); });
  process.on("SIGTERM", () => { stopAutoInject(); process.exit(0); });
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
