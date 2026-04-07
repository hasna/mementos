import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createMemory, getMemory } from "../../db/memories.js";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { saveToolEvent } from "../../db/tool-events.js";
import { detectProject } from "../../lib/project-detect.js";
import type { Memory, CreateMemoryInput } from "../../types/index.js";

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function resolveId(partialId: string, table = "memories"): string {
  const db = getDatabase();
  const id = resolvePartialId(db, table, partialId);
  if (!id) throw new Error(`Could not resolve ID: ${partialId}`);
  return id;
}

let autoProjectInitialized = false;

export function ensureAutoProject(): void {
  if (autoProjectInitialized) return;
  autoProjectInitialized = true;
  try {
    detectProject();
  } catch {
  }
}

export type SystemToolDeps = {
  server: McpServer;
  z: typeof z;
  createMemory: typeof createMemory;
  getMemory: typeof getMemory;
  getDatabase: typeof getDatabase;
  saveToolEvent: typeof saveToolEvent;
  formatError: typeof formatError;
  resolveId: typeof resolveId;
  ensureAutoProject: typeof ensureAutoProject;
};

export function getSystemToolDeps(server: McpServer): SystemToolDeps {
  return {
    server,
    z,
    createMemory,
    getMemory,
    getDatabase,
    saveToolEvent,
    formatError,
    resolveId,
    ensureAutoProject,
  };
}

export type { Memory, CreateMemoryInput };
