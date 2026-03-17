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
  // Knowledge Graph types
  Entity,
  Relation,
  EntityMemory,
  EntityType,
  RelationType,
  EntityRole,
  EntityWithRelations,
  CreateEntityInput,
  UpdateEntityInput,
  CreateRelationInput,
} from "./types/index.js";

// Errors
export {
  MemoryNotFoundError,
  DuplicateMemoryError,
  MemoryExpiredError,
  InvalidScopeError,
  VersionConflictError,
  EntityNotFoundError,
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
  getMemoriesByKey,
  listMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  touchMemory,
  cleanExpiredMemories,
  getMemoryVersions,
} from "./db/memories.js";

// Agents
export {
  registerAgent,
  getAgent,
  listAgents,
  listAgentsByProject,
  updateAgent,
  touchAgent,
} from "./db/agents.js";

// Resource locks
export {
  acquireLock,
  releaseLock,
  releaseResourceLocks,
  releaseAllAgentLocks,
  checkLock,
  agentHoldsLock,
  listAgentLocks,
  cleanExpiredLocks,
} from "./db/locks.js";
export type { ResourceLock, ResourceType, LockType } from "./db/locks.js";

// Projects
export {
  registerProject,
  getProject,
  listProjects,
} from "./db/projects.js";

// Search
export { searchMemories } from "./lib/search.js";

// Config
export {
  loadConfig,
  DEFAULT_CONFIG,
  getActiveProfile,
  setActiveProfile,
  listProfiles,
  deleteProfile,
} from "./lib/config.js";

// Injector
export { MemoryInjector } from "./lib/injector.js";
export type { InjectionOptions } from "./lib/injector.js";

// Retention
export { enforceQuotas, archiveStale, archiveUnused, deprioritizeStale, runCleanup } from "./lib/retention.js";

// Sync
export { syncMemories, defaultSyncAgents } from "./lib/sync.js";

// Redaction
export { redactSecrets, containsSecrets } from "./lib/redact.js";

// Knowledge Graph - Entities
export {
  createEntity,
  getEntity,
  getEntityByName,
  listEntities,
  updateEntity,
  deleteEntity,
  mergeEntities,
  parseEntityRow,
} from "./db/entities.js";

// Knowledge Graph - Relations
export {
  createRelation,
  getRelation,
  listRelations,
  deleteRelation,
  getRelatedEntities,
  getEntityGraph,
  findPath,
  parseRelationRow,
} from "./db/relations.js";

// Knowledge Graph - Entity-Memory Links
export {
  linkEntityToMemory,
  unlinkEntityFromMemory,
  getMemoriesForEntity,
  getEntitiesForMemory,
  bulkLinkEntities,
  getEntityMemoryLinks,
} from "./db/entity-memories.js";

// Knowledge Graph - Entity Extraction
export {
  extractEntities,
  type ExtractedEntity,
} from "./lib/extractor.js";
