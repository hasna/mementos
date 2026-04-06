import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  cleanExpiredMemories,
} from "../../db/memories.js";
import { getAgent } from "../../db/agents.js";
import { getDatabase } from "../../db/database.js";
import { listMemories, touchMemory } from "../../db/memories.js";
import { synthesizeProfile } from "../../lib/profile-synthesizer.js";
import type {
  MemoryFilter,
} from "../../types/index.js";

import { ensureAutoProject, formatError } from "./memory-utils.js";

type ToolParam = {
  type: string;
  description: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string; enum?: string[] };
};

type ToolSchema = {
  description: string;
  category: string;
  params: Record<string, ToolParam>;
  example?: string;
};

const FULL_SCHEMAS: Record<string, ToolSchema> = {
  memory_save: {
    description: "Save/upsert a memory. Creates new or merges with existing key.",
    category: "memory",
    params: {
      key: { type: "string", description: "Unique key for the memory (kebab-case recommended)", required: true },
      value: { type: "string", description: "The memory content", required: true },
      scope: { type: "string", description: "Visibility: global=all agents, shared=project, private=single agent, working=transient session scratchpad (auto-expires 1h)", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Memory type", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      importance: { type: "number", description: "Priority 1-10 (10=critical)" },
      tags: { type: "array", description: "Searchable tags", items: { type: "string" } },
      summary: { type: "string", description: "Short summary for display" },
      agent_id: { type: "string", description: "Agent UUID to scope this memory to" },
      project_id: { type: "string", description: "Project UUID to scope this memory to" },
      session_id: { type: "string", description: "Session UUID" },
      ttl_ms: { type: "string|number", description: "Time-to-live e.g. '7d', '2h', or ms integer" },
      source: { type: "string", description: "Origin of the memory", enum: ["user", "agent", "system", "auto", "imported"] },
      metadata: { type: "object", description: "Arbitrary JSON metadata" },
      when_to_use: { type: "string", description: "Activation context — describes WHEN this memory should be retrieved. Used for intent-based retrieval. Example: 'when deploying to production'" },
      sequence_group: { type: "string", description: "Chain/sequence group ID — links memories into an ordered procedural sequence" },
      sequence_order: { type: "number", description: "Position within the sequence group (1-based)" },
    },
    example: '{"key":"preferred-language","value":"TypeScript","scope":"global","importance":8,"tags":["language","preference"]}',
  },
  memory_versions: {
    description: "Get full version history for a memory — all past values, scopes, importance scores.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)", required: true },
    },
    example: '{"id":"abc12345"}',
  },
  memory_get: {
    description: "Get a single memory by ID (partial IDs resolved).",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (full or partial)", required: true },
    },
    example: '{"id":"abc12345"}',
  },
  memory_recall: {
    description: "Recall a memory by exact key. Falls back to fuzzy search if no exact match.",
    category: "memory",
    params: {
      key: { type: "string", description: "Key to look up", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session UUID filter" },
    },
    example: '{"key":"preferred-language","scope":"global"}',
  },
  memory_chain_get: {
    description: "Retrieve an ordered memory chain/sequence by group ID. Returns all steps in procedural order.",
    category: "memory",
    params: {
      sequence_group: { type: "string", description: "The chain/sequence group ID to retrieve", required: true },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"sequence_group":"deploy-to-production"}',
  },
  memory_list: {
    description: "List memories with optional filters. Returns compact lines by default.",
    category: "memory",
    params: {
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      tags: { type: "array", description: "Filter by tags (AND logic)", items: { type: "string" } },
      min_importance: { type: "number", description: "Minimum importance threshold" },
      pinned: { type: "boolean", description: "Filter to pinned memories only" },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session UUID filter" },
      status: { type: "string", description: "Memory status filter", enum: ["active", "archived", "expired"] },
      limit: { type: "number", description: "Max results (default 50)" },
      offset: { type: "number", description: "Pagination offset" },
      full: { type: "boolean", description: "Return full JSON objects instead of compact lines" },
      fields: { type: "array", description: "Fields to include in full mode", items: { type: "string" } },
    },
    example: '{"scope":"global","min_importance":7,"limit":20}',
  },
  memory_update: {
    description: "Update a memory's fields. version is optional — auto-fetched if omitted (eliminates 2-round-trip pattern).",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)", required: true },
      version: { type: "number", description: "Current version for conflict detection (omit to auto-fetch)" },
      value: { type: "string", description: "New value" },
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      scope: { type: "string", description: "New scope", enum: ["global", "shared", "private", "working"] },
      importance: { type: "number", description: "New importance 1-10" },
      tags: { type: "array", description: "New tags (replaces all)", items: { type: "string" } },
      summary: { type: "string", description: "New summary (null to clear)" },
      pinned: { type: "boolean", description: "Pin/unpin the memory" },
      status: { type: "string", description: "New status", enum: ["active", "archived", "expired"] },
      metadata: { type: "object", description: "New metadata (replaces existing)" },
      expires_at: { type: "string", description: "New expiry ISO timestamp (null to clear)" },
      when_to_use: { type: "string", description: "Update the activation context for this memory" },
    },
    example: '{"id":"abc123","version":1,"importance":9,"tags":["correction","important"]}',
  },
  memory_pin: {
    description: "Pin or unpin a memory by ID or key. No version required.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID" },
      key: { type: "string", description: "Memory key (alternative to id)" },
      pinned: { type: "boolean", description: "true=pin (default), false=unpin" },
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"key":"project-stack","pinned":true}',
  },
  memory_archive: {
    description: "Archive a memory by ID or key. Hides from lists, preserves history. No version required.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID" },
      key: { type: "string", description: "Memory key (alternative to id)" },
      scope: { type: "string", description: "Scope filter for key lookup", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"key":"old-project-stack"}',
  },
  memory_forget: {
    description: "Delete a memory by ID or key.",
    category: "memory",
    params: {
      id: { type: "string", description: "Memory ID (partial OK)" },
      key: { type: "string", description: "Memory key" },
      scope: { type: "string", description: "Scope for key lookup", enum: ["global", "shared", "private", "working"] },
      agent_id: { type: "string", description: "Agent UUID for key lookup" },
      project_id: { type: "string", description: "Project UUID for key lookup" },
    },
    example: '{"key":"old-preference","scope":"global"}',
  },
  memory_stale: {
    description: "Find memories not accessed recently — useful for cleanup review (same pattern as get_stale_tasks in todos).",
    category: "memory",
    params: {
      days: { type: "number", description: "Stale threshold in days (default 30)" },
      project_id: { type: "string", description: "Filter by project" },
      agent_id: { type: "string", description: "Filter by agent" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"days":14,"project_id":"proj-uuid"}',
  },
  memory_search: {
    description: "Full-text search across key, value, summary, and tags.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      tags: { type: "array", description: "Tag filter", items: { type: "string" } },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      session_id: { type: "string", description: "Session ID filter" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"typescript","scope":"global","limit":10}',
  },
  memory_search_hybrid: {
    description: "Hybrid search combining keyword (FTS5) and semantic (embedding) search via Reciprocal Rank Fusion. Best retrieval quality.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query (natural language or keywords)", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      semantic_threshold: { type: "number", description: "Min cosine similarity for semantic results (default 0.3)" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"how does the auth system work","project_id":"proj-uuid"}',
  },
  memory_search_bm25: {
    description: "FTS5 BM25-ranked search. Field weights: key=10, value=5, summary=3.",
    category: "memory",
    params: {
      query: { type: "string", description: "Search query", required: true },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      limit: { type: "number", description: "Max results (default 20)" },
    },
    example: '{"query":"database migration","limit":5}',
  },
  memory_recall_deep: {
    description: "Deep memory recall using ASMR 3-agent search (facts, context, temporal). Modes: fast (hybrid), deep (ASMR), auto (fast then escalate). Optional ensemble answering.",
    category: "memory",
    params: {
      query: { type: "string", description: "Natural language query", required: true },
      mode: { type: "string", description: "fast=FTS+semantic, deep=ASMR 3-agent, auto=fast then escalate", enum: ["fast", "deep", "auto"] },
      max_results: { type: "number", description: "Max results (default 20)" },
      ensemble: { type: "boolean", description: "Use ensemble answering with majority voting (default false)" },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"query":"what is the deployment process","mode":"deep","ensemble":true}',
  },
  memory_activity: {
    description: "Get daily memory creation counts over N days (max 365). Like 'git log --stat' for memories.",
    category: "memory",
    params: {
      days: { type: "number", description: "Number of days to look back (default 30)" },
      scope: { type: "string", description: "Filter by scope", enum: ["global", "shared", "private", "working"] },
      agent_id: { type: "string", description: "Filter by agent" },
      project_id: { type: "string", description: "Filter by project" },
    },
    example: '{"days":14,"project_id":"proj-uuid"}',
  },
  memory_stats: {
    description: "Aggregate statistics: total, by scope, by category, pinned, expired counts.",
    category: "memory",
    params: {},
    example: "{}",
  },
  memory_export: {
    description: "Export memories as a JSON array.",
    category: "memory",
    params: {
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      category: { type: "string", description: "Category filter", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
    },
    example: '{"scope":"global"}',
  },
  memory_import: {
    description: "Import memories from a JSON array. Merges by key by default.",
    category: "memory",
    params: {
      memories: { type: "array", description: "Array of memory objects with key+value (required), plus optional fields", required: true, items: { type: "object" } },
      overwrite: { type: "boolean", description: "false=create-only (skip existing keys), default=merge" },
    },
    example: '{"memories":[{"key":"foo","value":"bar","scope":"global","importance":7}]}',
  },
  memory_inject: {
    description: "Get formatted memory context for system prompt injection. Respects token budget. Use strategy='smart' with task_context for full activation-matched + layered + tool-aware pipeline. Use mode='hints' for a lightweight topic summary (60-70% fewer tokens) — agent can then use memory_recall for details on demand.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID to include private memories" },
      project_id: { type: "string", description: "Project UUID to include shared memories" },
      session_id: { type: "string", description: "Session UUID" },
      max_tokens: { type: "number", description: "Approximate token budget (default 500)" },
      categories: { type: "array", description: "Categories to include (default: preference, fact, knowledge)", items: { type: "string", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] } },
      min_importance: { type: "number", description: "Minimum importance (default 3)" },
      format: { type: "string", description: "Output format: xml (default, <agent-memories>), compact (key: value, ~60% smaller), markdown, json", enum: ["xml", "compact", "markdown", "json"] },
      raw: { type: "boolean", description: "Deprecated: use format=compact instead. true=plain lines only" },
      strategy: { type: "string", description: "Injection strategy: 'default' = decay-scored (importance+recency), 'smart' = full pipeline (activation-matched + layered + tool-aware). Smart requires task_context.", enum: ["default", "smart"] },
      query: { type: "string", description: "Query for smart injection relevance scoring. Required when strategy='smart'." },
      task_context: { type: "string", description: "What the agent is about to do. Required for strategy='smart'. Activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories." },
      mode: { type: "string", description: "Injection mode: 'full' (default) = inject complete memory content, 'hints' = lightweight topic summary with counts per category, saving 60-70% tokens. In hints mode, use memory_recall(key=...) or memory_search(query=...) to pull details on demand.", enum: ["full", "hints"] },
    },
    example: '{"project_id":"proj-uuid","max_tokens":300,"strategy":"smart","task_context":"writing database migration for user table"}',
  },
  session_extract: {
    description: "Auto-create memories from a session summary (title, topics, notes, project). Designed for sessions→mementos integration.",
    category: "memory",
    params: {
      session_id: { type: "string", description: "Session ID to link memories to", required: true },
      title: { type: "string", description: "Session title" },
      project: { type: "string", description: "Project name" },
      model: { type: "string", description: "Model used" },
      messages: { type: "number", description: "Message count" },
      key_topics: { type: "array", description: "Key topics extracted from session", items: { type: "string" } },
      summary: { type: "string", description: "Free-form session summary text" },
      agent_id: { type: "string", description: "Agent ID to associate memories with" },
      project_id: { type: "string", description: "Project ID to scope memories to" },
    },
    example: '{"session_id":"abc123","title":"Fix auth middleware","project":"alumia","key_topics":["jwt","compliance"],"agent_id":"galba-id"}',
  },
  memory_context: {
    description: "Get active memories for the current context (agent/project/scope). Supports intent-based retrieval via task_context. Use strategy='smart' for full activation-matched + layered + tool-aware pipeline.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent UUID filter" },
      project_id: { type: "string", description: "Project UUID filter" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
      limit: { type: "number", description: "Max results (default 30)" },
      task_context: { type: "string", description: "What the agent is about to do. Required for strategy='smart'. Activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories." },
      strategy: { type: "string", description: "Injection strategy: 'default' = decay-scored, 'smart' = activation-matched + layered + tool-aware (requires task_context)", enum: ["default", "smart"] },
    },
    example: '{"project_id":"proj-uuid","scope":"shared","limit":20,"strategy":"smart","task_context":"deploying to production"}',
  },
  memory_profile: {
    description: "Synthesize a coherent profile from preference and fact memories using LLM. Cached for 24h, auto-refreshed when preferences change.",
    category: "memory",
    params: {
      project_id: { type: "string", description: "Project UUID to scope profile to" },
      agent_id: { type: "string", description: "Agent UUID to scope profile to" },
      scope: { type: "string", description: "Profile scope", enum: ["agent", "project", "global"] },
      force_refresh: { type: "boolean", description: "Force re-synthesis even if cached profile exists (default false)" },
    },
    example: '{"project_id":"proj-uuid","scope":"project"}',
  },
  register_agent: {
    description: "Register an agent. Idempotent — same name returns existing agent.",
    category: "agent",
    params: {
      name: { type: "string", description: "Agent name (e.g. 'maximus', 'cassius')", required: true },
      description: { type: "string", description: "Agent description" },
      role: { type: "string", description: "Agent role (default: 'agent')" },
    },
    example: '{"name":"maximus","role":"developer"}',
  },
  list_agents: {
    description: "List all registered agents with IDs, names, roles, and last-seen timestamps.",
    category: "agent",
    params: {},
    example: "{}",
  },
  get_agent: {
    description: "Get agent details by UUID or name.",
    category: "agent",
    params: {
      id: { type: "string", description: "Agent UUID or name", required: true },
    },
    example: '{"id":"maximus"}',
  },
  update_agent: {
    description: "Update agent name, description, role, metadata, or active_project_id. Call on session start to bind agent to current project.",
    category: "agent",
    params: {
      id: { type: "string", description: "Agent UUID or name", required: true },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description" },
      role: { type: "string", description: "New role" },
      metadata: { type: "object", description: "New metadata" },
      active_project_id: { type: "string", description: "Project ID this agent is currently working on (null to clear)" },
    },
    example: '{"id":"galba","active_project_id":"80a0be92-e0cc-4710-bce4-fb8a2e78e69e"}',
  },
  list_agents_by_project: {
    description: "List all agents currently active on a specific project.",
    category: "agent",
    params: {
      project_id: { type: "string", description: "Project ID", required: true },
    },
    example: '{"project_id":"80a0be92-e0cc-4710-bce4-fb8a2e78e69e"}',
  },
  register_project: {
    description: "Register a project for memory scoping. Idempotent by name.",
    category: "project",
    params: {
      name: { type: "string", description: "Project name (use git repo name)", required: true },
      path: { type: "string", description: "Absolute path to project root", required: true },
      description: { type: "string", description: "Project description" },
      memory_prefix: { type: "string", description: "Key prefix for project memories" },
    },
    example: '{"name":"open-mementos","path":"/Users/hasna/Workspace/hasna/opensource/opensourcedev/open-mementos"}',
  },
  list_projects: {
    description: "List all registered projects with IDs, names, and paths.",
    category: "project",
    params: {},
    example: "{}",
  },
  get_project: {
    description: "Get a project by ID, path, or name.",
    category: "project",
    params: {
      id: { type: "string", description: "Project ID, path, or name", required: true },
    },
    example: '{"id":"open-mementos"}',
  },
  bulk_forget: {
    description: "Delete multiple memories by IDs in one call.",
    category: "bulk",
    params: {
      ids: { type: "array", description: "Array of memory IDs (partials OK)", required: true, items: { type: "string" } },
    },
    example: '{"ids":["abc123","def456"]}',
  },
  bulk_update: {
    description: "Apply the same field updates to multiple memories.",
    category: "bulk",
    params: {
      ids: { type: "array", description: "Array of memory IDs (partials OK)", required: true, items: { type: "string" } },
      importance: { type: "number", description: "New importance 1-10" },
      tags: { type: "array", description: "New tags (replaces all)", items: { type: "string" } },
      pinned: { type: "boolean", description: "Pin/unpin" },
      category: { type: "string", description: "New category", enum: ["preference", "fact", "knowledge", "history", "procedural", "resource"] },
      status: { type: "string", description: "New status", enum: ["active", "archived", "expired"] },
    },
    example: '{"ids":["abc123","def456"],"importance":9,"tags":["important"]}',
  },
  clean_expired: {
    description: "Remove expired memories from the database. Returns count of removed entries.",
    category: "utility",
    params: {},
    example: "{}",
  },
  memory_report: {
    description: "Rich summary: total/pinned counts, sparkline activity, scope/category breakdown, top 5 memories by importance.",
    category: "memory",
    params: {
      days: { type: "number", description: "Activity window in days (default 7)" },
      project_id: { type: "string", description: "Filter by project" },
      agent_id: { type: "string", description: "Filter by agent" },
    },
    example: '{"days":7,"project_id":"proj-uuid"}',
  },
  entity_update: {
    description: "Update an entity's name, description, or metadata.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description (null to clear)" },
      metadata: { type: "object", description: "New metadata" },
    },
    example: '{"entity_name_or_id":"TypeScript","description":"Typed superset of JavaScript by Microsoft"}',
  },
  entity_unlink: {
    description: "Remove the link between an entity and a memory.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
    },
    example: '{"entity_name_or_id":"TypeScript","memory_id":"abc12345"}',
  },
  relation_get: {
    description: "Get a specific relation by ID.",
    category: "graph",
    params: {
      id: { type: "string", description: "Relation ID", required: true },
    },
    example: '{"id":"rel-uuid"}',
  },
  entity_create: {
    description: "Create a knowledge graph entity.",
    category: "graph",
    params: {
      name: { type: "string", description: "Entity name", required: true },
      type: { type: "string", description: "Entity type", required: true, enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
      description: { type: "string", description: "Entity description" },
      project_id: { type: "string", description: "Project UUID to scope this entity" },
    },
    example: '{"name":"TypeScript","type":"tool","description":"Typed superset of JavaScript"}',
  },
  entity_get: {
    description: "Get entity details including relations summary and linked memory count.",
    category: "graph",
    params: {
      name_or_id: { type: "string", description: "Entity name or ID (partial OK)", required: true },
      type: { type: "string", description: "Type hint for name disambiguation", enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
    },
    example: '{"name_or_id":"TypeScript"}',
  },
  entity_list: {
    description: "List entities with optional type, project, and search filters.",
    category: "graph",
    params: {
      type: { type: "string", description: "Type filter", enum: ["person", "project", "tool", "concept", "file", "api", "pattern", "organization"] },
      project_id: { type: "string", description: "Project UUID filter" },
      search: { type: "string", description: "Name search string" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    example: '{"type":"tool","limit":20}',
  },
  entity_delete: {
    description: "Delete an entity and all its relations.",
    category: "graph",
    params: {
      name_or_id: { type: "string", description: "Entity name or ID (partial OK)", required: true },
    },
    example: '{"name_or_id":"OldEntity"}',
  },
  entity_merge: {
    description: "Merge source entity into target — moves all relations and memory links.",
    category: "graph",
    params: {
      source: { type: "string", description: "Source entity name or ID (will be deleted)", required: true },
      target: { type: "string", description: "Target entity name or ID (will be kept)", required: true },
    },
    example: '{"source":"OldName","target":"NewName"}',
  },
  entity_link: {
    description: "Link an entity to a memory with a semantic role.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
      role: { type: "string", description: "Semantic role (default: context)", enum: ["subject", "object", "context"] },
    },
    example: '{"entity_name_or_id":"TypeScript","memory_id":"abc123","role":"subject"}',
  },
  relation_create: {
    description: "Create a typed relation between two entities.",
    category: "graph",
    params: {
      source_entity: { type: "string", description: "Source entity name or ID", required: true },
      target_entity: { type: "string", description: "Target entity name or ID", required: true },
      relation_type: { type: "string", description: "Relation type", required: true, enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] },
      weight: { type: "number", description: "Relation weight 0-1 (default 1.0)" },
    },
    example: '{"source_entity":"MyApp","target_entity":"TypeScript","relation_type":"uses"}',
  },
  relation_list: {
    description: "List relations for an entity, with optional type and direction filters.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Entity name or ID", required: true },
      relation_type: { type: "string", description: "Type filter", enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] },
      direction: { type: "string", description: "Direction filter (default: both)", enum: ["outgoing", "incoming", "both"] },
    },
    example: '{"entity_name_or_id":"MyApp","direction":"outgoing"}',
  },
  relation_delete: {
    description: "Delete a relation by ID.",
    category: "graph",
    params: {
      id: { type: "string", description: "Relation ID (partial OK)", required: true },
    },
    example: '{"id":"rel-abc123"}',
  },
  graph_query: {
    description: "Traverse the knowledge graph from an entity up to N hops. Returns entities and relations.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Starting entity name or ID", required: true },
      depth: { type: "number", description: "Max traversal depth (default 2)" },
    },
    example: '{"entity_name_or_id":"MyApp","depth":3}',
  },
  graph_path: {
    description: "Find the shortest path between two entities in the knowledge graph.",
    category: "graph",
    params: {
      from_entity: { type: "string", description: "Starting entity name or ID", required: true },
      to_entity: { type: "string", description: "Target entity name or ID", required: true },
      max_depth: { type: "number", description: "Max search depth (default 5)" },
    },
    example: '{"from_entity":"Agent","to_entity":"Database","max_depth":4}',
  },
  graph_stats: {
    description: "Get entity and relation counts broken down by type.",
    category: "graph",
    params: {},
    example: "{}",
  },
  graph_traverse: {
    description: "Multi-hop graph traversal from an entity. Returns all paths with entities and relations at each hop. Supports direction and relation-type filtering.",
    category: "graph",
    params: {
      entity_name_or_id: { type: "string", description: "Starting entity name or ID", required: true },
      max_depth: { type: "number", description: "Max traversal depth (default 2)" },
      relation_types: { type: "array", description: "Filter by relation types", items: { type: "string", enum: ["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"] } },
      direction: { type: "string", description: "Traversal direction (default both)", enum: ["outgoing", "incoming", "both"] },
      limit: { type: "number", description: "Max paths to return (default 50)" },
    },
    example: '{"entity_name_or_id":"MyApp","max_depth":3,"direction":"outgoing","relation_types":["uses","depends_on"]}',
  },
  memory_audit: {
    description: "Review low-trust memories flagged by poisoning detection heuristic.",
    category: "memory",
    params: {
      threshold: { type: "number", description: "Trust score threshold (default 0.8). Returns memories below this." },
      project_id: { type: "string", description: "Project UUID filter" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    example: '{"threshold":0.7,"limit":20}',
  },
  memory_rate: {
    description: "Rate a memory as useful or not useful for quality tracking.",
    category: "memory",
    params: {
      memory_id: { type: "string", description: "Memory ID (partial OK)", required: true },
      useful: { type: "boolean", description: "Was this memory useful?", required: true },
      agent_id: { type: "string", description: "Agent providing the rating" },
      context: { type: "string", description: "Optional context about why" },
    },
    example: '{"memory_id":"abc12345","useful":true,"context":"Helped debug issue"}',
  },
  memory_evict: {
    description: "Enforce memory bounds per scope — archives lowest-utility memories when any scope exceeds limit.",
    category: "memory",
    params: {
      project_id: { type: "string", description: "Optional project ID to scope eviction to" },
    },
    example: '{"project_id":"proj-uuid"}',
  },
  memory_save_image: {
    description: "Save an image memory. Auto-extracts description via GPT-4o-mini vision if OPENAI_API_KEY set.",
    category: "memory",
    params: {
      key: { type: "string", description: "Memory key", required: true },
      image_url: { type: "string", description: "URL of the image to describe" },
      image_description: { type: "string", description: "Manual description" },
      scope: { type: "string", description: "Visibility scope", enum: ["global", "shared", "private", "working"] },
      importance: { type: "number", description: "Priority 1-10" },
      tags: { type: "array", description: "Tags", items: { type: "string" } },
      agent_id: { type: "string", description: "Agent UUID" },
      project_id: { type: "string", description: "Project UUID" },
    },
    example: '{"key":"screenshot-auth-bug","image_url":"https://example.com/screenshot.png","importance":7}',
  },
  entity_disambiguate: {
    description: "Find potential duplicate entities by name similarity (trigram).",
    category: "graph",
    params: {
      threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.8)" },
    },
    example: '{"threshold":0.7}',
  },
  memory_compress: {
    description: "Compress multiple memories into a single summary. Uses LLM if available, otherwise truncates.",
    category: "memory",
    params: {
      memory_ids: { type: "array", description: "Memory IDs to compress", required: true, items: { type: "string" } },
      max_length: { type: "number", description: "Max chars (default 500)" },
    },
    example: '{"memory_ids":["abc12345","def67890"]}',
  },
  memory_subscribe: {
    description: "Subscribe an agent to memory change notifications by key/tag pattern.",
    category: "memory",
    params: {
      agent_id: { type: "string", description: "Agent ID", required: true },
      key_pattern: { type: "string", description: "Key glob pattern (e.g. 'architecture-*')" },
      tag_pattern: { type: "string", description: "Tag pattern to match" },
      scope: { type: "string", description: "Scope filter", enum: ["global", "shared", "private", "working"] },
    },
    example: '{"agent_id":"maximus","key_pattern":"architecture-*"}',
  },
  memory_unsubscribe: {
    description: "Remove a memory subscription.",
    category: "memory",
    params: {
      id: { type: "string", description: "Subscription ID", required: true },
    },
    example: '{"id":"sub-abc12"}',
  },
  memory_tool_insights: {
    description: "Get usage stats, lessons learned, and recommendations for MCP tools. Helps agents avoid past mistakes and reuse successful patterns.",
    category: "utility",
    params: {
      tool_name: { type: "string", description: "Specific tool to get insights for. If omitted, returns insights for all tools." },
      task_context: { type: "string", description: "What the agent is about to do — used to find relevant tool lessons via semantic match" },
      project_id: { type: "string", description: "Project ID filter" },
      agent_id: { type: "string", description: "Agent ID filter" },
      limit: { type: "number", description: "Max lessons to return per tool (default: 10)" },
    },
    example: '{"tool_name":"bash","limit":5}',
  },
  memory_save_tool_event: {
    description: "Record a tool call event (success/failure, latency, tokens). Optionally saves a lesson as a shared memory.",
    category: "memory",
    params: {
      tool_name: { type: "string", description: "Name of the tool that was called", required: true },
      action: { type: "string", description: "What was attempted" },
      success: { type: "boolean", description: "Whether the tool call succeeded", required: true },
      error_type: { type: "string", description: "Error category if failed", enum: ["timeout", "permission", "not_found", "syntax", "rate_limit", "other"] },
      error_message: { type: "string", description: "Raw error text if failed" },
      tokens_used: { type: "number", description: "Tokens consumed by the tool call" },
      latency_ms: { type: "number", description: "Time taken in milliseconds" },
      context: { type: "string", description: "What task triggered this tool call" },
      lesson: { type: "string", description: "Qualitative insight learned from this call" },
      when_to_use: { type: "string", description: "Activation context for the lesson" },
      agent_id: { type: "string", description: "Agent ID" },
      project_id: { type: "string", description: "Project ID" },
      session_id: { type: "string", description: "Session ID" },
    },
    example: '{"tool_name":"bash","action":"npm install","success":false,"error_type":"timeout","lesson":"npm install hangs on large monorepos — use --prefer-offline","when_to_use":"when installing deps in a monorepo"}',
  },
  memory_autoinject_config: {
    description: "Get or set auto-inject orchestrator config (channel-based proactive memory push). Controls throttle, debounce, rate limits, similarity thresholds.",
    category: "utility",
    params: {
      action: { type: "string", description: "Get or set auto-inject config", enum: ["get", "set"], required: true },
      throttle_ms: { type: "number", description: "Min ms between pushes (default 30000)" },
      debounce_ms: { type: "number", description: "Wait ms after last message before processing (default 2000)" },
      max_pushes_per_5min: { type: "number", description: "Rate limit per 5-minute window (default 5)" },
      min_similarity: { type: "number", description: "Minimum activation match threshold 0-1 (default 0.4)" },
      enabled: { type: "boolean", description: "Enable/disable auto-inject" },
      session_briefing: { type: "boolean", description: "Push session-start briefing (default true)" },
    },
    example: '{"action":"set","throttle_ms":15000,"min_similarity":0.5}',
  },
  memory_autoinject_status: {
    description: "Get auto-inject orchestrator status: running state, session watcher, push history, rate limit counters, and full config.",
    category: "utility",
    params: {},
    example: '{}',
  },
  memory_autoinject_test: {
    description: "Test what memories would be activated by a given context WITHOUT pushing. Shows what the auto-inject pipeline would match — useful for tuning min_similarity.",
    category: "utility",
    params: {
      context_text: { type: "string", description: "Simulated context to test activation matching", required: true },
      project_id: { type: "string", description: "Scope to a specific project" },
      min_similarity: { type: "number", description: "Minimum similarity threshold (default 0.4)" },
    },
    example: '{"context_text":"debugging a SQLite FTS5 index issue","min_similarity":0.3}',
  },
  search_tools: {
    description: "Search available tools by name or keyword. Returns matching tool names and categories.",
    category: "meta",
    params: {
      query: { type: "string", description: "Search keyword (matches tool name or description)", required: true },
      category: { type: "string", description: "Category filter", enum: ["memory", "agent", "project", "bulk", "utility", "graph", "meta"] },
    },
    example: '{"query":"memory","category":"memory"}',
  },
  describe_tools: {
    description: "Get full parameter schemas and examples for specific tools. Omit names to list all tools.",
    category: "meta",
    params: {
      names: { type: "array", description: "Tool names to describe (omit for all tools)", items: { type: "string" } },
    },
    example: '{"names":["memory_save","memory_recall"]}',
  },
  send_feedback: {
    description: "Send feedback about this service.",
    category: "meta",
    params: {
      message: { type: "string", description: "Feedback message", required: true },
      email: { type: "string", description: "Your email (optional)" },
      category: { type: "string", description: "Category", enum: ["bug", "feature", "general"] },
    },
    example: '{"message":"Great tool!","category":"general"}',
  },
  migrate_pg: {
    description: "Apply PostgreSQL schema migrations to the configured RDS instance.",
    category: "utility",
    params: {
      connection_string: { type: "string", description: "PostgreSQL connection string (overrides cloud config)" },
    },
    example: '{}',
  },
};

