import { saveToolEvent, getToolEvents, getToolStats, getToolLessons } from "../../db/tool-events.js";
import { saveFeedback } from "../../db/feedback.js";
import { getDatabase } from "../../db/database.js";
import { addRoute } from "../router.js";
import { json, errorResponse, readJson, getSearchParams } from "../helpers.js";
import type { CreateToolEventInput } from "../../types/index.js";

export function registerSystemToolRoutes(): void {
  addRoute("POST", "/api/tool-events", async (req) => {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (!body || !body["tool_name"]) {
      return errorResponse("Missing required field: tool_name", 400);
    }

    const event = saveToolEvent(body as unknown as CreateToolEventInput);
    return json(event, 201);
  });

  // POST /api/feedback — record user feedback
  addRoute("POST", "/api/feedback", async (req) => {
    const body = (await readJson(req)) as Record<string, unknown> | null;
    if (!body || typeof body["message"] !== "string" || !body["message"].trim()) {
      return errorResponse("Missing required field: message", 400);
    }
    saveFeedback(
      {
        message: body["message"] as string,
        email: (body["email"] as string | null) ?? null,
        category: (body["category"] as string | null) ?? "general",
        version: (body["version"] as string | null) ?? null,
      },
      getDatabase()
    );
    return json({ ok: true }, 201);
  });

  addRoute("GET", "/api/tool-events", (_req: Request, url: URL) => {
    const q = getSearchParams(url);
    const filters: {
      tool_name?: string;
      agent_id?: string;
      project_id?: string;
      success?: boolean;
      from_date?: string;
      to_date?: string;
      limit?: number;
      offset?: number;
    } = {};

    if (q["tool_name"]) filters.tool_name = q["tool_name"];
    if (q["agent_id"]) filters.agent_id = q["agent_id"];
    if (q["project_id"]) filters.project_id = q["project_id"];
    if (q["success"] !== undefined && q["success"] !== "") filters.success = q["success"] === "true";
    if (q["from_date"]) filters.from_date = q["from_date"];
    if (q["to_date"]) filters.to_date = q["to_date"];
    if (q["limit"]) filters.limit = parseInt(q["limit"], 10);
    if (q["offset"]) filters.offset = parseInt(q["offset"], 10);

    const events = getToolEvents(filters);
    return json({ events, count: events.length });
  });

  addRoute("GET", "/api/tool-insights/:tool_name", (_req: Request, url: URL, params) => {
    const q = getSearchParams(url);
    const toolName = decodeURIComponent(params["tool_name"]!);
    const projectId = q["project_id"];
    const lessonsLimit = q["limit"] ? parseInt(q["limit"], 10) : 20;

    const stats = getToolStats(toolName, projectId || undefined);
    const lessons = getToolLessons(toolName, projectId || undefined, lessonsLimit);

    return json({ stats, lessons });
  });
}
