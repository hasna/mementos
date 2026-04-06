import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatError } from "./memory-utils.js";

export function registerMemorySyncTools(server: McpServer): void {
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
        const { pushToRemote } = await import("../../lib/remote-sync.js");
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
        const { pullFromRemote } = await import("../../lib/remote-sync.js");
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
        const { pingRemote } = await import("../../lib/remote-sync.js");
        const result = await pingRemote(args.url);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
