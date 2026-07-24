import { getDatabase } from "../../db/database.js";
import {
  createSubscription,
  deleteSubscription,
  getSubscriptionNotifications,
} from "../../db/subscriptions.js";
import { addRoute } from "../router.js";
import { json, errorResponse, getSearchParams, readJson } from "../helpers.js";

export function registerSystemSubscriptionRoutes(): void {
  // POST /api/subscriptions — create a subscription
  addRoute("POST", "/api/subscriptions", async (req) => {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (!body || typeof body["agent_id"] !== "string") {
      return errorResponse("Missing required field: agent_id", 400);
    }
    if (!body["key_pattern"] && !body["tag_pattern"]) {
      return errorResponse("Provide at least one of key_pattern or tag_pattern", 400);
    }
    const sub = createSubscription(
      {
        agent_id: body["agent_id"] as string,
        key_pattern: (body["key_pattern"] as string | null) ?? null,
        tag_pattern: (body["tag_pattern"] as string | null) ?? null,
        scope: (body["scope"] as string | null) ?? null,
      },
      getDatabase()
    );
    return json(sub, 201);
  });

  // GET /api/subscriptions/notifications — change notifications for an agent
  addRoute("GET", "/api/subscriptions/notifications", (_req: Request, url: URL) => {
    const agentId = getSearchParams(url)["agent_id"];
    if (!agentId) return errorResponse("Missing required query param: agent_id", 400);
    return json({ changes: getSubscriptionNotifications(agentId, getDatabase()) });
  });

  // DELETE /api/subscriptions/:id — remove a subscription
  addRoute("DELETE", "/api/subscriptions/:id", (_req: Request, _url: URL, params) => {
    const deleted = deleteSubscription(params["id"]!, getDatabase());
    if (!deleted) return errorResponse(`Subscription not found: ${params["id"]}`, 404);
    return json({ deleted: true });
  });
}
