// @hasna/mementos — Universal memory system for AI agents

// Types
export type {
  Memory,
  MemoryWithRelations,
  MemoryScope,
  MemoryCategory,
  MemorySource,
  MemoryStatus,
  MemoryFilter,
  MemorySearchResult,
  MemoryStats,
  CreateMemoryInput,
  UpdateMemoryInput,
  DedupeMode,
  Agent,
  Project,
  MementosConfig,
  SyncDirection,
  SyncOptions,
  SyncResult,
  ConflictResolution,
} from "./types/index.js";

// Errors
export {
  MemoryNotFoundError,
  DuplicateMemoryError,
  MemoryExpiredError,
  InvalidScopeError,
  VersionConflictError,
} from "./types/index.js";

// Database
export {
  getDatabase,
  closeDatabase,
  resetDatabase,
  getDbPath,
  resolvePartialId,
  now,
  uuid,
  shortUuid,
} from "./db/database.js";

// Memory CRUD
export {
  createMemory,
  getMemory,
  getMemoryByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  cleanExpiredMemories,
} from "./db/memories.js";

// Agents
export {
  registerAgent,
  getAgent,
  listAgents,
  updateAgent,
} from "./db/agents.js";

// Projects
export {
  registerProject,
  getProject,
  listProjects,
} from "./db/projects.js";

// Search
export { searchMemories } from "./lib/search.js";

// Config
export { loadConfig, DEFAULT_CONFIG } from "./lib/config.js";

// Injector
export { MemoryInjector } from "./lib/injector.js";
export type { InjectionOptions } from "./lib/injector.js";

// Retention
export { enforceQuotas, archiveStale, runCleanup } from "./lib/retention.js";

// Sync
export { syncMemories, defaultSyncAgents } from "./lib/sync.js";
