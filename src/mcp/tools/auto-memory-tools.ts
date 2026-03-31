import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  processConversationTurn,
  getAutoMemoryStats,
  configureAutoMemory,
} from "../../lib/auto-memory.js";
import { providerRegistry } from "../../lib/providers/registry.js";
import { startAutoInject, stopAutoInject, getAutoInjectConfig, updateAutoInjectConfig, getAutoInjectStatus } from "../../lib/auto-inject-orchestrator.js";
import { findActivatedMemories } from "../../lib/activation-matcher.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerAutoMemoryTools(server: McpServer): void {
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
}

export { startAutoInject, stopAutoInject };