const TOOL_REGISTRY = Object.entries(FULL_SCHEMAS).map(([name, schema]) => ({
  name,
  description: schema.description,
  category: schema.category,
}));

export function registerUtilityTools(server: McpServer): void {
  server.tool(
    "clean_expired",
    "Remove expired memories from the database",
    {},
    async () => {
      try {
        const cleaned = cleanExpiredMemories();
        return { content: [{ type: "text" as const, text: `Cleaned ${cleaned} expired memor${cleaned === 1 ? "y" : "ies"}.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_briefing",
    "Lightweight delta briefing: what memories changed since an agent's last session. Use at session start instead of memory_context to avoid re-reading everything.",
    {
      agent_id: z.string().optional().describe("Agent ID or name. If provided, defaults since to agent's last_seen_at."),
      since: z.string().optional().describe("ISO 8601 timestamp. Defaults to agent's last_seen_at if agent_id provided, otherwise 24h ago."),
      project_id: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      limit: z.coerce.number().optional().describe("Max memories per category (default: 20)"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const limit = args.limit || 20;

        // Resolve 'since': agent's last_seen_at → explicit param → 24h ago
        let since = args.since;
        if (!since && args.agent_id) {
          const ag = getAgent(args.agent_id);
          if (ag?.last_seen_at) since = ag.last_seen_at;
        }
        if (!since) {
          since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        }

        const scopeClause = args.scope ? `AND scope = ?` : "";
        const projectClause = args.project_id ? `AND project_id = ?` : "";
        const extraParams = [
          ...(args.scope ? [args.scope] : []),
          ...(args.project_id ? [args.project_id] : []),
        ];

        // New memories
        const newMems = db.prepare(
          `SELECT id, key, value, summary, importance, scope, category, agent_id, created_at
           FROM memories WHERE status = 'active' AND created_at > ? ${scopeClause} ${projectClause}
           ORDER BY importance DESC, created_at DESC LIMIT ?`
        ).all(since, ...extraParams, limit) as Array<{id: string; key: string; value: string; summary: string|null; importance: number; scope: string; category: string; agent_id: string|null; created_at: string}>;

        // Updated memories (updated_at > since but created before since)
        const updatedMems = db.prepare(
          `SELECT id, key, value, summary, importance, scope, category, agent_id, updated_at
           FROM memories WHERE status = 'active' AND updated_at > ? AND created_at <= ? ${scopeClause} ${projectClause}
           ORDER BY importance DESC, updated_at DESC LIMIT ?`
        ).all(since, since, ...extraParams, limit) as Array<{id: string; key: string; summary: string|null; importance: number; scope: string; value: string; agent_id: string|null; updated_at: string}>;

        // Expired/archived memories
        const expiredMems = db.prepare(
          `SELECT id, key, scope, category, updated_at, status
           FROM memories WHERE status != 'active' AND updated_at > ? ${scopeClause} ${projectClause}
           ORDER BY updated_at DESC LIMIT ?`
        ).all(since, ...extraParams, Math.min(limit, 10)) as Array<{id: string; key: string; scope: string; category: string; updated_at: string; status: string}>;

        const parts: string[] = [`Memory briefing since ${since}`];
        if (newMems.length > 0) {
          parts.push(`\n**New (${newMems.length}):**`);
          for (const m of newMems) {
            parts.push(`• [${m.scope}/${m.category}] ${m.key} (importance:${m.importance}${m.agent_id ? `, by:${m.agent_id}` : ""}): ${(m.summary || m.value).slice(0, 100)}`);
          }
        }
        if (updatedMems.length > 0) {
          parts.push(`\n**Updated (${updatedMems.length}):**`);
          for (const m of updatedMems) {
            parts.push(`• [${m.scope}] ${m.key}: ${(m.summary || m.value).slice(0, 80)}`);
          }
        }
        if (expiredMems.length > 0) {
          parts.push(`\n**Expired/archived (${expiredMems.length}):**`);
          for (const m of expiredMems) {
            parts.push(`• [${m.scope}] ${m.key} — ${m.status}`);
          }
        }
        if (newMems.length === 0 && updatedMems.length === 0 && expiredMems.length === 0) {
          parts.push("\nNo memory changes since last session.");
        }
        parts.push(`\nSummary: ${newMems.length} new, ${updatedMems.length} updated, ${expiredMems.length} expired.`);

        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_context",
    "Get memories relevant to current context. Uses time-weighted scoring: score = importance × decay(age). Pinned memories are exempt. Returns effective_score on each memory.",
    {
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      limit: z.coerce.number().optional(),
      decay_halflife_days: z.coerce.number().optional().describe("Importance half-life in days (default: 90). Lower = more weight on recent memories."),
      no_decay: z.coerce.boolean().optional().describe("Set true to disable decay and sort purely by importance."),
      task_context: z.string().optional().describe("What the agent is about to do. When provided, activates intent-based retrieval — matches against when_to_use fields for situationally relevant memories."),
      strategy: z.enum(["default", "smart"]).optional().default("default").describe("Injection strategy: 'default' = decay-scored, 'smart' = activation-matched + layered + tool-aware (requires task_context)"),
    },
    async (args) => {
      try {
        // Smart strategy: delegate to full smartInject pipeline
        if (args.strategy === "smart" && args.task_context) {
          const { smartInject } = await import("../../lib/injector.js");
          const result = await smartInject({
            task_context: args.task_context,
            project_id: args.project_id,
            agent_id: args.agent_id,
            max_tokens: args.limit ? args.limit * 20 : undefined,
          });
          return { content: [{ type: "text" as const, text: result.output }] };
        }

        const filter: MemoryFilter = {
          scope: args.scope,
          agent_id: args.agent_id,
          project_id: args.project_id,
          status: "active",
          limit: (args.limit || 30) * 2, // fetch 2x, then rerank by effective score
        };
        const memories = listMemories(filter);

        // task_context activation: semantic search against when_to_use embeddings
        // Activation-matched memories get a +3 importance boost for scoring
        const activationBoostedIds = new Set<string>();
        if (args.task_context) {
          try {
            const { semanticSearch } = await import("../../db/memories.js");
            const activationResults = await semanticSearch(args.task_context, {
              threshold: 0.3,
              limit: 20,
              scope: args.scope,
              agent_id: args.agent_id,
              project_id: args.project_id,
            });
            const seenIds = new Set(memories.map((m) => m.id));
            for (const r of activationResults) {
              activationBoostedIds.add(r.memory.id);
              // Merge activation-matched memories not already in the list
              if (!seenIds.has(r.memory.id)) {
                seenIds.add(r.memory.id);
                memories.push(r.memory);
              }
            }
          } catch { /* Non-critical: proceed without activation matching if semantic search fails */ }
        }

        if (memories.length === 0) {
          return { content: [{ type: "text" as const, text: "No memories in current context." }] };
        }

        const halflifeDays = args.decay_halflife_days ?? 90;
        const now = Date.now();

        // Compute effective score with optional time-decay
        // Flagged memories get a bonus to always surface near top
        // Activation-matched memories get +3 importance boost
        const scored = memories.map((m) => {
          const activationBoost = activationBoostedIds.has(m.id) ? 3 : 0;
          let effectiveScore = m.importance + activationBoost;
          if (!args.no_decay && !m.pinned) {
            const ageMs = now - new Date(m.updated_at).getTime();
            const ageDays = ageMs / (1000 * 60 * 60 * 24);
            const decayFactor = Math.pow(0.5, ageDays / halflifeDays);
            effectiveScore = (m.importance + activationBoost) * decayFactor;
          }
          // Flagged memories always surface (boost to 11 equivalent — above max importance 10)
          if (m.flag) effectiveScore = Math.max(effectiveScore, 11);
          return { ...m, effective_score: Math.round(effectiveScore * 100) / 100 };
        });

        // Sort by effective_score descending, take top N
        const limit = args.limit || 30;
        scored.sort((a, b) => b.effective_score - a.effective_score);
        const top = scored.slice(0, limit);

        // Increment access_count for returned memories
        for (const m of top) {
          touchMemory(m.id);
        }

        const lines = top.map((m) =>
          `[${m.scope}/${m.category}] ${m.key}: ${m.value} (score: ${m.effective_score}, raw: ${m.importance}${m.pinned ? ", pinned" : ""}${m.flag ? `, flag: ${m.flag}` : ""})`
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_context_layered",
    "Structured multi-section memory context: Core Facts, Recent History, Relevant Knowledge, Active Decisions. Better than flat lists for agent prompts.",
    {
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      query: z.string().optional().describe("Query to find relevant knowledge (populates Relevant Knowledge section)"),
      max_per_section: z.coerce.number().optional().describe("Max memories per section (default: 10)"),
    },
    async (args) => {
      try {
        const { assembleContext, formatLayeredContext } = await import("../../lib/context.js");
        const ctx = assembleContext({
          project_id: args.project_id,
          agent_id: args.agent_id,
          scope: args.scope,
          query: args.query,
          max_per_section: args.max_per_section,
        });
        if (ctx.total_memories === 0) {
          return { content: [{ type: "text" as const, text: "No memories found for layered context." }] };
        }
        const formatted = formatLayeredContext(ctx);
        return { content: [{ type: "text" as const, text: `${formatted}\n---\n${ctx.total_memories} memories, ~${ctx.token_estimate} tokens` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_profile",
    "Synthesize a coherent profile from preference and fact memories using LLM. Cached for 24h, auto-refreshed when preferences change. Returns markdown profile.",
    {
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      scope: z.enum(["agent", "project", "global"]).optional().default("project"),
      force_refresh: z.boolean().optional().default(false).describe("Force re-synthesis even if cached profile exists"),
    },
    async (args) => {
      try {
        ensureAutoProject();
        const result = await synthesizeProfile(args);
        if (!result) {
          return { content: [{ type: "text" as const, text: "No preference or fact memories found to synthesize a profile from." }] };
        }
        return { content: [{ type: "text" as const, text: `${result.from_cache ? "[cached] " : "[synthesized] "}(${result.memory_count} memories)\n\n${result.profile}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "search_tools",
    "Search available tools by name or keyword. Returns names only.",
    {
      query: z.string(),
      category: z.enum(["memory", "agent", "project", "bulk", "utility", "graph", "meta"]).optional(),
    },
    async (args) => {
      const q = args.query.toLowerCase();
      const results = TOOL_REGISTRY.filter(t =>
        (!args.category || t.category === args.category) &&
        (t.name.includes(q) || t.description.toLowerCase().includes(q))
      );
      if (results.length === 0) return { content: [{ type: "text" as const, text: "No tools found." }] };
      return { content: [{ type: "text" as const, text: results.map(t => `${t.name} [${t.category}]: ${t.description}`).join("\n") }] };
    }
  );

  server.tool(
    "describe_tools",
    "Get full parameter schemas and examples for tools. Omit names to list all tools.",
    {
      names: z.array(z.string()).optional(),
    },
    async (args) => {
      const targets = (args.names && args.names.length > 0)
        ? args.names
        : Object.keys(FULL_SCHEMAS);
      const results = targets
        .filter(name => name in FULL_SCHEMAS)
        .map(name => {
          const schema = FULL_SCHEMAS[name]!;
          const paramLines = Object.entries(schema.params).map(([pname, p]) => {
            const req = p.required ? " [required]" : "";
            const enumStr = p.enum ? ` (${p.enum.join("|")})` : "";
            return `  ${pname}${req}: ${p.type}${enumStr} — ${p.description}`;
          });
          const lines = [
            `### ${name} [${schema.category}]`,
            schema.description,
          ];
          if (paramLines.length > 0) {
            lines.push("Params:", ...paramLines);
          } else {
            lines.push("Params: none");
          }
          if (schema.example) lines.push(`Example: ${schema.example}`);
          return lines.join("\n");
        });
      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No matching tools." }] };
      }
      return { content: [{ type: "text" as const, text: results.join("\n\n") }] };
    }
  );
}
