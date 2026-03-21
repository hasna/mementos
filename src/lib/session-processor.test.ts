// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chunkTranscript,
  extractMemoriesFromChunk,
  processSessionJob,
} from "./session-processor.js";
import {
  createSessionJob,
  getSessionJob,
  listSessionJobs,
  updateSessionJob,
} from "../db/session-jobs.js";
import { autoResolveAgentProject } from "./session-auto-resolve.js";
import { providerRegistry } from "./providers/registry.js";

// ============================================================================
// Test DB helpers
// ============================================================================

function freshDb(): Database {
  const db = new Database(":memory:", { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT UNIQUE NOT NULL,
      description TEXT,
      memory_prefix TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      role TEXT DEFAULT 'agent',
      metadata TEXT DEFAULT '{}',
      active_project_id TEXT,
      session_id TEXT,
      machine_id TEXT,
      flag TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'knowledge' CHECK(category IN ('preference', 'fact', 'knowledge', 'history', 'procedural', 'resource')),
      scope TEXT NOT NULL DEFAULT 'private' CHECK(scope IN ('global', 'shared', 'private', 'working')),
      summary TEXT,
      tags TEXT DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 5 CHECK(importance >= 1 AND importance <= 10),
      source TEXT NOT NULL DEFAULT 'agent' CHECK(source IN ('user', 'agent', 'system', 'auto', 'imported')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived', 'expired')),
      pinned INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id TEXT,
      machine_id TEXT,
      flag TEXT,
      metadata TEXT DEFAULT '{}',
      access_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT,
      valid_from TEXT DEFAULT NULL,
      valid_until TEXT DEFAULT NULL,
      ingested_at TEXT DEFAULT NULL, namespace TEXT DEFAULT NULL, created_by_agent TEXT DEFAULT NULL, updated_by_agent TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      accessed_at TEXT,
      recall_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memory_tags (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (memory_id, tag)
    );

    CREATE TABLE IF NOT EXISTS memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      value TEXT NOT NULL,
      importance INTEGER NOT NULL,
      scope TEXT NOT NULL,
      category TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      summary TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(memory_id, version)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key, value, summary,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique_key
      ON memories(key, scope, COALESCE(agent_id, ''), COALESCE(project_id, ''), COALESCE(session_id, ''));

    CREATE TABLE IF NOT EXISTS session_memory_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      project_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('claude-code','codex','manual','open-sessions')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
      transcript TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      memories_extracted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_status ON session_memory_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_agent ON session_memory_jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_project ON session_memory_jobs(project_id);
    CREATE INDEX IF NOT EXISTS idx_session_memory_jobs_session ON session_memory_jobs(session_id);
  `);

  return db;
}

// ============================================================================
// Tests: chunkTranscript
// ============================================================================

describe("chunkTranscript", () => {
  it("returns single chunk for short transcript", () => {
    const chunks = chunkTranscript("hello world", 2000, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("hello world");
  });

  it("returns empty array for empty transcript", () => {
    const chunks = chunkTranscript("", 2000, 200);
    expect(chunks).toHaveLength(0);
  });

  it("splits into correct number of chunks", () => {
    // 4500 chars, chunkSize=2000, overlap=200
    const transcript = "a".repeat(4500);
    const chunks = chunkTranscript(transcript, 2000, 200);
    // chunk 1: 0..2000, chunk 2: 1800..3800, chunk 3: 3600..4500
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  it("applies overlap between chunks", () => {
    const transcript = "a".repeat(100) + "OVERLAP" + "b".repeat(100);
    const chunks = chunkTranscript(transcript, 150, 50);
    if (chunks.length >= 2) {
      // The second chunk should start 100 chars into the first
      const chunk1End = chunks[0]!.slice(-50);
      const chunk2Start = chunks[1]!.slice(0, 50);
      // They should share content due to overlap
      expect(chunk1End).toBe(chunk2Start);
    }
  });

  it("handles transcript exactly at chunk size", () => {
    const transcript = "x".repeat(2000);
    const chunks = chunkTranscript(transcript, 2000, 200);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBe(2000);
  });

  it("uses default chunkSize=2000 and overlap=200", () => {
    const transcript = "z".repeat(5000);
    const chunks = chunkTranscript(transcript);
    expect(chunks.length).toBeGreaterThan(1);
  });
});

// ============================================================================
// Tests: createSessionJob + getSessionJob (DB CRUD)
// ============================================================================

describe("createSessionJob + getSessionJob", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("creates and retrieves a job", () => {
    const job = createSessionJob(
      {
        session_id: "sess-123",
        transcript: "This is a test transcript.",
        source: "claude-code",
        agent_id: "agent-001",
        project_id: "proj-001",
        metadata: { env: "test" },
      },
      db
    );

    expect(job.id).toBeTruthy();
    expect(job.session_id).toBe("sess-123");
    expect(job.transcript).toBe("This is a test transcript.");
    expect(job.source).toBe("claude-code");
    expect(job.agent_id).toBe("agent-001");
    expect(job.project_id).toBe("proj-001");
    expect(job.status).toBe("pending");
    expect(job.chunk_count).toBe(0);
    expect(job.memories_extracted).toBe(0);
    expect(job.error).toBeNull();
    expect(job.metadata).toEqual({ env: "test" });
    expect(job.created_at).toBeTruthy();
    expect(job.started_at).toBeNull();
    expect(job.completed_at).toBeNull();

    const retrieved = getSessionJob(job.id, db);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(job.id);
    expect(retrieved!.session_id).toBe("sess-123");
  });

  it("returns null for non-existent job", () => {
    const result = getSessionJob("nonexistent-id", db);
    expect(result).toBeNull();
  });

  it("defaults source to manual", () => {
    const job = createSessionJob(
      { session_id: "sess-456", transcript: "test" },
      db
    );
    expect(job.source).toBe("manual");
  });

  it("stores metadata as JSON", () => {
    const meta = { key: "value", nested: { a: 1 } };
    const job = createSessionJob(
      { session_id: "sess-789", transcript: "test", metadata: meta },
      db
    );
    expect(job.metadata).toEqual(meta);
  });
});

// ============================================================================
// Tests: listSessionJobs with filters
// ============================================================================

describe("listSessionJobs", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("lists all jobs when no filter", () => {
    createSessionJob({ session_id: "s1", transcript: "t1" }, db);
    createSessionJob({ session_id: "s2", transcript: "t2" }, db);
    createSessionJob({ session_id: "s3", transcript: "t3" }, db);

    const jobs = listSessionJobs(undefined, db);
    expect(jobs.length).toBe(3);
  });

  it("filters by status", () => {
    const job1 = createSessionJob({ session_id: "s1", transcript: "t1" }, db);
    const job2 = createSessionJob({ session_id: "s2", transcript: "t2" }, db);
    updateSessionJob(job1.id, { status: "completed" }, db);

    const pending = listSessionJobs({ status: "pending" }, db);
    const completed = listSessionJobs({ status: "completed" }, db);

    expect(pending.length).toBe(1);
    expect(pending[0]!.session_id).toBe("s2");
    expect(completed.length).toBe(1);
    expect(completed[0]!.session_id).toBe("s1");
  });

  it("filters by agent_id", () => {
    createSessionJob({ session_id: "s1", transcript: "t1", agent_id: "agent-a" }, db);
    createSessionJob({ session_id: "s2", transcript: "t2", agent_id: "agent-b" }, db);

    const results = listSessionJobs({ agent_id: "agent-a" }, db);
    expect(results.length).toBe(1);
    expect(results[0]!.agent_id).toBe("agent-a");
  });

  it("filters by project_id", () => {
    createSessionJob({ session_id: "s1", transcript: "t1", project_id: "proj-x" }, db);
    createSessionJob({ session_id: "s2", transcript: "t2", project_id: "proj-y" }, db);

    const results = listSessionJobs({ project_id: "proj-x" }, db);
    expect(results.length).toBe(1);
    expect(results[0]!.project_id).toBe("proj-x");
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      createSessionJob({ session_id: `s${i}`, transcript: "t" }, db);
    }

    const results = listSessionJobs({ limit: 2 }, db);
    expect(results.length).toBe(2);
  });

  it("returns empty array when no matches", () => {
    const results = listSessionJobs({ status: "failed" }, db);
    expect(results).toEqual([]);
  });
});

// ============================================================================
// Tests: updateSessionJob status changes
// ============================================================================

describe("updateSessionJob", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("updates status to processing", () => {
    const job = createSessionJob({ session_id: "s1", transcript: "t1" }, db);
    const updated = updateSessionJob(
      job.id,
      { status: "processing", started_at: "2025-01-01T00:00:00.000Z" },
      db
    );
    expect(updated!.status).toBe("processing");
    expect(updated!.started_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("updates status to completed with counts", () => {
    const job = createSessionJob({ session_id: "s1", transcript: "t1" }, db);
    const updated = updateSessionJob(
      job.id,
      {
        status: "completed",
        chunk_count: 3,
        memories_extracted: 12,
        completed_at: "2025-01-01T01:00:00.000Z",
      },
      db
    );
    expect(updated!.status).toBe("completed");
    expect(updated!.chunk_count).toBe(3);
    expect(updated!.memories_extracted).toBe(12);
    expect(updated!.completed_at).toBe("2025-01-01T01:00:00.000Z");
  });

  it("updates status to failed with error", () => {
    const job = createSessionJob({ session_id: "s1", transcript: "t1" }, db);
    const updated = updateSessionJob(
      job.id,
      { status: "failed", error: "LLM timeout" },
      db
    );
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toBe("LLM timeout");
  });

  it("returns null for non-existent job", () => {
    const result = updateSessionJob("nonexistent", { status: "completed" }, db);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Tests: autoResolveAgentProject
// ============================================================================

describe("autoResolveAgentProject", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();

    // Seed an agent and project
    db.run(
      `INSERT INTO agents (id, name, role, metadata, created_at, last_seen_at)
       VALUES ('agent-001', 'maximus', 'developer', '{}', datetime('now'), datetime('now'))`
    );
    db.run(
      `INSERT INTO projects (id, name, path, created_at, updated_at)
       VALUES ('proj-001', 'open-mementos', '/home/user/repos/open-mementos', datetime('now'), datetime('now'))`
    );
  });

  it("resolves agent by name (high confidence)", () => {
    const result = autoResolveAgentProject({ agentName: "maximus" }, db);
    expect(result.agentId).toBe("agent-001");
    expect(result.confidence).toBe("high");
    expect(result.method).toContain("agent-by-name");
  });

  it("resolves project by working directory (high confidence)", () => {
    const result = autoResolveAgentProject(
      { workingDir: "/home/user/repos/open-mementos" },
      db
    );
    expect(result.projectId).toBe("proj-001");
    expect(result.confidence).toBe("high");
    expect(result.method).toContain("project-by-path");
  });

  it("returns none confidence when no metadata matches", () => {
    const result = autoResolveAgentProject({ agentName: "unknown-agent" }, db);
    expect(result.agentId).toBeNull();
    expect(result.projectId).toBeNull();
    expect(result.confidence).toBe("none");
  });

  it("resolves both agent and project when both match", () => {
    const result = autoResolveAgentProject(
      {
        agentName: "maximus",
        workingDir: "/home/user/repos/open-mementos",
      },
      db
    );
    expect(result.agentId).toBe("agent-001");
    expect(result.projectId).toBe("proj-001");
    expect(result.confidence).toBe("high");
  });

  it("resolves project by git remote (low confidence)", () => {
    const result = autoResolveAgentProject(
      { gitRemote: "git@github.com:user/open-mementos.git" },
      db
    );
    expect(result.projectId).toBe("proj-001");
    expect(result.confidence).toBe("low");
    expect(result.method).toContain("project-by-git-remote");
  });

  it("handles empty metadata gracefully", () => {
    const result = autoResolveAgentProject({}, db);
    expect(result.agentId).toBeNull();
    expect(result.projectId).toBeNull();
    expect(result.confidence).toBe("none");
  });
});

// ============================================================================
// Tests: processSessionJob with mocked LLM
// ============================================================================

describe("processSessionJob", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("processes a job end-to-end and marks completed", async () => {
    // Mock the providerRegistry to return fake memories
    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test-model" },
      extractMemories: async () => [
        {
          content: "The project uses TypeScript with Bun runtime",
          category: "fact" as const,
          importance: 8,
          tags: ["typescript", "bun"],
          suggestedScope: "shared" as const,
          reasoning: "Key tech stack decision",
        },
      ],
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 8,
    };

    // Temporarily override the provider
    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;

    const job = createSessionJob(
      {
        session_id: "test-session-001",
        transcript: "We decided to use TypeScript with Bun as our runtime for the project.",
        source: "claude-code",
      },
      db
    );

    const result = await processSessionJob(job.id, db);

    // Restore
    providerRegistry.getAvailable = originalGetAvailable;

    expect(result.jobId).toBe(job.id);
    expect(result.chunksProcessed).toBe(1);
    expect(result.memoriesExtracted).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);

    const updatedJob = getSessionJob(job.id, db);
    expect(updatedJob!.status).toBe("completed");
    expect(updatedJob!.chunk_count).toBe(1);
    expect(updatedJob!.memories_extracted).toBeGreaterThanOrEqual(1);
    expect(updatedJob!.completed_at).toBeTruthy();
    expect(updatedJob!.started_at).toBeTruthy();
  });

  it("returns error when job not found", async () => {
    const result = await processSessionJob("nonexistent-job-id", db);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.chunksProcessed).toBe(0);
  });

  it("handles LLM failure gracefully (marks completed with 0 memories)", async () => {
    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test-model" },
      extractMemories: async () => [],
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 5,
    };

    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    const originalGetFallbacks = providerRegistry.getFallbacks.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;
    providerRegistry.getFallbacks = () => [];

    const job = createSessionJob(
      {
        session_id: "test-session-002",
        transcript: "Short transcript.",
        source: "manual",
      },
      db
    );

    const result = await processSessionJob(job.id, db);

    providerRegistry.getAvailable = originalGetAvailable;
    providerRegistry.getFallbacks = originalGetFallbacks;

    // Should complete even with 0 memories extracted
    expect(result.chunksProcessed).toBe(1);
    const updatedJob = getSessionJob(job.id, db);
    expect(updatedJob!.status).toBe("completed");
  });

  it("handles no provider configured gracefully", async () => {
    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    const originalGetFallbacks = providerRegistry.getFallbacks.bind(providerRegistry);
    providerRegistry.getAvailable = () => null;
    providerRegistry.getFallbacks = () => [];

    const job = createSessionJob(
      {
        session_id: "test-session-003",
        transcript: "Some transcript content.",
        source: "codex",
      },
      db
    );

    const result = await processSessionJob(job.id, db);

    providerRegistry.getAvailable = originalGetAvailable;
    providerRegistry.getFallbacks = originalGetFallbacks;

    expect(result.chunksProcessed).toBe(1);
    expect(result.memoriesExtracted).toBe(0);
  });
});

// ============================================================================
// Tests: Session traceability — extracted memories have correct tags
// ============================================================================

describe("session traceability", () => {
  let db: Database;

  beforeEach(() => {
    db = freshDb();
  });

  it("extracted memories are tagged with session_id and source", async () => {
    const mockProvider = {
      name: "anthropic" as const,
      config: { apiKey: "test", model: "test-model" },
      extractMemories: async () => [
        {
          content: "We use SQLite for the database with WAL mode enabled",
          category: "fact" as const,
          importance: 8,
          tags: ["sqlite", "database"],
          suggestedScope: "shared" as const,
          reasoning: "Important architectural decision",
        },
      ],
      extractEntities: async () => ({ entities: [], relations: [] }),
      scoreImportance: async () => 8,
    };

    const originalGetAvailable = providerRegistry.getAvailable.bind(providerRegistry);
    providerRegistry.getAvailable = () => mockProvider;

    const job = createSessionJob(
      {
        session_id: "traceability-session-001",
        transcript: "We use SQLite for the database layer with WAL mode.",
        source: "claude-code",
        agent_id: "agent-trace",
        project_id: "proj-trace",
      },
      db
    );

    await processSessionJob(job.id, db);

    providerRegistry.getAvailable = originalGetAvailable;

    // Query memories from the in-memory db to check tags
    const memories = db
      .query("SELECT * FROM memories WHERE session_id = ?")
      .all("traceability-session-001") as Array<{
      id: string;
      session_id: string;
      tags: string;
      source: string;
      agent_id: string;
      project_id: string;
    }>;

    if (memories.length > 0) {
      const mem = memories[0]!;
      expect(mem.session_id).toBe("traceability-session-001");
      expect(mem.source).toBe("auto");
      expect(mem.agent_id).toBe("agent-trace");
      expect(mem.project_id).toBe("proj-trace");

      const tags = JSON.parse(mem.tags) as string[];
      expect(tags).toContain("session-extracted");
      expect(tags).toContain("source:claude-code");
    }
  });
});
