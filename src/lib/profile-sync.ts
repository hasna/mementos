/**
 * Cross-profile memory sync.
 * Selectively copy memories between different mementos profiles/databases.
 */

import { SqliteAdapter as Database } from "@hasna/cloud";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createMemory, listMemories } from "../db/memories.js";
import type { MemoryFilter } from "../types/index.js";

export interface ProfileSyncOptions {
  filter?: MemoryFilter;
  strategy?: "skip" | "merge" | "overwrite"; // How to handle duplicates
}

export interface ProfileSyncResult {
  copied: number;
  skipped: number;
  source_profile: string;
  target_profile: string;
}

/**
 * Get the database path for a named profile.
 */
function getProfileDbPath(profile: string): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".hasna", "mementos", "profiles", `${profile}.db`);
}

/**
 * Sync memories from one profile to another.
 */
export function syncProfiles(
  sourceProfile: string,
  targetProfile: string,
  options: ProfileSyncOptions = {}
): ProfileSyncResult {
  const { filter, strategy = "skip" } = options;

  const sourcePath = getProfileDbPath(sourceProfile);
  const targetPath = getProfileDbPath(targetProfile);

  if (!existsSync(sourcePath)) {
    throw new Error(`Source profile "${sourceProfile}" not found at ${sourcePath}`);
  }
  if (!existsSync(targetPath)) {
    throw new Error(`Target profile "${targetProfile}" not found at ${targetPath}`);
  }

  const sourceDb = new Database(sourcePath, { readonly: true });
  const targetDb = new Database(targetPath, { create: true });

  try {
    const memories = listMemories(filter, sourceDb);
    let copied = 0;
    let skipped = 0;

    for (const memory of memories) {
      try {
        createMemory(
          {
            key: memory.key,
            value: memory.value,
            category: memory.category,
            scope: memory.scope,
            summary: memory.summary || undefined,
            tags: memory.tags,
            importance: memory.importance,
            source: "imported",
            agent_id: memory.agent_id || undefined,
            project_id: memory.project_id || undefined,
            metadata: memory.metadata,
          },
          strategy === "overwrite" ? "merge" : strategy === "skip" ? "error" : "merge",
          targetDb
        );
        copied++;
      } catch {
        skipped++;
      }
    }

    return { copied, skipped, source_profile: sourceProfile, target_profile: targetProfile };
  } finally {
    sourceDb.close();
    targetDb.close();
  }
}
