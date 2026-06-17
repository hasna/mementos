import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStorageConfig } from "../../storage.js";
import { getDatabase } from "../../db/database.js";
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
        return text({
          status: getStorageSyncStatus(),
          config: getStorageConfig(),
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
    "mementos_storage_feedback",
    "Save feedback for mementos",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async ({ message, email, category }) => {
      try {
        const db = getDatabase();
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          message,
          email || null,
          category || "general",
          "mementos"
        );
        return text({ saved: true });
      } catch (error) {
        return errorText(error);
      }
    }
  );
}
