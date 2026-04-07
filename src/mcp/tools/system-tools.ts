import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSystemMemoryAdminTools } from "./system-tools-memory-admin.js";
import { registerSystemEventTools } from "./system-tools-events.js";
import { getSystemToolDeps } from "./system-tools-shared.js";

export function registerSystemTools(server: McpServer): void {
  const deps = getSystemToolDeps(server);

  registerSystemMemoryAdminTools(deps);
  registerSystemEventTools(deps);
}
