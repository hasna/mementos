import { hookRegistry } from "../../lib/hooks.js";
import { reloadWebhooks } from "../../lib/built-in-hooks.js";
import {
  createWebhookHook,
  listWebhookHooks,
  getWebhookHook,
  updateWebhookHook,
  deleteWebhookHook,
} from "../../db/webhook_hooks.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson } from "../helpers.js";

export function registerSystemHookRoutes(): void {
  addRoute("GET", "/api/hooks", (_req, url) => {
    const type = url.searchParams.get("type") ?? undefined;
    const hooks = hookRegistry.list(type as Parameters<typeof hookRegistry.list>[0]);
    return json(hooks.map((h) => ({
      id: h.id,
      type: h.type,
      blocking: h.blocking,
      priority: h.priority,
      builtin: h.builtin ?? false,
      agentId: h.agentId,
      projectId: h.projectId,
      description: h.description,
    })));
  });

  addRoute("GET", "/api/hooks/stats", () => json(hookRegistry.stats()));

  addRoute("GET", "/api/webhooks", (_req, url) => {
    const type = url.searchParams.get("type") ?? undefined;
    const enabledParam = url.searchParams.get("enabled");
    const enabled = enabledParam !== null ? enabledParam === "true" : undefined;
    return json(listWebhookHooks({
      type: type as import("../../types/hooks.js").HookType | undefined,
      enabled,
    }));
  });

  addRoute("POST", "/api/webhooks", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (!body.type || !body.handler_url) {
      return errorResponse("type and handler_url are required", 400);
    }
    const wh = createWebhookHook({
      type: body.type as import("../../types/hooks.js").HookType,
      handlerUrl: body.handler_url as string,
      priority: body.priority as number | undefined,
      blocking: body.blocking as boolean | undefined,
      agentId: body.agent_id as string | undefined,
      projectId: body.project_id as string | undefined,
      description: body.description as string | undefined,
    });
    reloadWebhooks();
    return json(wh, 201);
  });

  addRoute("GET", "/api/webhooks/:id", (_req, _url, params) => {
    const wh = getWebhookHook(params["id"]!);
    if (!wh) return errorResponse("Webhook not found", 404);
    return json(wh);
  });

  addRoute("PATCH", "/api/webhooks/:id", async (req, _url, params) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const updated = updateWebhookHook(params["id"]!, {
      enabled: body.enabled as boolean | undefined,
      priority: body.priority as number | undefined,
      description: body.description as string | undefined,
    });
    if (!updated) return errorResponse("Webhook not found", 404);
    reloadWebhooks();
    return json(updated);
  });

  addRoute("DELETE", "/api/webhooks/:id", (_req, _url, params) => {
    const deleted = deleteWebhookHook(params["id"]!);
    if (!deleted) return errorResponse("Webhook not found", 404);
    return new Response(null, { status: 204 });
  });
}
