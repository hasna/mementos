import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getSafeStorageConfigSummary,
  getStorageConfig,
  getStorageStatus,
} from "../../storage.js";
import { saveFeedback } from "../../db/feedback.js";
import { getPgMigrationDiagnostics } from "../../db/pg-migrate.js";
import { getStorageSyncStatus, pullStorageChanges, pushStorageChanges } from "../../lib/storage-sync.js";

function parseTables(raw?: string): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  const tables = raw
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
  return tables.length > 0 ? tables : undefined;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorText(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function registerMementosStorageTools(server: McpServer): void {
  server.tool(
    "mementos_storage_status",
    "Show mementos local database and remote storage sync status",
    {},
    async () => {
      try {
        const config = getStorageConfig();
        return text({
          status: getStorageSyncStatus(),
          runtime: getStorageStatus(),
          config: getSafeStorageConfigSummary(config),
        });
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "mementos_storage_push",
    "Push local mementos data to remote PostgreSQL storage",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        return text(pushStorageChanges({ tables: parseTables(tables) }));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "mementos_storage_pull",
    "Pull remote PostgreSQL storage data into the local mementos database",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        return text(pullStorageChanges({ tables: parseTables(tables) }));
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "mementos_storage_sync",
    "Push local changes, then pull remote changes",
    {
      tables: z.string().optional().describe("Comma-separated table names"),
    },
    async ({ tables }) => {
      try {
        const parsedTables = parseTables(tables);
        return text({
          push: pushStorageChanges({ tables: parsedTables }),
          pull: pullStorageChanges({ tables: parsedTables }),
        });
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "mementos_storage_migrate_dry_run",
    "Return safe PostgreSQL/RDS migration diagnostics without connecting or mutating remote storage",
    {
      connection_string: z.string().optional().describe("PostgreSQL connection string (overrides storage config)"),
    },
    async ({ connection_string }) => {
      try {
        const diagnostics = getPgMigrationDiagnostics(connection_string);
        return {
          ...text(diagnostics),
          isError: !diagnostics.ok,
        };
      } catch (error) {
        return errorText(error);
      }
    }
  );

  server.tool(
    "mementos_storage_feedback",
    "Save feedback for mementos",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async ({ message, email, category }) => {
      try {
        saveFeedback({
          message,
          email: email || null,
          category: category || "general",
          version: "mementos",
        });
        return text({ saved: true });
      } catch (error) {
        return errorText(error);
      }
    }
  );
}
