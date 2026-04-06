import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  touchMemory,
  getMemoryVersions,
  semanticSearch,
  parseMemoryRow,
} from "../../db/memories.js";
import { touchAgent } from "../../db/agents.js";
import { resolveProjectId } from "../../lib/focus.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { searchMemories } from "../../lib/search.js";
import { getCurrentMachineId } from "../../db/machines.js";
import { parseDuration } from "../../lib/duration.js";
import { ensureAutoProject, formatError, resolveId, formatMemory, formatAsmrResult } from "./memory-utils.js";
import type {
  MemoryFilter,
  CreateMemoryInput,
} from "../../types/index.js";

export { ensureAutoProject, formatError, resolveId, formatMemory, formatAsmrResult };

export function registerMemoryTools(server: McpServer): void {
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
        const dedupeMode = (conflict as import("../../types/index.js").DedupeMode | undefined) ?? "merge";
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
            const { broadcastSharedMemory } = await import('../memory-broadcast.js');
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
        const staleCutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
        const forgottenCutoff = new Date(Date.now() - forgottenDays * 86400000).toISOString();
        const extraParams: (string | number)[] = [
          staleCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        const base = `status = 'active' AND pinned = 0${extraWhere ? " AND " + extraWhere : ""}`;

        // 1. Stale: never accessed or not accessed in staleDays, access_count == 0
        const stale = db.prepare(
          `SELECT id, key, value, importance, scope, created_at FROM memories
           WHERE ${base} AND access_count = 0 AND created_at < ?
           ORDER BY created_at ASC LIMIT ?`
        ).all(...extraParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; created_at: string}>;

        const forgottenParams: (string | number)[] = [
          forgottenCutoff,
          ...(args.project_id ? [args.project_id] : []),
          ...(args.agent_id ? [args.agent_id] : []),
        ];
        // 2. High-importance forgotten: importance >= 7, not accessed in forgottenDays
        const forgotten = db.prepare(
          `SELECT id, key, value, importance, scope, accessed_at FROM memories
           WHERE ${base} AND importance >= 7
             AND (accessed_at IS NULL OR accessed_at < ?)
           ORDER BY importance DESC, COALESCE(accessed_at, created_at) ASC LIMIT ?`
        ).all(...forgottenParams, limit) as Array<{id: string; key: string; value: string; importance: number; scope: string; accessed_at: string|null}>;

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
        const effectiveProjectId = args.project_id;

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
        const { detectContradiction } = await import("../../lib/contradiction.js");
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
        const { invalidateFact } = await import("../../lib/contradiction.js");
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
}
