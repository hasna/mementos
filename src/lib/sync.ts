import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConflictResolution,
  Memory,
  SyncDirection,
  SyncResult,
} from "../types/index.js";
import { createMemory, listMemories } from "../db/memories.js";

// ============================================================================
// Sync — export/import memories between agents via JSON files
// ============================================================================

function getAgentSyncDir(agentName: string): string {
  const dir = join(homedir(), ".mementos", "agents", agentName);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function setHighWaterMark(agentDir: string, timestamp: string): void {
  const markFile = join(agentDir, ".highwatermark");
  writeFileSync(markFile, timestamp, "utf-8");
}

function resolveConflict(
  local: Memory,
  remote: Memory,
  resolution: ConflictResolution
): "local" | "remote" {
  switch (resolution) {
    case "prefer-local":
      return "local";
    case "prefer-remote":
      return "remote";
    case "prefer-newer":
      return new Date(local.updated_at).getTime() >=
        new Date(remote.updated_at).getTime()
        ? "local"
        : "remote";
  }
}

// ============================================================================
// Push — export local memories to agent JSON file
// ============================================================================

function pushMemories(
  agentName: string,
  agentId?: string,
  projectId?: string,
  db?: Database
): number {
  const agentDir = getAgentSyncDir(agentName);
  const memories = listMemories(
    {
      agent_id: agentId,
      project_id: projectId,
      status: "active",
      limit: 10000,
    },
    db
  );

  const outFile = join(agentDir, "memories.json");
  writeFileSync(outFile, JSON.stringify(memories, null, 2), "utf-8");

  // Update high water mark
  if (memories.length > 0) {
    const latest = memories.reduce((a, b) =>
      new Date(a.updated_at).getTime() > new Date(b.updated_at).getTime()
        ? a
        : b
    );
    setHighWaterMark(agentDir, latest.updated_at);
  }

  return memories.length;
}

// ============================================================================
// Pull — import memories from agent JSON file
// ============================================================================

function pullMemories(
  agentName: string,
  conflictResolution: ConflictResolution = "prefer-newer",
  db?: Database
): { pulled: number; conflicts: number } {
  const agentDir = getAgentSyncDir(agentName);
  const inFile = join(agentDir, "memories.json");

  if (!existsSync(inFile)) {
    return { pulled: 0, conflicts: 0 };
  }

  const raw = readFileSync(inFile, "utf-8");
  let remoteMemories: Memory[];
  try {
    remoteMemories = JSON.parse(raw) as Memory[];
  } catch {
    return { pulled: 0, conflicts: 0 };
  }

  let pulled = 0;
  let conflicts = 0;

  for (const remote of remoteMemories) {
    // Check for local version
    const localMemories = listMemories(
      {
        search: remote.key,
        scope: remote.scope,
        agent_id: remote.agent_id || undefined,
        project_id: remote.project_id || undefined,
        limit: 1,
      },
      db
    );

    const local = localMemories.find((m) => m.key === remote.key);

    if (local) {
      const winner = resolveConflict(local, remote, conflictResolution);
      if (winner === "remote") {
        createMemory(
          {
            key: remote.key,
            value: remote.value,
            category: remote.category,
            scope: remote.scope,
            summary: remote.summary || undefined,
            tags: remote.tags,
            importance: remote.importance,
            source: remote.source,
            agent_id: remote.agent_id || undefined,
            project_id: remote.project_id || undefined,
            session_id: remote.session_id || undefined,
            metadata: remote.metadata,
            expires_at: remote.expires_at || undefined,
          },
          "merge",
          db
        );
        pulled++;
      }
      conflicts++;
    } else {
      createMemory(
        {
          key: remote.key,
          value: remote.value,
          category: remote.category,
          scope: remote.scope,
          summary: remote.summary || undefined,
          tags: remote.tags,
          importance: remote.importance,
          source: remote.source,
          agent_id: remote.agent_id || undefined,
          project_id: remote.project_id || undefined,
          session_id: remote.session_id || undefined,
          metadata: remote.metadata,
          expires_at: remote.expires_at || undefined,
        },
        "create",
        db
      );
      pulled++;
    }
  }

  return { pulled, conflicts };
}

// ============================================================================
// Public API
// ============================================================================

export function syncMemories(
  agentName: string,
  direction: SyncDirection = "both",
  options: {
    agent_id?: string;
    project_id?: string;
    conflict_resolution?: ConflictResolution;
    db?: Database;
  } = {}
): SyncResult {
  const result: SyncResult = {
    pushed: 0,
    pulled: 0,
    conflicts: 0,
    errors: [],
  };

  try {
    if (direction === "push" || direction === "both") {
      result.pushed = pushMemories(
        agentName,
        options.agent_id,
        options.project_id,
        options.db
      );
    }

    if (direction === "pull" || direction === "both") {
      const pullResult = pullMemories(
        agentName,
        options.conflict_resolution || "prefer-newer",
        options.db
      );
      result.pulled = pullResult.pulled;
      result.conflicts = pullResult.conflicts;
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e));
  }

  return result;
}

export const defaultSyncAgents = ["claude", "codex", "gemini"];
