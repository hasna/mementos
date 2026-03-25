// ============================================================================
// GitHub connector — syncs issues, PRs, discussions into memories
// ============================================================================

import { SqliteAdapter as Database } from "@hasna/cloud";
import { createMemory } from "../../db/memories.js";
import { getMemoryByKey } from "../../db/memories.js";
import type { ConnectorSyncResult, GitHubConnectorConfig } from "./types.js";

interface GitHubItem {
  number: number;
  title: string;
  body?: string;
  user?: { login: string };
  html_url?: string;
  state?: string;
  labels?: Array<{ name: string }>;
  created_at?: string;
  updated_at?: string;
}

/**
 * Run a connectors CLI command and parse the JSON output.
 * Falls back to an empty array on failure.
 */
async function runConnectorsCli(args: string[]): Promise<unknown[]> {
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
 * Build a memory key for a GitHub item.
 */
function itemKey(repo: string, type: string, number: number): string {
  return `github:${type}:${repo}:${number}`;
}

/**
 * Sync GitHub issues, PRs, and/or discussions into mementos memories.
 */
export async function syncGithub(
  db: Database,
  projectId: string,
  config: GitHubConnectorConfig,
): Promise<ConnectorSyncResult> {
  const start = performance.now();
  const repoSlug = `${config.owner}/${config.repo}`;
  const types = config.types ?? ["issues", "prs", "discussions"];
  const result: ConnectorSyncResult = {
    memories_created: 0,
    memories_updated: 0,
    errors: [],
    duration_ms: 0,
  };

  for (const itemType of types) {
    try {
      const cliType = itemType === "prs" ? "pulls" : itemType;
      const items = (await runConnectorsCli([
        "run", "github", cliType, "list",
        "--repo", repoSlug,
        "--json",
      ])) as GitHubItem[];

      for (const item of items) {
        try {
          const key = itemKey(repoSlug, itemType === "prs" ? "pr" : itemType === "discussions" ? "discussion" : "issue", item.number);
          const value = [
            `# ${item.title}`,
            "",
            item.body || "(no description)",
          ].join("\n");

          const labels = item.labels?.map((l) => l.name) ?? [];
          const tags = ["github", itemType === "prs" ? "pr" : itemType === "discussions" ? "discussion" : "issue", config.repo, ...labels];
          const metadata: Record<string, unknown> = {
            repo: repoSlug,
            number: item.number,
            author: item.user?.login,
            url: item.html_url,
            state: item.state,
            github_created_at: item.created_at,
            github_updated_at: item.updated_at,
          };

          // Check if memory already exists
          const existing = getMemoryByKey(key, "shared", undefined, projectId, undefined, db);

          if (existing) {
            // Skip if content hasn't changed
            if (existing.value === value) continue;

            // Update existing memory
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
            // Create new memory
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
        } catch (itemErr) {
          result.errors.push(
            `Failed to sync ${itemType} #${item.number}: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
          );
        }
      }
    } catch (typeErr) {
      result.errors.push(
        `Failed to fetch ${itemType} from ${repoSlug}: ${typeErr instanceof Error ? typeErr.message : String(typeErr)}`,
      );
    }
  }

  result.duration_ms = Math.round(performance.now() - start);
  return result;
}
