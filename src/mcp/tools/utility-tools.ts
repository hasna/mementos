import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cleanExpiredMemories,
} from "../../db/memories.js";
import { getAgent } from "../../db/agents.js";
import { getDatabase } from "../../db/database.js";
import { listMemories, touchMemory } from "../../db/memories.js";
import { synthesizeProfile } from "../../lib/profile-synthesizer.js";
import {
  isMemoryVisibleToMachine,
  resolveVisibleMachineId,
} from "../../lib/machine-visibility.js";
import type {
  MemoryFilter,
} from "../../types/index.js";

import { ensureAutoProject, formatError } from "./memory-utils.js";
import { registerToolSchemas, searchToolEntries, getToolSchema, getAllToolEntries } from "./tool-registry.js";

// Tool schemas for this module's tools
const UTILITY_TOOL_SCHEMAS = {
  clean_expired: {
    description: "Remove expired memories from the database. Returns count of removed entries.",
    category: "utility",
    params: {},
    example: '{}',
  },
  memory_briefing: {
    description: "Lightweight delta briefing: what memories changed since an agent's last session. Use at session start instead of memory_context to avoid re-reading everything.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent ID or name. If provided, defaults since to agent's last_seen_at." },
      since: { type: "string", description: "ISO 8601 timestamp. Defaults to agent's last_seen_at if agent_id provided, otherwise 24h ago." },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      machine_id: { type: "string", description: "Current machine ID for machine-local memory visibility. Defaults to the current machine." },
      limit: { type: "number", description: "Max memories per category (default: 20)" },
    },
    example: '{"agent_id":"maximus","since":"2024-01-01T00:00:00Z"}',
  },
  memory_context: {
    description: "Get memories relevant to current context. Uses time-weighted scoring: score = importance × decay(age). Pinned memories are exempt. Returns effective_score on each memory.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      limit: { type: "number", description: "Max results (default: 30)" },
      decay_halflife_days: { type: "number", description: "Importance half-life in days (default: 90). Lower = more weight on recent memories." },
      no_decay: { type: "boolean", description: "Set true to disable decay and sort purely by importance." },
      task_context: { type: "string", description: "What the agent is about to do. When provided, activates intent-based retrieval — matches against when_to_use fields." },
      strategy: { type: "string", description: "Injection strategy: 'default' = decay-scored, 'smart' = activation-matched + layered + tool-aware", enum: ["default", "smart"] },
      machine_id: { type: "string", description: "Current machine ID for machine-local memory visibility. Defaults to the current machine." },
    },
    example: '{"scope":"global","limit":20,"strategy":"smart","task_context":"deploying to production"}',
  },
  memory_context_layered: {
    description: "Structured multi-section memory context: Core Facts, Recent History, Relevant Knowledge, Active Decisions. Better than flat lists for agent prompts.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      query: { type: "string", description: "Query to find relevant knowledge (populates Relevant Knowledge section)" },
      max_per_section: { type: "number", description: "Max memories per section (default: 10)" },
      machine_id: { type: "string", description: "Current machine ID for machine-local memory visibility. Defaults to the current machine." },
    },
    example: '{"project_id":"proj-uuid","max_per_section":5}',
  },
  memory_profile: {
    description: "Synthesize a coherent profile from preference and fact memories using LLM. Cached for 24h, auto-refreshed when preferences change. Returns markdown profile.",
    category: "memory",
    params: {
      project_id: { type: "string", description: "Project UUID to scope profile to" },
      agent_id: { type: "string", description: "Agent UUID to scope profile to" },
      scope: { type: "string", description: "Profile scope", enum: ["agent", "project", "global"] },
      force_refresh: { type: "boolean", description: "Force re-synthesis even if cached profile exists (default false)" },
    },
    example: '{"project_id":"proj-uuid","scope":"project"}',
  },
  search_tools: {
    description: "Search available tools by name or keyword. Returns names only.",
    category: "meta",
    params: {
      query: { type: "string", description: "Search keyword (matches tool name or description)", required: true },
      category: { type: "string", description: "Category filter", enum: ["memory", "agent", "project", "bulk", "utility", "graph", "meta"] },
    },
    example: '{"query":"memory","category":"memory"}',
  },
  describe_tools: {
    description: "Get full parameter schemas and examples for tools. Omit names to list all tools.",
    category: "meta",
    params: {
      names: { type: "array", description: "Tool names to describe (omit for all tools)", items: { type: "string" } },
    },
    example: '{"names":["memory_save","memory_recall"]}',
  },
};

