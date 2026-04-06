#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { listMemories } from "../db/memories.js";
import { listAgents } from "../db/agents.js";
import { listProjects } from "../db/projects.js";
import { detectProject } from "../lib/project-detect.js";
import { loadWebhooksFromDb } from "../lib/built-in-hooks.js";
import { startAutoInject, stopAutoInject } from "../lib/auto-inject-orchestrator.js";

import { registerMemoryTools } from "./tools/memory-tools.js";
import { registerMemorySearchTools } from "./tools/memory-search.js";
import { registerMemoryLifecycleTools } from "./tools/memory-lifecycle.js";
import { registerMemorySyncTools } from "./tools/memory-sync.js";
import { registerMemoryStatsTools } from "./tools/memory-stats.js";
import { registerMemoryAuditTools } from "./tools/memory-audit.js";
import { registerMemoryIoTools } from "./tools/memory-io.js";
import { registerMemoryInjectTools } from "./tools/memory-inject.js";
import { registerEntityTools } from "./tools/graph-entity-tools.js";
import { registerRelationTools } from "./tools/graph-relation-tools.js";
import { registerGraphQueryTools } from "./tools/graph-query-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerProjectTools } from "./tools/project-tools.js";
import { registerBulkTools } from "./tools/bulk-tools.js";
import { registerLockTools } from "./tools/lock-tools.js";
import { registerFocusTools } from "./tools/focus-tools.js";
import { registerHookTools } from "./tools/hook-tools.js";
import { registerSynthesisTools } from "./tools/synthesis-tools.js";
import { registerAutoMemoryTools } from "./tools/auto-memory-tools.js";
import { registerSessionTools } from "./tools/session-tools.js";
import { registerUtilityTools } from "./tools/utility-tools.js";
import { registerSystemTools } from "./tools/system-tools.js";

// Read version from package.json — never hardcode
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

/** Exported so other modules can push channel notifications via the underlying Server. */
export let mcpServer: McpServer | null = null;

const server = new McpServer(
  {
    name: "mementos",
    version: _pkg.version,
  },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: `Mementos is the persistent memory layer for AI agents. It stores, searches, and manages memories across sessions and projects.

When running with --dangerously-load-development-channels, mementos will proactively push relevant memories into your conversation via channel notifications. These appear as <channel source="mementos"> tags. They contain memories activated by your current task context — use them to inform your work. You don't need to call memory_inject when auto-inject is active.`,
  },
);

mcpServer = server;

function hasFlag(...flags: string[]): boolean {
  return process.argv.some((arg) => flags.includes(arg));
}

function printHelp(): void {
  process.stdout.write(
    `Usage: mementos-mcp [options]

Mementos MCP server (stdio transport)

Options:
  -h, --help       Show help
  -V, --version    Show version
`
  );
}

// Register all tool groups
registerMemoryTools(server);
registerMemorySearchTools(server);
registerMemoryLifecycleTools(server);
registerMemorySyncTools(server);
registerMemoryStatsTools(server);
registerMemoryAuditTools(server);
registerMemoryIoTools(server);
registerMemoryInjectTools(server);
registerEntityTools(server);
registerRelationTools(server);
registerGraphQueryTools(server);
registerAgentTools(server);
registerProjectTools(server);
registerBulkTools(server);
registerLockTools(server);
registerFocusTools(server);
registerHookTools(server);
registerSynthesisTools(server);
registerAutoMemoryTools(server);
registerSessionTools(server);
registerUtilityTools(server);
registerSystemTools(server);

// ============================================================================
// Resources
// ============================================================================

server.resource(
  "memories",
  "mementos://memories",
  { description: "All active memories", mimeType: "application/json" },
  async () => {
    const memories = listMemories({ status: "active", limit: 1000 });
    return { contents: [{ uri: "mementos://memories", text: JSON.stringify(memories, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "agents",
  "mementos://agents",
  { description: "All registered agents", mimeType: "application/json" },
  async () => {
    const agents = listAgents();
    return { contents: [{ uri: "mementos://agents", text: JSON.stringify(agents, null, 2), mimeType: "application/json" }] };
  }
);

server.resource(
  "projects",
  "mementos://projects",
  { description: "All registered projects", mimeType: "application/json" },
  async () => {
    const projects = listProjects();
    return { contents: [{ uri: "mementos://projects", text: JSON.stringify(projects, null, 2), mimeType: "application/json" }] };
  }
);

// ============================================================================
// Start server
// ============================================================================

async function ensureRestServerRunning(): Promise<void> {
  // Check if server is already up
  try {
    const res = await fetch("http://127.0.0.1:19428/api/memories?limit=0", {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok || res.status === 200) return; // already running
  } catch {
    // Not running — spawn it
  }

  // Spawn mementos-serve as a detached background process
  const proc = Bun.spawn(["mementos-serve"], {
    detached: true,
    stdout: Bun.file("/tmp/mementos.log"),
    stderr: Bun.file("/tmp/mementos.log"),
  });
  proc.unref(); // Don't wait for it

  // Wait up to 3 seconds for it to start
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch("http://127.0.0.1:19428/api/memories?limit=0", {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok || res.status === 200) return;
    } catch {
      // Still starting
    }
  }
  // If it didn't start, continue anyway — tools will return errors gracefully
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  if (hasFlag("--version", "-V")) {
    process.stdout.write(`${_pkg.version}\n`);
    return;
  }

  await ensureRestServerRunning();

  // Load persisted webhooks into the in-memory registry
  loadWebhooksFromDb();

  const transport = new StdioServerTransport();
  registerCloudTools(server, "mementos");
  await server.connect(transport);

  // Start auto-inject orchestrator if enabled (non-blocking)
  const autoProject = detectProject();
  void startAutoInject({
    server,
    project_id: autoProject?.id,
    project_name: autoProject?.name,
    cwd: process.cwd(),
  }).catch(() => { /* non-critical — auto-inject is best-effort */ });

  // Clean up auto-inject on process exit
  process.on("SIGINT", () => { stopAutoInject(); process.exit(0); });
  process.on("SIGTERM", () => { stopAutoInject(); process.exit(0); });
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
