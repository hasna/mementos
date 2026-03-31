import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  acquireMemoryWriteLock,
  releaseMemoryWriteLock,
  checkMemoryWriteLock,
} from "../../lib/memory-lock.js";
import { acquireLock, releaseLock, checkLock, listAgentLocks, cleanExpiredLocksWithInfo } from "../../db/locks.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerLockTools(server: McpServer): void {
  server.tool(
    "memory_lock",
    "Acquire an exclusive write lock on a memory key to prevent concurrent writes.",
    {
      agent_id: z.string(),
      key: z.string(),
      scope: z.string().optional().default("shared"),
      project_id: z.string().optional(),
      ttl_seconds: z.number().optional().default(30),
    },
    async (args) => {
      const lock = acquireMemoryWriteLock(args.agent_id, args.key, args.scope, args.project_id, args.ttl_seconds);
      if (!lock) {
        const existing = checkMemoryWriteLock(args.key, args.scope, args.project_id);
        return {
          content: [{
            type: "text" as const,
            text: `Lock conflict: memory key "${args.key}" is write-locked by agent ${existing?.agent_id ?? "unknown"} (expires ${existing?.expires_at ?? "unknown"}). Retry after a few seconds.`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: `Lock acquired: ${lock.id} on key "${args.key}" (expires ${lock.expires_at})`,
        }],
      };
    }
  );

  server.tool(
    "memory_unlock",
    "Release a memory write lock.",
    {
      lock_id: z.string(),
      agent_id: z.string(),
    },
    async (args) => {
      const released = releaseMemoryWriteLock(args.lock_id, args.agent_id);
      return {
        content: [{
          type: "text" as const,
          text: released ? `Lock ${args.lock_id} released.` : `Lock ${args.lock_id} not found or not owned by ${args.agent_id}.`,
        }],
      };
    }
  );

  server.tool(
    "memory_check_lock",
    "Check if a memory key is currently write-locked.",
    {
      key: z.string(),
      scope: z.string().optional().default("shared"),
      project_id: z.string().optional(),
    },
    async (args) => {
      const lock = checkMemoryWriteLock(args.key, args.scope, args.project_id);
      return {
        content: [{
          type: "text" as const,
          text: lock
            ? `Locked: key "${args.key}" held by agent ${lock.agent_id} (expires ${lock.expires_at})`
            : `Unlocked: key "${args.key}" is free to write.`,
        }],
      };
    }
  );

  server.tool(
    "resource_lock",
    "Acquire a lock on any resource (project, memory, entity, agent, connector).",
    {
      agent_id: z.string(),
      resource_type: z.enum(["project", "memory", "entity", "agent", "connector", "file"]),
      resource_id: z.string(),
      lock_type: z.enum(["advisory", "exclusive"]).optional().default("exclusive"),
      ttl_seconds: z.number().optional().default(300),
    },
    async (args) => {
      const lock = acquireLock(args.agent_id, args.resource_type, args.resource_id, args.lock_type, args.ttl_seconds);
      if (!lock) {
        return {
          content: [{ type: "text" as const, text: `Lock conflict on ${args.resource_type}:${args.resource_id}. Another agent holds an exclusive lock.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `Lock acquired: ${lock.id} (expires ${lock.expires_at})` }],
      };
    }
  );

  server.tool(
    "resource_unlock",
    "Release a resource lock.",
    {
      lock_id: z.string(),
      agent_id: z.string(),
    },
    async (args) => {
      const released = releaseLock(args.lock_id, args.agent_id);
      return {
        content: [{ type: "text" as const, text: released ? `Released.` : `Not found or not owned.` }],
      };
    }
  );

  server.tool(
    "resource_check_lock",
    "Check active locks on a resource.",
    {
      resource_type: z.enum(["project", "memory", "entity", "agent", "connector", "file"]),
      resource_id: z.string(),
      lock_type: z.enum(["advisory", "exclusive"]).optional(),
    },
    async (args) => {
      const locks = checkLock(args.resource_type, args.resource_id, args.lock_type);
      return {
        content: [{ type: "text" as const, text: locks.length === 0 ? "No active locks." : JSON.stringify(locks, null, 2) }],
      };
    }
  );

  server.tool(
    "list_agent_locks",
    "List all active resource locks held by an agent.",
    { agent_id: z.string() },
    async (args) => {
      const locks = listAgentLocks(args.agent_id);
      return {
        content: [{ type: "text" as const, text: locks.length === 0 ? "No active locks." : JSON.stringify(locks, null, 2) }],
      };
    }
  );

  server.tool(
    "clean_expired_locks",
    "Delete all expired resource locks. Notifies holding agents via conversations DM.",
    {},
    async () => {
      const expired = cleanExpiredLocksWithInfo();
      const count = expired.length;

      // Notify agents whose locks expired via conversations API (non-blocking)
      if (count > 0) {
        const conversationsUrl = process.env.CONVERSATIONS_API_URL || 'http://localhost:7020';
        for (const lock of expired) {
          const msg = `Your ${lock.lock_type} lock on ${lock.resource_type}/${lock.resource_id} has expired. Another agent may now acquire it.`;
          fetch(`${conversationsUrl}/api/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: 'system', to: lock.agent_id, content: msg }),
            signal: AbortSignal.timeout(2000),
          }).catch(() => {/* non-blocking */});
        }
      }

      return { content: [{ type: "text" as const, text: `Cleaned ${count} expired lock(s)${count > 0 ? ` and notified ${count} agent(s)` : ''}.` }] };
    }
  );
}
