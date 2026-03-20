/**
 * Built-in hooks — registered at server/MCP startup.
 * These are system-level hooks that power the auto-memory pipeline.
 *
 * Built-in hooks cannot be unregistered (builtin: true).
 * They are always non-blocking so they never delay the calling operation.
 */

import { hookRegistry } from "./hooks.js";
import {
  listWebhookHooks,
  recordWebhookInvocation,
} from "../db/webhook_hooks.js";
import type { HookType } from "../types/hooks.js";

// Lazy import to avoid circular deps — auto-memory imports db, which imports hooks
let _processConversationTurn: typeof import("./auto-memory.js").processConversationTurn | null = null;
async function getAutoMemory() {
  if (!_processConversationTurn) {
    const mod = await import("./auto-memory.js");
    _processConversationTurn = mod.processConversationTurn;
  }
  return _processConversationTurn;
}

// ============================================================================
// Built-in: PostMemorySave → trigger entity extraction via auto-memory pipeline
// ============================================================================

hookRegistry.register({
  type: "PostMemorySave",
  blocking: false,
  builtin: true,
  priority: 100,
  description: "Trigger async LLM entity extraction when a memory is saved",
  handler: async (ctx) => {
    // Only process new memories (not upsert merges that already existed)
    if (ctx.wasUpdated) return;

    const processConversationTurn = await getAutoMemory();
    processConversationTurn(
      `${ctx.memory.key}: ${ctx.memory.value}`,
      {
        agentId: ctx.agentId,
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
      }
    );
  },
});

// ============================================================================
// Built-in: OnSessionStart → log session start as history memory
// ============================================================================

hookRegistry.register({
  type: "OnSessionStart",
  blocking: false,
  builtin: true,
  priority: 100,
  description: "Record session start as a history memory for analytics",
  handler: async (ctx) => {
    // Lazy import to avoid circular deps
    const { createMemory } = await import("../db/memories.js");
    try {
      createMemory({
        key: `session-start-${ctx.agentId}`,
        value: `Agent ${ctx.agentId} started session on project ${ctx.projectId} at ${new Date(ctx.timestamp).toISOString()}`,
        category: "history",
        scope: "shared",
        importance: 3,
        source: "system",
        agent_id: ctx.agentId,
        project_id: ctx.projectId,
        session_id: ctx.sessionId,
      });
    } catch {
      // Duplicate key on upsert is fine — session already recorded
    }
  },
});

// ============================================================================
// Built-in: PostMemorySave analytics → record event for synthesis corpus
// ============================================================================

hookRegistry.register({
  type: "PostMemorySave",
  blocking: false,
  builtin: true,
  priority: 200,
  description: "Record memory save event for synthesis analytics",
  handler: async (ctx) => {
    const { recordSynthesisEvent } = await import("../db/synthesis.js");
    recordSynthesisEvent({
      event_type: "saved",
      memory_id: ctx.memory.id,
      agent_id: ctx.agentId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId,
      importance_at_time: ctx.memory.importance,
    });
  },
});

// ============================================================================
// Built-in: PostMemorySave → async embedding generation for semantic search
// ============================================================================

hookRegistry.register({
  type: "PostMemorySave",
  blocking: false,
  builtin: true,
  priority: 300,
  description: "Generate and store vector embedding for semantic memory search",
  handler: async (ctx) => {
    const { indexMemoryEmbedding } = await import("../db/memories.js");
    const text = [ctx.memory.value, ctx.memory.summary].filter(Boolean).join(" ");
    void indexMemoryEmbedding(ctx.memory.id, text);
  },
});

// ============================================================================
// Built-in: PostMemoryInject analytics → record injection event for synthesis
// ============================================================================

hookRegistry.register({
  type: "PostMemoryInject",
  blocking: false,
  builtin: true,
  priority: 200,
  description: "Record injection event for synthesis analytics",
  handler: async (ctx) => {
    const { recordSynthesisEvent } = await import("../db/synthesis.js");
    recordSynthesisEvent({
      event_type: "injected",
      agent_id: ctx.agentId,
      project_id: ctx.projectId,
      session_id: ctx.sessionId,
      metadata: { count: ctx.memoriesCount, format: ctx.format },
    });
  },
});

// ============================================================================
// Webhook loader — load persisted webhooks from DB and register in registry
// ============================================================================

let _webhooksLoaded = false;

export function loadWebhooksFromDb(): void {
  if (_webhooksLoaded) return;
  _webhooksLoaded = true;

  try {
    const webhooks = listWebhookHooks({ enabled: true });

    for (const wh of webhooks) {
      hookRegistry.register({
        type: wh.type,
        blocking: wh.blocking,
        priority: wh.priority,
        agentId: wh.agentId,
        projectId: wh.projectId,
        description: wh.description ?? `Webhook: ${wh.handlerUrl}`,
        handler: makeWebhookHandler(wh.id, wh.handlerUrl) as unknown as Parameters<typeof hookRegistry.register>[0]["handler"],
      });
    }

    if (webhooks.length > 0) {
      console.log(`[hooks] Loaded ${webhooks.length} webhook(s) from DB`);
    }
  } catch (err) {
    console.error("[hooks] Failed to load webhooks from DB:", err);
  }
}

/**
 * Create a handler that POSTs the hook context to an HTTP endpoint.
 * Records invocation stats in DB.
 */
function makeWebhookHandler(webhookId: string, url: string) {
  return async (context: Record<string, unknown>): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
        signal: AbortSignal.timeout(10_000),
      });
      recordWebhookInvocation(webhookId, res.ok);
    } catch {
      recordWebhookInvocation(webhookId, false);
    }
  };
}

// Re-export so callers can reload webhooks when a new one is created
export function reloadWebhooks(): void {
  _webhooksLoaded = false;
  loadWebhooksFromDb();
}

// Export hook type for use in MCP/REST
export type { HookType };
