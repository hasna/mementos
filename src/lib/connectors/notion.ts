// ============================================================================
// Notion connector — syncs pages into memories
// ============================================================================

import { Database } from "bun:sqlite";
import { createMemory } from "../../db/memories.js";
import { getMemoryByKey } from "../../db/memories.js";
import type { ConnectorSyncResult, NotionConnectorConfig } from "./types.js";

interface NotionPage {
  id: string;
  title?: string;
  content?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
}

/**
 * Run a connectors CLI command and parse the JSON output.
 */
async function runConnectorsCli(args: string[]): Promise<unknown> {
  try {
    const proc = Bun.spawn(["connectors", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`connectors CLI exited ${exitCode}: ${stderr.trim()}`);
    }
    return JSON.parse(output.trim());
  } catch (err) {
    throw new Error(`Failed to run connectors CLI: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Sync Notion pages into mementos memories.
 */
export async function syncNotion(
  db: Database,
  projectId: string,
  config: NotionConnectorConfig,
): Promise<ConnectorSyncResult> {
  const start = performance.now();
  const result: ConnectorSyncResult = {
    memories_created: 0,
    memories_updated: 0,
    errors: [],
    duration_ms: 0,
  };

  const pages: NotionPage[] = [];

  try {
    // Fetch pages from a database if configured
    if (config.database_id) {
      const dbPages = (await runConnectorsCli([
        "run", "notion", "pages", "list",
        "--database", config.database_id,
        "--json",
      ])) as NotionPage[];
      pages.push(...dbPages);
    }

    // Fetch individual pages by ID
    if (config.page_ids?.length) {
      for (const pageId of config.page_ids) {
        try {
          const page = (await runConnectorsCli([
            "run", "notion", "pages", "get", pageId,
            "--json",
          ])) as NotionPage;
          pages.push(page);
        } catch (err) {
          result.errors.push(
            `Failed to fetch page ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  } catch (err) {
    result.errors.push(
      `Failed to list Notion pages: ${err instanceof Error ? err.message : String(err)}`,
    );
    result.duration_ms = Math.round(performance.now() - start);
    return result;
  }

  for (const page of pages) {
    try {
      const key = `notion:page:${page.id}`;
      const title = page.title || "Untitled";
      const value = [
        `# ${title}`,
        "",
        page.content || "(empty page)",
      ].join("\n");

      const tags = ["notion", "page"];
      const metadata: Record<string, unknown> = {
        notion_id: page.id,
        url: page.url,
        notion_created_at: page.created_time,
        notion_updated_at: page.last_edited_time,
        properties: page.properties,
      };

      // Check if memory already exists
      const existing = getMemoryByKey(key, "shared", undefined, projectId, undefined, db);

      if (existing) {
        if (existing.value === value) continue;

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
    } catch (pageErr) {
      result.errors.push(
        `Failed to sync page ${page.id}: ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`,
      );
    }
  }

  result.duration_ms = Math.round(performance.now() - start);
  return result;
}
