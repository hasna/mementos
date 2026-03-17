/**
 * @hasna/mementos-sdk — Zero-dependency TypeScript client for @hasna/mementos REST API.
 *
 * Works in Node.js, Bun, Deno, and browsers. No external dependencies beyond fetch.
 *
 * @example
 * ```ts
 * import { MementosClient } from "@hasna/mementos-sdk";
 * const client = MementosClient.fromEnv();          // reads MEMENTOS_URL
 * // or: const client = new MementosClient({ baseUrl: "http://localhost:19428" });
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
export type RelationType = "uses" | "knows" | "depends_on" | "created_by" | "related_to" | "contradicts" | "part_of" | "implements";
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

export interface Agent {
  id: string;
  name: string;
  role: string | null;
  description: string | null;
  active_project_id?: string | null;
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

export type ResourceType = "project" | "memory" | "entity" | "agent" | "connector";
export type LockType = "advisory" | "exclusive";

export interface ResourceLock {
  id: string;
  resource_type: ResourceType;
  resource_id: string;
  agent_id: string;
  lock_type: LockType;
  locked_at: string;
  expires_at: string;
}

export interface AcquireLockInput {
  agent_id: string;
  resource_type: ResourceType;
  resource_id: string;
  lock_type?: LockType;
  ttl_seconds?: number;
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
  version?: number;
}

export interface ListMemoriesFilter {
  scope?: MemoryScope;
  category?: MemoryCategory;
  tags?: string[];
  min_importance?: number;
  pinned?: boolean;
  agent_id?: string;
  project_id?: string;
  session_id?: string;
  status?: MemoryStatus;
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

  /**
   * Create a client from environment variables.
   * Reads MEMENTOS_URL (default: http://localhost:19428)
   * @example const client = MementosClient.fromEnv();
   */
  static fromEnv(overrides: Partial<MementosClientConfig> = {}): MementosClient {
    const envUrl = typeof process !== "undefined" ? process.env?.["MEMENTOS_URL"] : undefined;
    const baseUrl = envUrl ?? "http://localhost:19428";
    return new MementosClient({ baseUrl, ...overrides });
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
    if (filter.session_id) q["session_id"] = filter.session_id;
    if (filter.status) q["status"] = filter.status;
    if (filter.limit !== undefined) q["limit"] = filter.limit;
    if (filter.offset !== undefined) q["offset"] = filter.offset;
    if (filter.fields?.length) q["fields"] = filter.fields.join(",");
    return this.get("/api/memories", q);
  }

  /** Get memory stats. */
  getStats(): Promise<MemoryStats> {
    return this.get("/api/memories/stats");
  }

  /** Get server health — version, memory counts, status (ok | warn). */
  getHealth(): Promise<{
    status: "ok" | "warn";
    version: string;
    profile: string;
    db_path: string;
    hostname: string;
    memories: { total: number; expired: number; pinned: number };
    agents: number;
    projects: number;
  }> {
    return this.get("/api/health");
  }

  /** Get a rich report: totals, activity trend, scope/category breakdown, top memories. */
  getReport(options?: {
    days?: number;
    project_id?: string;
    agent_id?: string;
  }): Promise<{
    total: number;
    pinned: number;
    days: number;
    recent: { total: number; activity: { date: string; memories_created: number }[] };
    by_scope: Record<string, number>;
    by_category: Record<string, number>;
    top_memories: { id: string; key: string; value: string; importance: number; scope: string; category: string }[];
    top_agents: { agent_id: string; c: number }[];
  }> {
    return this.get("/api/report", options as Record<string, string | number | boolean | undefined>);
  }

  /** Find memories not accessed recently — for cleanup/review/gardening. */
  getStaleMemories(options?: {
    days?: number;
    project_id?: string;
    agent_id?: string;
    limit?: number;
  }): Promise<{ memories: Memory[]; count: number; days: number }> {
    return this.get("/api/memories/stale", options as Record<string, string | number | boolean | undefined>);
  }

  /** Get daily memory creation activity over N days. */
  getActivity(options?: {
    days?: number;
    scope?: MemoryScope;
    agent_id?: string;
    project_id?: string;
  }): Promise<{ activity: { date: string; memories_created: number; global_count: number; shared_count: number; private_count: number; avg_importance: number }[]; days: number; total: number }> {
    return this.get("/api/activity", options as Record<string, string | number | boolean | undefined>);
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

  /** Extract memories from a session summary. For sessions→mementos integration.
   * Auto-creates: session summary (history), key topics (knowledge), notes (knowledge).
   */
  extractFromSession(input: {
    session_id: string;
    title?: string;
    project?: string;
    model?: string;
    messages?: number;
    key_topics?: string[];
    summary?: string;
    agent_id?: string;
    project_id?: string;
    memories?: Partial<CreateMemoryInput>[];
  }): Promise<{ created: number; memory_ids: string[]; errors: string[]; session_id: string }> {
    return this.post("/api/memories/extract", input);
  }

  /** Save (create) a memory. */
  saveMemory(input: CreateMemoryInput): Promise<Memory> {
    return this.post("/api/memories", input);
  }

  /** Get a memory by ID. */
  getMemory(id: string): Promise<Memory> {
    return this.get(`/api/memories/${id}`);
  }

  /** Get version history for a memory — all past values and metadata. */
  getMemoryVersions(id: string): Promise<{ versions: MemoryVersion[]; count: number; current_version: number }> {
    return this.get(`/api/memories/${id}/versions`);
  }

  /** Update a memory. If version is omitted, the server auto-fetches the current version. */
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
  // Resource locks
  // --------------------------------------------------------------------------

  /** Acquire a lock on a resource. Returns null on conflict (409). */
  async acquireLock(input: AcquireLockInput): Promise<ResourceLock | null> {
    try {
      return await this.post("/api/locks", input);
    } catch (e) {
      if (e instanceof Error && e.message.includes("409")) return null;
      throw e;
    }
  }

  /** Check active locks on a resource. */
  checkLock(resourceType: ResourceType, resourceId: string, lockType?: LockType): Promise<ResourceLock[]> {
    const params: Record<string, string> = { resource_type: resourceType, resource_id: resourceId };
    if (lockType) params["lock_type"] = lockType;
    return this.get("/api/locks", params);
  }

  /** Release a specific lock. Only the owning agent can release. */
  releaseLock(lockId: string, agentId: string): Promise<{ released: boolean }> {
    return this.request("DELETE", `/api/locks/${lockId}`, { agent_id: agentId });
  }

  /** List all active locks held by an agent. */
  listAgentLocks(agentId: string): Promise<ResourceLock[]> {
    return this.get(`/api/agents/${agentId}/locks`);
  }

  /** Release all locks held by an agent (call on session end). */
  releaseAllAgentLocks(agentId: string): Promise<{ released: number }> {
    return this.request("DELETE", `/api/agents/${agentId}/locks`);
  }

  /** Clean all expired locks. */
  cleanExpiredLocks(): Promise<{ cleaned: number }> {
    return this.post("/api/locks/clean", {});
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

  // --------------------------------------------------------------------------
  // Auto-Memory (LLM-based extraction)
  // --------------------------------------------------------------------------

  /** Enqueue a conversation turn for async LLM memory extraction. Returns immediately (fire-and-forget). */
  processConversationTurn(
    turn: string,
    context?: { agent_id?: string; project_id?: string; session_id?: string }
  ): Promise<{ queued: boolean; queue: AutoMemoryQueueStats }> {
    return this.post("/api/auto-memory/process", { turn, ...context });
  }

  /** Get auto-memory queue stats and provider health. */
  getAutoMemoryStatus(): Promise<{
    queue: AutoMemoryQueueStats;
    config: AutoMemoryConfig;
    providers: Record<string, { available: boolean; model: string }>;
  }> {
    return this.get("/api/auto-memory/status");
  }

  /** Update auto-memory config at runtime (no restart needed). */
  configureAutoMemory(
    config: Partial<AutoMemoryConfig> & { min_importance?: number; auto_entity_link?: boolean }
  ): Promise<{ updated: boolean; config: AutoMemoryConfig }> {
    return this.request("PATCH", "/api/auto-memory/config", config as Record<string, unknown>);
  }

  /** Test extraction without saving. Returns what would be extracted. */
  testExtraction(
    turn: string,
    options?: { provider?: "anthropic" | "openai" | "cerebras" | "grok"; agent_id?: string; project_id?: string }
  ): Promise<{ provider: string; model: string; extracted: SdkExtractedMemory[]; count: number; note: string }> {
    return this.post("/api/auto-memory/test", { turn, ...options });
  }

  // ─── Hook management ─────────────────────────────────────────────────────────

  /** List in-memory registered hooks (built-in + webhooks). */
  listHooks(type?: string): Promise<SdkHook[]> {
    const params = type ? `?type=${encodeURIComponent(type)}` : "";
    return this.get(`/api/hooks${params}`);
  }

  /** Get hook registry statistics. */
  getHookStats(): Promise<{ total: number; byType: Record<string, number>; blocking: number; nonBlocking: number }> {
    return this.get("/api/hooks/stats");
  }

  /** List persisted webhook hooks. */
  listWebhooks(filter?: { type?: string; enabled?: boolean }): Promise<SdkWebhook[]> {
    const params = new URLSearchParams();
    if (filter?.type) params.set("type", filter.type);
    if (filter?.enabled !== undefined) params.set("enabled", String(filter.enabled));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/webhooks${qs}`);
  }

  /** Create a persistent webhook hook. */
  createWebhook(input: {
    type: string;
    handler_url: string;
    priority?: number;
    blocking?: boolean;
    agent_id?: string;
    project_id?: string;
    description?: string;
  }): Promise<SdkWebhook> {
    return this.post("/api/webhooks", input as Record<string, unknown>);
  }

  /** Get a webhook by ID. */
  getWebhook(id: string): Promise<SdkWebhook> {
    return this.get(`/api/webhooks/${id}`);
  }

  /** Update a webhook (enable/disable, priority, description). */
  updateWebhook(
    id: string,
    updates: { enabled?: boolean; priority?: number; description?: string }
  ): Promise<SdkWebhook> {
    return this.request("PATCH", `/api/webhooks/${id}`, updates as Record<string, unknown>);
  }

  /** Delete a webhook by ID. */
  deleteWebhook(id: string): Promise<void> {
    return this.request("DELETE", `/api/webhooks/${id}`);
  }

  /** Enable a webhook. */
  enableWebhook(id: string): Promise<SdkWebhook> {
    return this.updateWebhook(id, { enabled: true });
  }

  /** Disable a webhook without deleting it. */
  disableWebhook(id: string): Promise<SdkWebhook> {
    return this.updateWebhook(id, { enabled: false });
  }

  // ─── Synthesis ────────────────────────────────────────────────────────────────

  /** Run ALMA synthesis on the memory corpus. */
  runSynthesis(options?: {
    project_id?: string;
    agent_id?: string;
    dry_run?: boolean;
    max_proposals?: number;
    provider?: string;
  }): Promise<SynthesisResult> {
    return this.post("/api/synthesis/run", (options ?? {}) as Record<string, unknown>);
  }

  /** List synthesis run history. */
  listSynthesisRuns(filter?: { project_id?: string; limit?: number }): Promise<{ runs: SynthesisRun[]; count: number }> {
    const params = new URLSearchParams();
    if (filter?.project_id) params.set("project_id", filter.project_id);
    if (filter?.limit) params.set("limit", String(filter.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/synthesis/runs${qs}`);
  }

  /** Get synthesis status. */
  getSynthesisStatus(options?: { project_id?: string; run_id?: string }): Promise<{ lastRun: SynthesisRun | null; recentRuns: SynthesisRun[] }> {
    const params = new URLSearchParams();
    if (options?.project_id) params.set("project_id", options.project_id);
    if (options?.run_id) params.set("run_id", options.run_id);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/synthesis/status${qs}`);
  }

  /** Roll back a synthesis run. */
  rollbackSynthesis(runId: string): Promise<{ rolled_back: number; errors: string[] }> {
    return this.post(`/api/synthesis/rollback/${runId}`, {});
  }

  // ─── Session ingestion ────────────────────────────────────────────────────────

  /** Submit a session transcript for async memory extraction. */
  ingestSession(input: {
    transcript: string;
    session_id: string;
    agent_id?: string;
    project_id?: string;
    source?: "claude-code" | "codex" | "manual" | "open-sessions";
    metadata?: Record<string, unknown>;
  }): Promise<{ job_id: string; status: string; message: string }> {
    return this.post("/api/sessions/ingest", input as Record<string, unknown>);
  }

  /** Get the status of a session extraction job. */
  getSessionJob(jobId: string): Promise<SessionMemoryJob> {
    return this.get(`/api/sessions/jobs/${jobId}`);
  }

  /** List session extraction jobs. */
  listSessionJobs(filter?: { agent_id?: string; project_id?: string; status?: string; limit?: number }): Promise<{ jobs: SessionMemoryJob[]; count: number }> {
    const params = new URLSearchParams();
    if (filter?.agent_id) params.set("agent_id", filter.agent_id);
    if (filter?.project_id) params.set("project_id", filter.project_id);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.limit) params.set("limit", String(filter.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    return this.get(`/api/sessions/jobs${qs}`);
  }

  /** Get session queue statistics. */
  getSessionQueueStats(): Promise<{ pending: number; processing: number; completed: number; failed: number }> {
    return this.get("/api/sessions/queue/stats");
  }
}

export interface SessionMemoryJob {
  id: string;
  session_id: string;
  agent_id: string | null;
  project_id: string | null;
  source: string;
  status: "pending" | "processing" | "completed" | "failed";
  transcript: string;
  chunk_count: number;
  memories_extracted: number;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ─── Auto-memory types (exported for SDK consumers) ───────────────────────────

export interface AutoMemoryQueueStats {
  pending: number;
  processing: number;
  processed: number;
  failed: number;
  dropped: number;
}

export interface AutoMemoryConfig {
  provider: "anthropic" | "openai" | "cerebras" | "grok";
  model?: string;
  enabled: boolean;
  minImportance: number;
  autoEntityLink: boolean;
  fallback?: Array<"anthropic" | "openai" | "cerebras" | "grok">;
}

export interface SdkExtractedMemory {
  content: string;
  category: "preference" | "fact" | "knowledge" | "history";
  importance: number;
  tags: string[];
  suggestedScope: "private" | "shared" | "global";
  reasoning?: string;
}

export interface SdkHook {
  id: string;
  type: string;
  blocking: boolean;
  priority: number;
  builtin: boolean;
  agentId?: string;
  projectId?: string;
  description?: string;
}

export interface SdkWebhook {
  id: string;
  type: string;
  handlerUrl: string;
  priority: number;
  blocking: boolean;
  agentId?: string;
  projectId?: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  invocationCount: number;
  failureCount: number;
}

export interface SynthesisRun {
  id: string;
  triggered_by: string;
  project_id: string | null;
  agent_id: string | null;
  corpus_size: number;
  proposals_generated: number;
  proposals_accepted: number;
  proposals_rejected: number;
  status: "pending" | "running" | "completed" | "failed" | "rolled_back";
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface SynthesisResult {
  run: SynthesisRun;
  proposals: unknown[];
  executed: number;
  metrics: { corpusReduction: number; deduplicationRate: number } | null;
  dryRun: boolean;
}

export default MementosClient;
