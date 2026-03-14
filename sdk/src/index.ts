/**
 * @hasna/mementos-sdk — Zero-dependency TypeScript client for @hasna/mementos REST API.
 *
 * Works in Node.js, Bun, Deno, and browsers. No external dependencies beyond fetch.
 *
 * @example
 * ```ts
 * import { MementosClient } from "@hasna/mementos-sdk";
 * const client = new MementosClient({ baseUrl: "http://localhost:19428" });
 *
 * await client.saveMemory({ key: "my-key", value: "my value", category: "knowledge" });
 * const results = await client.searchMemories("my query");
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export type MemoryScope = "global" | "shared" | "private";
export type MemoryCategory = "preference" | "fact" | "knowledge" | "history";
export type MemorySource = "user" | "agent" | "system" | "auto" | "imported";
export type MemoryStatus = "active" | "archived" | "expired";
export type EntityType = "person" | "place" | "thing" | "concept" | "project" | "agent" | "file" | "url";
export type RelationType = "related_to" | "part_of" | "depends_on" | "created_by" | "used_by" | "similar_to" | "opposite_of";
export type EntityRole = "subject" | "object" | "context" | "author" | "target";

export interface Memory {
  id: string;
  key: string;
  value: string;
  category: MemoryCategory;
  scope: MemoryScope;
  summary: string | null;
  tags: string[];
  importance: number;
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

export interface Agent {
  id: string;
  name: string;
  role: string | null;
  description: string | null;
  active_project_id: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string | null;
  description: string | null;
  memory_prefix: string | null;
  created_at: string;
  updated_at: string;
}

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  description: string | null;
  aliases: string[];
  metadata: Record<string, unknown>;
  observation_count: number;
  created_at: string;
  updated_at: string;
}

export interface Relation {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: RelationType;
  strength: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

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
// Input types
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
  ttl?: string; // human readable: "1d", "2h30m"
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
  version: number;
}

export interface ListMemoriesFilter {
  scope?: MemoryScope;
  category?: MemoryCategory;
  tags?: string[];
  min_importance?: number;
  pinned?: boolean;
  agent_id?: string;
  project_id?: string;
  limit?: number;
  offset?: number;
  fields?: string[];
}

export interface SearchMemoriesInput {
  query: string;
  scope?: MemoryScope;
  category?: MemoryCategory;
  tags?: string[];
  limit?: number;
}

export interface ExportMemoriesInput {
  scope?: MemoryScope;
  category?: MemoryCategory;
  agent_id?: string;
  project_id?: string;
  tags?: string[];
  limit?: number;
}

export interface ImportMemoriesInput {
  memories: Partial<Memory>[];
  overwrite?: boolean;
}

export interface CreateEntityInput {
  name: string;
  type: EntityType;
  description?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateEntityInput {
  name?: string;
  description?: string | null;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface CreateRelationInput {
  from_entity_id: string;
  to_entity_id: string;
  relation_type: RelationType;
  strength?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Client config
// ============================================================================

export interface MementosClientConfig {
  /** Base URL of mementos-serve. Default: http://localhost:19428 */
  baseUrl?: string;
  /** Optional fetch override for testing. */
  fetch?: typeof globalThis.fetch;
}

// ============================================================================
// Error
// ============================================================================

export class MementosError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "MementosError";
  }
}

// ============================================================================
// Client
// ============================================================================

export class MementosClient {
  private baseUrl: string;
  private _fetch: typeof globalThis.fetch;

