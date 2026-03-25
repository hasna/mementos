// ============================================================================
// Files connector — watches local directories and syncs file content to memories
// ============================================================================

import { SqliteAdapter as Database } from "@hasna/cloud";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import { createMemory } from "../../db/memories.js";
import { getMemoryByKey } from "../../db/memories.js";
import type { ConnectorSyncResult, FilesConnectorConfig } from "./types.js";

/** Maximum file content size to store in a memory (10 KB). */
const MAX_FILE_SIZE = 10 * 1024;

/**
 * Recursively collect all files under `dir` that match the allowed extensions.
 */
function collectFiles(dir: string, extensions: Set<string> | null): string[] {
  const results: string[] = [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Directory unreadable — skip silently
    return results;
  }

  for (const name of names) {
    // Skip hidden files/directories and common noise
    if (name.startsWith(".") || name === "node_modules") continue;

    const fullPath = join(dir, name);

    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      results.push(...collectFiles(fullPath, extensions));
    } else if (stat.isFile()) {
      const ext = extname(name).toLowerCase().replace(".", "");
      if (extensions === null || extensions.has(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/**
 * Sync local files from configured paths into mementos memories.
 * Tracks file mtime — only re-syncs when the file has been modified.
 */
export async function syncFiles(
  db: Database,
  projectId: string,
  config: FilesConnectorConfig,
): Promise<ConnectorSyncResult> {
  const start = performance.now();
  const result: ConnectorSyncResult = {
    memories_created: 0,
    memories_updated: 0,
    errors: [],
    duration_ms: 0,
  };

  const extensions = config.extensions
    ? new Set(config.extensions.map((e) => e.toLowerCase().replace(".", "")))
    : null;

  for (const basePath of config.paths) {
    const resolvedBase = resolve(basePath);

    let files: string[];
    try {
      files = collectFiles(resolvedBase, extensions);
    } catch (err) {
      result.errors.push(
        `Failed to scan ${basePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const filePath of files) {
      try {
        const relativePath = relative(resolvedBase, filePath);
        const key = `file:${relativePath}`;
        const ext = extname(filePath).toLowerCase().replace(".", "");

        // Get file mtime for change detection
        const stat = statSync(filePath);
        const mtime = stat.mtime.toISOString();

        // Check if memory already exists
        const existing = getMemoryByKey(key, "shared", undefined, projectId, undefined, db);

        if (existing) {
          // Skip if file hasn't been modified since last sync
          const lastMtime = (existing.metadata as Record<string, unknown>)?.file_mtime as string | undefined;
          if (lastMtime === mtime) continue;
        }

        // Read file content (truncate to MAX_FILE_SIZE)
        const raw = readFileSync(filePath, "utf-8");
        const value = raw.length > MAX_FILE_SIZE
          ? raw.slice(0, MAX_FILE_SIZE) + "\n\n... (truncated)"
          : raw;

        const tags = ["file", ext].filter(Boolean);
        const metadata: Record<string, unknown> = {
          file_path: filePath,
          relative_path: relativePath,
          file_mtime: mtime,
          file_size: stat.size,
          extension: ext,
        };

        if (existing) {
          const updateStmt = db.query(
            `UPDATE memories SET value = ?, tags = ?, metadata = ?, updated_at = datetime('now'), version = version + 1
             WHERE id = ?`,
          );
          updateStmt.run(
            value,
            JSON.stringify(tags),
            JSON.stringify(metadata),
            existing.id,
          );
          result.memories_updated++;
        } else {
          createMemory(
            {
              key,
              value,
              category: "knowledge",
              scope: "shared",
              source: "imported",
              project_id: projectId,
              tags,
              metadata,
            },
            "merge",
            db,
          );
          result.memories_created++;
        }
      } catch (fileErr) {
        result.errors.push(
          `Failed to sync ${filePath}: ${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
        );
      }
    }
  }

  result.duration_ms = Math.round(performance.now() - start);
  return result;
}
