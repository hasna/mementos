#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { listMemories } from "../db/memories.js";
import { listAgents } from "../db/agents.js";
import { listProjects } from "../db/projects.js";
import { getDatabase } from "../db/database.js";
import { getPrimaryMachineStartupWarning } from "../db/machines.js";
import { detectProject } from "../lib/project-detect.js";
import { loadWebhooksFromDb } from "../lib/built-in-hooks.js";
import { startAutoInject, stopAutoInject } from "../lib/auto-inject-orchestrator.js";

import { registerMemoryCrudTools } from "./tools/memory-crud.js";
import { registerMemoryHistoryTools } from "./tools/memory-history.js";
import { registerMemoryHealthTools } from "./tools/memory-health.js";
import { registerMemoryValidationTools } from "./tools/memory-validation.js";
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
import { isStdioMode, resolveMcpHttpPort, startMcpHttpServer } from "./http.js";

// Read version from package.json — never hardcode
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

/** Exported so other modules can push channel notifications via the underlying Server. */
export let mcpServer: McpServer | null = null;

function hasFlag(...flags: string[]): boolean {
  return process.argv.some((arg) => flags.includes(arg));
}

function printHelp(): void {
  process.stdout.write(
    `Usage: mementos-mcp [options]

Mementos MCP server (stdio transport by default)

Options:
  --http           Serve MCP over Streamable HTTP (127.0.0.1)
  --port <number>  HTTP port (default: 8824, env: MCP_HTTP_PORT)
  -h, --help       Show help
  -V, --version    Show version
`
  );
}

export function buildServer(): McpServer {
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

  registerMemoryCrudTools(server);
  registerMemoryHistoryTools(server);
  registerMemoryHealthTools(server);
  registerMemoryValidationTools(server);
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

  registerCloudTools(server, "mementos");
  mcpServer = server;
  return server;
}

async function ensureRestServerRunning(): Promise<void> {
  try {
    const res = await fetch("http://127.0.0.1:19428/api/memories?limit=0", {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok || res.status === 200) return;
  } catch {
    // Not running — spawn it
  }

  const proc = Bun.spawn(["mementos-serve"], {
    detached: true,
    stdout: Bun.file("/tmp/mementos.log"),
    stderr: Bun.file("/tmp/mementos.log"),
  });
  proc.unref();

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
}

async function prepareMcpRuntime(): Promise<void> {
  try {
    const warning = getPrimaryMachineStartupWarning(getDatabase());
    if (warning) {
      console.warn(`[mementos-mcp] ${warning}`);
    }
  } catch {
    // Best-effort warning only — startup should continue.
  }

  await ensureRestServerRunning();
  loadWebhooksFromDb();
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

  await prepareMcpRuntime();

  if (isStdioMode()) {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);

    const autoProject = detectProject();
    void startAutoInject({
      server,
      project_id: autoProject?.id,
      project_name: autoProject?.name,
      cwd: process.cwd(),
    }).catch(() => { /* non-critical — auto-inject is best-effort */ });

    process.on("SIGINT", () => { stopAutoInject(); process.exit(0); });
    process.on("SIGTERM", () => { stopAutoInject(); process.exit(0); });
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const handle = await startMcpHttpServer(buildServer, {
    port: resolveMcpHttpPort(),
  });
  process.on("SIGINT", () => { void handle.close().finally(() => process.exit(0)); });
  process.on("SIGTERM", () => { void handle.close().finally(() => process.exit(0)); });
}

main().catch((error) => {
  console.error("MCP server error:", error);
  process.exit(1);
});