  constructor(config: MementosClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "http://localhost:19428").replace(/\/$/, "");
    this._fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>
  ): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const res = await this._fetch(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errBody: { error?: string; details?: unknown } = {};
      try { errBody = await res.json() as typeof errBody; } catch { /* ignore */ }
      throw new MementosError(errBody.error ?? `HTTP ${res.status}`, res.status, errBody.details);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // --------------------------------------------------------------------------
  // Memories
  // --------------------------------------------------------------------------

  /** List memories with optional filters. */
  async listMemories(filter: ListMemoriesFilter = {}): Promise<{ memories: Memory[]; count: number }> {
    const q: Record<string, string | number | boolean | undefined> = {};
    if (filter.scope) q["scope"] = filter.scope;
    if (filter.category) q["category"] = filter.category;
    if (filter.tags?.length) q["tags"] = filter.tags.join(",");
    if (filter.min_importance !== undefined) q["min_importance"] = filter.min_importance;
    if (filter.pinned !== undefined) q["pinned"] = filter.pinned;
    if (filter.agent_id) q["agent_id"] = filter.agent_id;
    if (filter.project_id) q["project_id"] = filter.project_id;
    if (filter.limit !== undefined) q["limit"] = filter.limit;
    if (filter.offset !== undefined) q["offset"] = filter.offset;
    if (filter.fields?.length) q["fields"] = filter.fields.join(",");
    return this.get("/api/memories", q);
  }

  /** Get memory stats. */
  getStats(): Promise<MemoryStats> {
    return this.get("/api/memories/stats");
  }

  /** Search memories by query string. */
  searchMemories(input: SearchMemoriesInput | string): Promise<{ results: Memory[]; count: number }> {
    const body = typeof input === "string" ? { query: input } : input;
    return this.post("/api/memories/search", body);
  }

  /** Export memories. */
  exportMemories(input: ExportMemoriesInput = {}): Promise<{ memories: Memory[]; count: number }> {
    return this.post("/api/memories/export", input);
  }

  /** Import memories. */
  importMemories(input: ImportMemoriesInput): Promise<{ imported: number; errors: string[]; total: number }> {
    return this.post("/api/memories/import", input);
  }

  /** Clean up expired memories. */
  cleanExpired(): Promise<{ cleaned: number }> {
    return this.post("/api/memories/clean");
  }

  /** Save (create) a memory. */
  saveMemory(input: CreateMemoryInput): Promise<Memory> {
    return this.post("/api/memories", input);
  }

  /** Get a memory by ID. */
  getMemory(id: string): Promise<Memory> {
    return this.get(`/api/memories/${id}`);
  }

  /** Update a memory (requires version for optimistic locking). */
  updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory> {
    return this.patch(`/api/memories/${id}`, input);
  }

  /** Delete a memory. */
  deleteMemory(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/memories/${id}`);
  }

  // --------------------------------------------------------------------------
  // Agents
  // --------------------------------------------------------------------------

  /** List all agents. */
  listAgents(): Promise<{ agents: Agent[] }> {
    return this.get("/api/agents");
  }

  /** Register an agent (idempotent by name). */
  registerAgent(input: { name: string; role?: string; description?: string }): Promise<Agent> {
    return this.post("/api/agents", input);
  }

  /** Get an agent by ID or name. */
  getAgent(idOrName: string): Promise<Agent> {
    return this.get(`/api/agents/${idOrName}`);
  }

  /** Update an agent (name, role, description, active_project_id). */
  updateAgent(idOrName: string, updates: { name?: string; role?: string; description?: string; metadata?: Record<string, unknown>; active_project_id?: string | null }): Promise<Agent> {
    return this.patch(`/api/agents/${idOrName}`, updates);
  }

  /** List agents currently active on a project. */
  listAgentsByProject(projectId: string): Promise<{ agents: Agent[]; count: number }> {
    return this.get(`/api/agents`, { project_id: projectId });
  }

  // --------------------------------------------------------------------------
  // Projects
  // --------------------------------------------------------------------------

  /** List all projects. */
  listProjects(): Promise<{ projects: Project[] }> {
    return this.get("/api/projects");
  }

  /** Register a project (idempotent by name). */
  registerProject(input: { name: string; path?: string; description?: string; memory_prefix?: string }): Promise<Project> {
    return this.post("/api/projects", input);
  }

  /** Get a project by ID, path, or name. */
  getProject(idOrName: string): Promise<Project> {
    return this.get(`/api/projects/${encodeURIComponent(idOrName)}`);
  }

  /** List agents currently active on a project (by project ID or name). */
  getProjectAgents(idOrName: string): Promise<{ agents: Agent[]; count: number }> {
    return this.get(`/api/projects/${encodeURIComponent(idOrName)}/agents`);
  }

  // --------------------------------------------------------------------------
  // Entities
  // --------------------------------------------------------------------------

  /** List entities. */
  listEntities(filter?: { type?: EntityType; limit?: number; offset?: number }): Promise<{ entities: Entity[]; count: number }> {
    return this.get("/api/entities", filter as Record<string, string | number | boolean | undefined>);
  }

  /** Create an entity. */
  createEntity(input: CreateEntityInput): Promise<Entity> {
    return this.post("/api/entities", input);
  }

  /** Merge two entities. */
  mergeEntities(input: { source_id: string; target_id: string }): Promise<Entity> {
    return this.post("/api/entities/merge", input);
  }

  /** Get an entity by ID. */
  getEntity(id: string): Promise<Entity> {
    return this.get(`/api/entities/${id}`);
  }

  /** Update an entity. */
  updateEntity(id: string, input: UpdateEntityInput): Promise<Entity> {
    return this.patch(`/api/entities/${id}`, input);
  }

  /** Delete an entity. */
  deleteEntity(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/entities/${id}`);
  }

  /** Get memories linked to an entity. */
  getEntityMemories(entityId: string): Promise<{ memories: Memory[]; count: number }> {
    return this.get(`/api/entities/${entityId}/memories`);
  }

  /** Link a memory to an entity. */
  linkEntityMemory(entityId: string, input: { memory_id: string; role?: EntityRole }): Promise<{ linked: boolean }> {
    return this.post(`/api/entities/${entityId}/memories`, input);
  }

  /** Unlink a memory from an entity. */
  unlinkEntityMemory(entityId: string, memoryId: string): Promise<{ unlinked: boolean }> {
    return this.delete(`/api/entities/${entityId}/memories/${memoryId}`);
  }

  /** Get relations for an entity. */
  getEntityRelations(entityId: string, filter?: { relation_type?: RelationType; direction?: "from" | "to" | "both" }): Promise<{ relations: Relation[] }> {
    return this.get(`/api/entities/${entityId}/relations`, filter as Record<string, string | number | boolean | undefined>);
  }

  // --------------------------------------------------------------------------
  // Relations
  // --------------------------------------------------------------------------

  /** Create a relation between entities. */
  createRelation(input: CreateRelationInput): Promise<Relation> {
    return this.post("/api/relations", input);
  }

  /** Get a relation by ID. */
  getRelation(id: string): Promise<Relation> {
    return this.get(`/api/relations/${id}`);
  }

  /** Delete a relation. */
  deleteRelation(id: string): Promise<{ deleted: boolean }> {
    return this.delete(`/api/relations/${id}`);
  }

  // --------------------------------------------------------------------------
  // Graph
  // --------------------------------------------------------------------------

  /** Get knowledge graph for an entity. */
  getGraph(entityId: string, options?: { depth?: number; relation_types?: RelationType[] }): Promise<{ nodes: Entity[]; edges: Relation[] }> {
    const q: Record<string, string | number | boolean | undefined> = {};
    if (options?.depth !== undefined) q["depth"] = options.depth;
    if (options?.relation_types?.length) q["relation_types"] = options.relation_types.join(",");
    return this.get(`/api/graph/${entityId}`, q);
  }

  /** Find shortest path between two entities. */
  findPath(fromId: string, toId: string): Promise<{ path: Entity[]; found: boolean }> {
    return this.get("/api/graph/path", { from: fromId, to: toId });
  }

  /** Get graph-wide stats. */
  getGraphStats(): Promise<{ entity_count: number; relation_count: number; by_type: Record<string, number> }> {
    return this.get("/api/graph/stats");
  }

  // --------------------------------------------------------------------------
  // Context injection
  // --------------------------------------------------------------------------

  /** Get formatted memory context for injection into agent prompts.
   * format: "xml" (default, <agent-memories> tags) | "markdown" | "compact" (key: value, smallest) | "json"
   */
  getContext(options?: {
    agent_id?: string;
    project_id?: string;
    max_tokens?: number;
    format?: "xml" | "markdown" | "compact" | "json";
  }): Promise<{ context: string; memories_count: number }> {
    return this.get("/api/inject", options as Record<string, string | number | boolean | undefined>);
  }
}

export default MementosClient;
