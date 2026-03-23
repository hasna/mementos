// Set in-memory DB and remove API key before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";
delete process.env["ANTHROPIC_API_KEY"];

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { createMemory, getMemoryByKey } from "../db/memories.js";
import {
  synthesizeProfile,
  getProfileKey,
  markProfileStale,
} from "./profile-synthesizer.js";

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  // Reset the singleton so getDatabase() creates a fresh :memory: DB
  resetDatabase();
  // Force DB initialization (runs migrations, creates all tables)
  getDatabase();
});

// ============================================================================
// Tests
// ============================================================================

describe("profile-synthesizer", () => {
  // --------------------------------------------------------------------------
  // getProfileKey
  // --------------------------------------------------------------------------
  describe("getProfileKey", () => {
    it("generates correct key for project scope", () => {
      const key = getProfileKey("project", "proj-123");
      expect(key).toBe("_profile_project_proj-123");
    });

    it("generates correct key for agent scope", () => {
      const key = getProfileKey("agent", "agent-456");
      expect(key).toBe("_profile_agent_agent-456");
    });

    it("generates correct key for global scope", () => {
      const key = getProfileKey("global", "global");
      expect(key).toBe("_profile_global_global");
    });
  });

  // --------------------------------------------------------------------------
  // synthesizeProfile (no API key → fallback path)
  // --------------------------------------------------------------------------
  describe("synthesizeProfile (no API key)", () => {
    it("returns fallback profile when no API key", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "preferred-lang",
          value: "TypeScript",
          category: "preference",
          scope: "shared",
          importance: 8,
        },
        "merge",
        db
      );

      const result = await synthesizeProfile({});
      expect(result).not.toBeNull();
      expect(result!.from_cache).toBe(false);
      expect(result!.profile).toContain("## Profile");
      expect(result!.profile).toContain("preferred-lang: TypeScript");
      expect(result!.memory_count).toBe(1);
    });

    it("returns null when no memories exist", async () => {
      const result = await synthesizeProfile({});
      expect(result).toBeNull();
    });

    it("includes preference memories in fallback", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "prefer-bun",
          value: "Always use bun over npm",
          category: "preference",
          scope: "shared",
          importance: 9,
        },
        "merge",
        db
      );
      createMemory(
        {
          key: "prefer-dark-mode",
          value: "Dark mode everywhere",
          category: "preference",
          scope: "shared",
          importance: 7,
        },
        "merge",
        db
      );

      const result = await synthesizeProfile({});
      expect(result).not.toBeNull();
      expect(result!.profile).toContain("prefer-bun: Always use bun over npm");
      expect(result!.profile).toContain(
        "prefer-dark-mode: Dark mode everywhere"
      );
      expect(result!.memory_count).toBe(2);
    });

    it("includes fact memories in fallback", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "stack-db",
          value: "SQLite with bun:sqlite",
          category: "fact",
          scope: "shared",
          importance: 8,
        },
        "merge",
        db
      );

      const result = await synthesizeProfile({});
      expect(result).not.toBeNull();
      expect(result!.profile).toContain("stack-db: SQLite with bun:sqlite");
      expect(result!.memory_count).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Cache behavior
  // --------------------------------------------------------------------------
  describe("cache behavior", () => {
    it("returns cached profile on second call", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "pref-cache-test",
          value: "Cache me",
          category: "preference",
          scope: "shared",
          importance: 7,
        },
        "merge",
        db
      );

      // First call — generates and saves profile
      const first = await synthesizeProfile({});
      expect(first).not.toBeNull();
      expect(first!.from_cache).toBe(false);

      // Second call — should return from cache
      const second = await synthesizeProfile({});
      expect(second).not.toBeNull();
      expect(second!.from_cache).toBe(true);
      expect(second!.profile).toBe(first!.profile);
    });

    it("force_refresh bypasses cache", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "pref-force-test",
          value: "Force me",
          category: "preference",
          scope: "shared",
          importance: 7,
        },
        "merge",
        db
      );

      // First call — generates profile
      const first = await synthesizeProfile({});
      expect(first).not.toBeNull();
      expect(first!.from_cache).toBe(false);

      // Second call with force_refresh — should regenerate
      const second = await synthesizeProfile({ force_refresh: true });
      expect(second).not.toBeNull();
      expect(second!.from_cache).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // markProfileStale
  // --------------------------------------------------------------------------
  describe("markProfileStale", () => {
    it("marks profile metadata as stale", async () => {
      const db = getDatabase();
      createMemory(
        {
          key: "pref-stale-test",
          value: "Stale me",
          category: "preference",
          scope: "shared",
          importance: 7,
        },
        "merge",
        db
      );

      // Generate a cached profile
      const first = await synthesizeProfile({});
      expect(first).not.toBeNull();
      expect(first!.from_cache).toBe(false);

      // Verify it's cached
      const cached = await synthesizeProfile({});
      expect(cached).not.toBeNull();
      expect(cached!.from_cache).toBe(true);

      // Mark stale
      markProfileStale();

      // Next call should regenerate (stale flag bypasses cache)
      const refreshed = await synthesizeProfile({});
      expect(refreshed).not.toBeNull();
      expect(refreshed!.from_cache).toBe(false);
    });
  });
});
