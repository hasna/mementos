import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setFocus, getFocus, unfocus } from "../../lib/focus.js";
import { getAgent, touchAgent } from "../../db/agents.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerFocusTools(server: McpServer): void {
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
}