export function registerUtilityTools(server: McpServer): void {
  // Register schemas for discovery tools
  registerToolSchemas(UTILITY_TOOL_SCHEMAS);

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
    "memory_briefing",
    "Lightweight delta briefing: what memories changed since an agent's last session. Use at session start instead of memory_context to avoid re-reading everything.",
    {
      agent_id: z.string().optional().describe("Agent ID or name. If provided, defaults since to agent's last_seen_at."),
      since: z.string().optional().describe("ISO 8601 timestamp. Defaults to agent's last_seen_at if agent_id provided, otherwise 24h ago."),
      project_id: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      machine_id: z.string().optional().describe("Current machine ID for machine-local memory visibility. Defaults to the current machine."),
      limit: z.coerce.number().optional().describe("Max memories per category (default: 20)"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const limit = args.limit || 20;
        const visibleMachineId = resolveVisibleMachineId(args.machine_id, db);

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
        const machineClause = visibleMachineId === null
          ? "AND machine_id IS NULL"
          : "AND (machine_id IS NULL OR machine_id = ?)";
        const extraParams = [
          ...(args.scope ? [args.scope] : []),
          ...(args.project_id ? [args.project_id] : []),
          ...(visibleMachineId === null ? [] : [visibleMachineId]),
        ];

        // New memories
        const newMems = db.prepare(
          `SELECT id, key, value, summary, importance, scope, category, agent_id, created_at
           FROM memories WHERE status = 'active' AND created_at > ? ${scopeClause} ${projectClause} ${machineClause}
           ORDER BY importance DESC, created_at DESC LIMIT ?`
        ).all(since, ...extraParams, limit) as Array<{id: string; key: string; value: string; summary: string|null; importance: number; scope: string; category: string; agent_id: string|null; created_at: string}>;

        // Updated memories (updated_at > since but created before since)
        const updatedMems = db.prepare(
          `SELECT id, key, value, summary, importance, scope, category, agent_id, updated_at
           FROM memories WHERE status = 'active' AND updated_at > ? AND created_at <= ? ${scopeClause} ${projectClause} ${machineClause}
           ORDER BY importance DESC, updated_at DESC LIMIT ?`
        ).all(since, since, ...extraParams, limit) as Array<{id: string; key: string; summary: string|null; importance: number; scope: string; value: string; agent_id: string|null; updated_at: string}>;

        // Expired/archived memories
        const expiredMems = db.prepare(
          `SELECT id, key, scope, category, updated_at, status
           FROM memories WHERE status != 'active' AND updated_at > ? ${scopeClause} ${projectClause} ${machineClause}
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
      machine_id: z.string().optional().describe("Current machine ID for machine-local memory visibility. Defaults to the current machine."),
    },
    async (args) => {
      try {
        // Smart strategy: delegate to full smartInject pipeline
        if (args.strategy === "smart" && args.task_context) {
          const { smartInject } = await import("../../lib/injector.js");
          const result = await smartInject({
            task_context: args.task_context,
            project_id: args.project_id,
            agent_id: args.agent_id,
            machine_id: args.machine_id,
            max_tokens: args.limit ? args.limit * 20 : undefined,
          });
          return { content: [{ type: "text" as const, text: result.output }] };
        }

        const visibleMachineId = resolveVisibleMachineId(args.machine_id);
        const filter: MemoryFilter = {
          scope: args.scope,
          agent_id: args.agent_id,
          project_id: args.project_id,
          status: "active",
          visible_to_machine_id: visibleMachineId,
          limit: (args.limit || 30) * 2, // fetch 2x, then rerank by effective score
        };
        const memories = listMemories(filter);

        // task_context activation: semantic search against when_to_use embeddings
        // Activation-matched memories get a +3 importance boost for scoring
        const activationBoostedIds = new Set<string>();
        if (args.task_context) {
          try {
            const { semanticSearch } = await import("../../db/memories.js");
            const activationResults = await semanticSearch(args.task_context, {
              threshold: 0.3,
              limit: 20,
              scope: args.scope,
              agent_id: args.agent_id,
              project_id: args.project_id,
            });
            const seenIds = new Set(memories.map((m) => m.id));
            for (const r of activationResults) {
              if (!isMemoryVisibleToMachine(r.memory, visibleMachineId)) continue;
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
      machine_id: z.string().optional().describe("Current machine ID for machine-local memory visibility. Defaults to the current machine."),
    },
    async (args) => {
      try {
        const { assembleContext, formatLayeredContext } = await import("../../lib/context.js");
        const ctx = assembleContext({
          project_id: args.project_id,
          agent_id: args.agent_id,
          machine_id: args.machine_id,
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

  server.tool(
    "search_tools",
    "Search available tools by name or keyword. Returns names only.",
    {
      query: z.string(),
      category: z.enum(["memory", "agent", "project", "bulk", "utility", "graph", "meta"]).optional(),
    },
    async (args) => {
      const results = searchToolEntries(args.query, args.category);
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
        : getAllToolEntries().map(t => t.name);
      const results = targets
        .map(name => getToolSchema(name))
        .filter((schema): schema is NonNullable<typeof schema> => schema !== undefined)
        .map(schema => {
          const paramLines = Object.entries(schema.params).map(([pname, p]) => {
            const req = p.required ? " [required]" : "";
            const enumStr = p.enum ? ` (${p.enum.join("|")})` : "";
            return `  ${pname}${req}: ${p.type}${enumStr} — ${p.description}`;
          });
          const lines = [
            `### ${schema.description.split('.')[0]} [${schema.category}]`,
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
}
