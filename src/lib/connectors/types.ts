// ============================================================================
// Connector types — shared interfaces for all connector implementations
// ============================================================================

export type ConnectorType = "github" | "notion" | "files";

export interface ConnectorConfig {
  type: ConnectorType;
  enabled: boolean;
  config: Record<string, unknown>;
  last_sync?: string;
}

export interface ConnectorSyncResult {
  memories_created: number;
  memories_updated: number;
  errors: string[];
  duration_ms: number;
}

export interface GitHubConnectorConfig {
  owner: string;
  repo: string;
  types?: Array<"issues" | "prs" | "discussions">;
}

export interface NotionConnectorConfig {
  database_id?: string;
  page_ids?: string[];
}

export interface FilesConnectorConfig {
  paths: string[];
  extensions?: string[];
}
