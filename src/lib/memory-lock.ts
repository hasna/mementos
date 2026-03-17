/**
 * OPE4-00111: Concurrent memory access coordination
 *
 * Uses the resource_locks table (Migration 8) to provide:
 * - Advisory locks for read-heavy coordination
 * - Exclusive locks to prevent simultaneous writes to the same key
 *
 * Design:
 * - Reads: always parallel, no locking needed
 * - Writes: agents SHOULD acquire an exclusive lock on the memory key before writing
 *   The lock resource_id uses format: "{scope}:{key}:{agent_id}:{project_id}"
 *   This prevents two agents overwriting the same shared memory simultaneously
 * - Optimistic fallback: if lock can't be acquired, VersionConflictError from
 *   updateMemory() provides a second layer of protection
 */

import { Database } from "bun:sqlite";
import { acquireLock, releaseLock, checkLock, type ResourceLock } from "../db/locks.js";
import { getDatabase } from "../db/database.js";

const MEMORY_WRITE_TTL = 30; // 30 seconds — short TTL for write locks

/**
 * Compute the lock resource_id for a memory key.
 * Scoped by scope + key + project so different projects don't block each other.
 */
export function memoryLockId(
  key: string,
  scope: string,
  projectId?: string | null
): string {
  return `${scope}:${key}:${projectId ?? ""}`;
}

/**
 * Acquire an exclusive write lock on a memory key.
 * Returns the lock if acquired, null if another agent is writing.
 */
export function acquireMemoryWriteLock(
  agentId: string,
  key: string,
  scope: string,
  projectId?: string | null,
  ttlSeconds = MEMORY_WRITE_TTL,
  db?: Database
): ResourceLock | null {
  const d = db || getDatabase();
  return acquireLock(agentId, "memory", memoryLockId(key, scope, projectId), "exclusive", ttlSeconds, d);
}

/**
 * Release a memory write lock.
 */
export function releaseMemoryWriteLock(
  lockId: string,
  agentId: string,
  db?: Database
): boolean {
  const d = db || getDatabase();
  return releaseLock(lockId, agentId, d);
}

/**
 * Check if a memory key is currently write-locked.
 * Returns the active lock or null.
 */
export function checkMemoryWriteLock(
  key: string,
  scope: string,
  projectId?: string | null,
  db?: Database
): ResourceLock | null {
  const d = db || getDatabase();
  const locks = checkLock("memory", memoryLockId(key, scope, projectId), "exclusive", d);
  return locks[0] ?? null;
}

/**
 * Execute a callback with an exclusive memory write lock.
 * Throws if the lock cannot be acquired (another agent is writing).
 * Automatically releases the lock after the callback completes.
 *
 * Usage:
 *   withMemoryLock(agentId, "my-key", "shared", projectId, () => {
 *     createMemory({ key: "my-key", ... });
 *   });
 */
export function withMemoryLock<T>(
  agentId: string,
  key: string,
  scope: string,
  projectId: string | null | undefined,
  fn: () => T,
  ttlSeconds = MEMORY_WRITE_TTL,
  db?: Database
): T {
  const d = db || getDatabase();
  const lock = acquireMemoryWriteLock(agentId, key, scope, projectId, ttlSeconds, d);

  if (!lock) {
    const existing = checkMemoryWriteLock(key, scope, projectId, d);
    throw new MemoryLockConflictError(key, scope, existing?.agent_id ?? "unknown");
  }

  try {
    return fn();
  } finally {
    releaseLock(lock.id, agentId, d);
  }
}

/**
 * Error thrown when a memory write lock cannot be acquired.
 */
export class MemoryLockConflictError extends Error {
  public readonly conflict = true as const;
  public readonly key: string;
  public readonly scope: string;
  public readonly blocking_agent_id: string;

  constructor(key: string, scope: string, blockingAgentId: string) {
    super(
      `Memory key "${key}" (scope: ${scope}) is currently write-locked by agent ${blockingAgentId}. ` +
      "Retry after a few seconds or use optimistic locking (version field)."
    );
    this.name = "MemoryLockConflictError";
    this.key = key;
    this.scope = scope;
    this.blocking_agent_id = blockingAgentId;
  }
}
