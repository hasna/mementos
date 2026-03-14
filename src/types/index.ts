// ============================================================================
// Memory Scope — who can access the memory
// ============================================================================

export type MemoryScope = "global" | "shared" | "private";

// ============================================================================
// Memory Category — what kind of memory
// ============================================================================

export type MemoryCategory = "preference" | "fact" | "knowledge" | "history";

// ============================================================================
// Memory Source — how the memory was created
// ============================================================================

export type MemorySource = "user" | "agent" | "system" | "auto" | "imported";

// ============================================================================
// Memory Status
// ============================================================================

export type MemoryStatus = "active" | "archived" | "expired";

// ============================================================================
// Core Memory interface
// ============================================================================

export interface Memory {
  id: string;
  key: string;
  value: string;
  category: MemoryCategory;
  scope: MemoryScope;
  summary: string | null;
  tags: string[];
  importance: number; // 1-10
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
  access_count: number;
  version: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
}

// ============================================================================
// Memory with relations
// ============================================================================

export interface MemoryWithRelations extends Memory {
  agent: Agent | null;
  project: Project | null;
}

// ============================================================================
// Create / Update inputs
// ============================================================================

export interface CreateMemoryInput {
  key: string;
  value: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  summary?: string;
  tags?: string[];
  importance?: number;
  source?: MemorySource;
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
  expires_at?: string;
  ttl_ms?: number;
}

export interface UpdateMemoryInput {
  value?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  summary?: string | null;
  tags?: string[];
  importance?: number;
  pinned?: boolean;
  status?: MemoryStatus;
  metadata?: Record<string, unknown>;
  expires_at?: string | null;
  version: number; // required for optimistic locking
}

// ============================================================================
// Filter / Search
// ============================================================================

export interface MemoryFilter {
  scope?: MemoryScope | MemoryScope[];
  category?: MemoryCategory | MemoryCategory[];
  source?: MemorySource | MemorySource[];
  status?: MemoryStatus | MemoryStatus[];
  project_id?: string;
  agent_id?: string;
  session_id?: string;
  tags?: string[];
  min_importance?: number;
  pinned?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MemorySearchResult {
  memory: Memory;
  score: number;
  match_type: "exact" | "fuzzy" | "tag";
  highlights?: { field: string; snippet: string }[];
}

// ============================================================================
// Agent
// ============================================================================

export interface Agent {
  id: string; // 8-char UUID
  name: string;
  description: string | null;
  role: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen_at: string;
}

// ============================================================================
// Project
// ============================================================================

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  memory_prefix: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Stats
// ============================================================================

export interface MemoryStats {
  total: number;
  by_scope: Record<MemoryScope, number>;
  by_category: Record<MemoryCategory, number>;
  by_status: Record<MemoryStatus, number>;
  by_agent: Record<string, number>;
  pinned_count: number;
  expired_count: number;
}

// ============================================================================
// Config
// ============================================================================

export interface MementosConfig {
  default_scope: MemoryScope;
  default_category: MemoryCategory;
  default_importance: number;
  max_entries: number;
  max_entries_per_scope: Record<MemoryScope, number>;
  injection: {
    max_tokens: number;
    min_importance: number;
    categories: MemoryCategory[];
    refresh_interval: number;
  };
  extraction: {
    enabled: boolean;
    min_confidence: number;
  };
  sync_agents: string[];
  auto_cleanup: {
    enabled: boolean;
    expired_check_interval: number;
    unused_archive_days: number;
    stale_deprioritize_days: number;
  };
}

// ============================================================================
// Dedupe mode for upsert
// ============================================================================

export type DedupeMode = "merge" | "create";

// ============================================================================
// Sync
// ============================================================================

export type SyncDirection = "push" | "pull" | "both";

export type ConflictResolution = "prefer-local" | "prefer-remote" | "prefer-newer";

export interface SyncOptions {
  direction: SyncDirection;
  conflict_resolution?: ConflictResolution;
  agent_id?: string;
  project_id?: string;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
}

// ============================================================================
// Knowledge Graph types
// ============================================================================

export type EntityType = 'person' | 'project' | 'tool' | 'concept' | 'file' | 'api' | 'pattern' | 'organization';
export type RelationType = 'uses' | 'knows' | 'depends_on' | 'created_by' | 'related_to' | 'contradicts' | 'part_of' | 'implements';
export type EntityRole = 'subject' | 'object' | 'context';

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string | null;
  metadata: Record<string, unknown>;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Relation {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface EntityMemory {
  entity_id: string;
  memory_id: string;
  role: EntityRole;
  created_at: string;
}

export interface EntityWithRelations extends Entity {
  relations: Relation[];
  memories: Memory[];
}

export interface CreateEntityInput {
  name: string;
  type: EntityType;
  description?: string;
  metadata?: Record<string, unknown>;
  project_id?: string;
}

export interface UpdateEntityInput {
  name?: string;
  type?: EntityType;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateRelationInput {
  source_entity_id: string;
  target_entity_id: string;
  relation_type: RelationType;
  weight?: number;
  metadata?: Record<string, unknown>;
}

export class EntityNotFoundError extends Error {
  constructor(id: string) {
    super(`Entity not found: ${id}`);
    this.name = "EntityNotFoundError";
  }
}

// ============================================================================
// Custom Errors
// ============================================================================

// ============================================================================
// Memory Version (for diff/history tracking)
// ============================================================================

export interface MemoryVersion {
  id: string;
  memory_id: string;
  version: number;
  value: string;
  importance: number;
  scope: MemoryScope;
  category: MemoryCategory;
  tags: string[];
  summary: string | null;
  pinned: boolean;
  status: MemoryStatus;
  created_at: string;
}

// ============================================================================
// Custom Errors
// ============================================================================

export class MemoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Memory not found: ${id}`);
    this.name = "MemoryNotFoundError";
  }
}

export class DuplicateMemoryError extends Error {
  constructor(key: string, scope: MemoryScope) {
    super(`Memory already exists with key "${key}" in scope "${scope}"`);
    this.name = "DuplicateMemoryError";
  }
}

export class MemoryExpiredError extends Error {
  constructor(id: string) {
    super(`Memory has expired: ${id}`);
    this.name = "MemoryExpiredError";
  }
}

export class InvalidScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidScopeError";
  }
}

export class VersionConflictError extends Error {
  public expected: number;
  public actual: number;

  constructor(id: string, expected: number, actual: number) {
    super(
      `Version conflict for memory ${id}: expected ${expected}, got ${actual}`
    );
    this.name = "VersionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}
