import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAgent, getAgent, listAgents, listAgentsByProject, updateAgent } from "../../db/agents.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "register_agent",
    "Register an agent. Idempotent — same name returns existing agent.",
    {
      name: z.string(),
      session_id: z.string().optional(),
      description: z.string().optional(),
      role: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const agent = registerAgent(args.name, args.session_id, args.description, args.role, args.project_id);
        return {
          content: [{
            type: "text" as const,
            text: `Agent registered:\nID: ${agent.id}\nName: ${agent.name}\nRole: ${agent.role || "agent"}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "list_agents",
    "List all registered agents",
    {},
    async () => {
      try {
        const agents = listAgents();
        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: "No agents registered." }] };
        }
        const lines = agents.map((a) => `${a.id} | ${a.name} | ${a.role || "agent"} | project: ${a.active_project_id || "-"} | last seen: ${a.last_seen_at}`);
        return { content: [{ type: "text" as const, text: `${agents.length} agent(s):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "get_agent",
    "Get agent details by ID or name",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const agent = getAgent(args.id);
        if (!agent) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${args.id}` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Agent:\nID: ${agent.id}\nName: ${agent.name}\nDescription: ${agent.description || "-"}\nRole: ${agent.role || "agent"}\nCreated: ${agent.created_at}\nLast seen: ${agent.last_seen_at}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "update_agent",
    "Update agent name, description, role, metadata, or active_project_id.",
    {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      role: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      active_project_id: z.string().nullable().optional(),
    },
    async (args) => {
      try {
        const { id, ...updates } = args;
        const agent = updateAgent(id, updates);
        if (!agent) {
          return { content: [{ type: "text" as const, text: `Agent not found: ${id}` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Agent updated:\nID: ${agent.id}\nName: ${agent.name}\nDescription: ${agent.description || "-"}\nRole: ${agent.role || "agent"}\nActive project: ${agent.active_project_id || "-"}\nLast seen: ${agent.last_seen_at}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "list_agents_by_project",
    "List agents currently active on a project.",
    {
      project_id: z.string(),
    },
    async (args) => {
      try {
        const agents = listAgentsByProject(args.project_id);
        if (agents.length === 0) {
          return { content: [{ type: "text" as const, text: `No active agents for project: ${args.project_id}` }] };
        }
        const lines = agents.map((a) => `${a.id} | ${a.name} | ${a.role || "agent"} | last seen: ${a.last_seen_at}`);
        return { content: [{ type: "text" as const, text: `${agents.length} agent(s) on project ${args.project_id}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
