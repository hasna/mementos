/**
 * Memory tools have been split into separate modules:
 * - memory-crud.ts: memory_save, memory_recall, memory_get, memory_list, memory_update
 * - memory-history.ts: memory_versions, memory_diff, memory_chain_get
 * - memory-health.ts: memory_health
 * - memory-validation.ts: memory_check_contradiction, memory_invalidate
 *
 * This stub remains for backwards compatibility with any code that imports from this module.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Re-export utilities for backwards compatibility
export { ensureAutoProject, formatError, resolveId, formatMemory, formatAsmrResult } from "./memory-utils.js";

/**
 * @deprecated Use registerMemoryCrudTools, registerMemoryHistoryTools,
 *   registerMemoryHealthTools, and registerMemoryValidationTools instead.
 */
export function registerMemoryTools(_server: McpServer): void {
  // All tools have been moved to separate modules:
  // - registerMemoryCrudTools (memory-crud.ts)
  // - registerMemoryHistoryTools (memory-history.ts)
  // - registerMemoryHealthTools (memory-health.ts)
  // - registerMemoryValidationTools (memory-validation.ts)
  // This stub exists for backwards compatibility only.
}
