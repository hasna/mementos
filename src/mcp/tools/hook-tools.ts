import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hookRegistry } from "../../lib/hooks.js";
import {
  createWebhookHook,
  listWebhookHooks,
  updateWebhookHook,
  deleteWebhookHook,
} from "../../db/webhook_hooks.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerHookTools(server: McpServer): void {
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
        const { reloadWebhooks } = await import("../../lib/built-in-hooks.js");
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
          type: args.type as import("../../types/hooks.js").HookType | undefined,
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
}
