import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCloudConfig } from "@hasna/cloud";
import { z } from "zod";
import {
  registerProject,
  listProjects,
  getProject,
} from "../../db/projects.js";
import {
  registerMachine,
  listMachines,
  getMachine,
  renameMachine,
  setPrimaryMachine,
} from "../../db/machines.js";
import { pullCloudChanges, pushCloudChanges } from "../../lib/cloud-sync.js";

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const msg = error.message;
    if (msg.includes("UNIQUE constraint failed: projects.")) {
      return `Project already registered at this path. Use list_projects to find it.`;
    }
    if (msg.includes("UNIQUE constraint failed")) {
      const table = msg.match(/UNIQUE constraint failed: (\w+)\./)?.[1] ?? "unknown";
      return `Duplicate entry in ${table}. The record already exists — use the list or get tool to find it.`;
    }
    if (msg.includes("FOREIGN KEY constraint failed")) {
      return `Referenced record not found. Check that the project_id or agent_id exists.`;
    }
    return msg;
  }
  return String(error);
}

function cloudSyncEnabled(): boolean {
  const mode = getCloudConfig().mode;
  return mode === "hybrid" || mode === "cloud";
}

function syncMachinesTable(direction: "push" | "pull", currentMachineId?: string): void {
  if (!cloudSyncEnabled()) return;

  const result = direction === "push"
    ? pushCloudChanges({ tables: ["machines"], current_machine_id: currentMachineId ?? null })
    : pullCloudChanges({ tables: ["machines"], current_machine_id: currentMachineId ?? null });

  if (result.errors.length > 0) {
    throw new Error(`Cloud ${direction} for machines failed: ${result.errors.join("; ")}`);
  }
}

export function registerProjectTools(server: McpServer): void {
  server.tool(
    "register_project",
    "Register a project for memory scoping",
    {
      name: z.string(),
      path: z.string(),
      description: z.string().optional(),
      memory_prefix: z.string().optional(),
    },
    async (args) => {
      try {
        const project = registerProject(args.name, args.path, args.description, args.memory_prefix);
        return {
          content: [{
            type: "text" as const,
            text: `Project registered:\nID: ${project.id}\nName: ${project.name}\nPath: ${project.path}\nCreated: ${project.created_at}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "list_projects",
    "List all registered projects",
    {},
    async () => {
      try {
        const projects = listProjects();
        if (projects.length === 0) {
          return { content: [{ type: "text" as const, text: "No projects registered." }] };
        }
        const lines = projects.map((p) => `${p.id.slice(0, 8)} | ${p.name} | ${p.path}`);
        return { content: [{ type: "text" as const, text: `${projects.length} project(s):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "get_project",
    "Get a project by ID, path, or name.",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const project = getProject(args.id);
        if (!project) {
          return { content: [{ type: "text" as const, text: `Project not found: ${args.id}` }] };
        }
        return {
          content: [{
            type: "text" as const,
            text: `Project:\nID: ${project.id}\nName: ${project.name}\nPath: ${project.path}\nDescription: ${project.description || "-"}\nCreated: ${project.created_at}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  // ── Machine registry ──────────────────────────────────────────────────────────

  server.tool(
    "register_machine",
    "Register the current machine in the mementos machine registry. Auto-detects hostname. Idempotent by hostname.",
    { name: z.string().optional().describe("Human-readable name (e.g. 'apple01'). Defaults to hostname.") },
    async (args) => {
      try {
        syncMachinesTable("pull");
        const machine = registerMachine(args.name);
        syncMachinesTable("push", machine.id);
        return { content: [{ type: "text" as const, text: `Machine: ${machine.name} | ${machine.id.slice(0, 8)} | hostname:${machine.hostname} | platform:${machine.platform}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "list_machines",
    "List all registered machines with their hostname, platform, primary status, and last seen time.",
    {},
    async () => {
      try {
        syncMachinesTable("pull");
        const machines = listMachines();
        return { content: [{ type: "text" as const, text: JSON.stringify(machines) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "rename_machine",
    "Rename a machine by its ID or current name.",
    { id: z.string().describe("Machine ID or name"), new_name: z.string() },
    async (args) => {
      try {
        syncMachinesTable("pull");
        const machine = getMachine(args.id);
        if (!machine) return { content: [{ type: "text" as const, text: `Machine not found: ${args.id}` }], isError: true };
        const updated = renameMachine(machine.id, args.new_name);
        syncMachinesTable("push", updated.id);
        return { content: [{ type: "text" as const, text: `Renamed: ${machine.name} → ${updated.name}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "set_primary_machine",
    "Mark a machine as the primary machine. Only one primary machine is allowed at a time.",
    { id: z.string().describe("Machine ID or name") },
    async (args) => {
      try {
        syncMachinesTable("pull");
        const updated = setPrimaryMachine(args.id);
        syncMachinesTable("push", updated.id);
        return {
          content: [{
            type: "text" as const,
            text: `Primary machine: ${updated.name} | ${updated.id.slice(0, 8)} | hostname:${updated.hostname}`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
