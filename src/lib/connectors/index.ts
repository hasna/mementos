// ============================================================================
// Connectors — barrel export and dispatcher
// ============================================================================

import { SqliteAdapter as Database } from "@hasna/cloud";
import type {
  ConnectorConfig,
  ConnectorSyncResult,
  GitHubConnectorConfig,
  NotionConnectorConfig,
  FilesConnectorConfig,
} from "./types.js";
import { syncGithub } from "./github.js";
import { syncNotion } from "./notion.js";
import { syncFiles } from "./files.js";

export type {
  ConnectorConfig,
  ConnectorSyncResult,
  ConnectorType,
  GitHubConnectorConfig,
  NotionConnectorConfig,
  FilesConnectorConfig,
} from "./types.js";

export { syncGithub } from "./github.js";
export { syncNotion } from "./notion.js";
export { syncFiles } from "./files.js";

/**
 * Dispatch a sync operation to the correct connector based on config.type.
 * Returns a ConnectorSyncResult with counts and any errors encountered.
 */
export async function syncConnector(
  db: Database,
  projectId: string,
  config: ConnectorConfig,
): Promise<ConnectorSyncResult> {
  if (!config.enabled) {
    return {
      memories_created: 0,
      memories_updated: 0,
      errors: ["Connector is disabled"],
      duration_ms: 0,
    };
  }

  switch (config.type) {
    case "github":
      return syncGithub(db, projectId, config.config as unknown as GitHubConnectorConfig);

    case "notion":
      return syncNotion(db, projectId, config.config as NotionConnectorConfig);

    case "files":
      return syncFiles(db, projectId, config.config as unknown as FilesConnectorConfig);

    default:
      return {
        memories_created: 0,
        memories_updated: 0,
        errors: [`Unknown connector type: ${(config as ConnectorConfig).type}`],
        duration_ms: 0,
      };
  }
}
