// Set in-memory DB and remove API key before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";
delete process.env["ANTHROPIC_API_KEY"];

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
  // synthesizeProfile (with API key → LLM path)
  // --------------------------------------------------------------------------
  describe("synthesizeProfile (with API key)", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env["ANTHROPIC_API_KEY"];
    });

    function seedMemory() {
      const db = getDatabase();
      createMemory(
        {
          key: "prefer-ts",
          value: "TypeScript always",
          category: "preference",
          scope: "shared",
          importance: 9,
        },
        "merge",
        db
      );
      createMemory(
        {
          key: "stack-db",
          value: "SQLite via bun:sqlite",
          category: "fact",
          scope: "shared",
          importance: 8,
        },
        "merge",
        db
      );
    }

    it("calls LLM and returns synthesized profile on success", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      globalThis.fetch = async (_url: any, opts: any) => {
        // Verify the request shape
        const body = JSON.parse(opts.body);
        expect(body.model).toBe("claude-haiku-4-5-20251001");
        expect(body.max_tokens).toBe(500);
        expect(body.messages[0].content).toContain("2 memories");

        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "## Synthesized Profile\n- Uses TypeScript\n- SQLite DB" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const result = await synthesizeProfile({ force_refresh: true });
      expect(result).not.toBeNull();
      expect(result!.from_cache).toBe(false);
      expect(result!.profile).toContain("Synthesized Profile");
      expect(result!.memory_count).toBe(2);
    });

    it("sorts memories by importance (highest first) in LLM request", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      let capturedBody: any;
      globalThis.fetch = async (_url: any, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "profile text" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      await synthesizeProfile({ force_refresh: true });
      // importance 9 (prefer-ts) should come before importance 8 (stack-db)
      const userContent = capturedBody.messages[0].content;
      const tsIndex = userContent.indexOf("prefer-ts");
      const dbIndex = userContent.indexOf("stack-db");
      expect(tsIndex).toBeLessThan(dbIndex);
    });

    it("returns null when API responds with non-ok status", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      globalThis.fetch = async () => {
        return new Response("Unauthorized", { status: 401 });
      };

      const result = await synthesizeProfile({ force_refresh: true });
      expect(result).toBeNull();
    });

    it("returns null when API response has no content text", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ content: [] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const result = await synthesizeProfile({ force_refresh: true });
      expect(result).toBeNull();
    });

    it("returns null when API response content text is empty string", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      globalThis.fetch = async () => {
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "   " }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const result = await synthesizeProfile({ force_refresh: true });
      expect(result).toBeNull();
    });

    it("returns null when fetch throws a network error", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      globalThis.fetch = async () => {
        throw new Error("Network failure");
      };

      const result = await synthesizeProfile({ force_refresh: true });
      expect(result).toBeNull();
    });

    it("saves synthesized profile to DB (cached on next call)", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "LLM Profile Result" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      const first = await synthesizeProfile({ force_refresh: true });
      expect(first).not.toBeNull();
      expect(first!.profile).toBe("LLM Profile Result");
      expect(fetchCount).toBe(1);

      // Remove API key so we know it comes from cache, not fallback
      delete process.env["ANTHROPIC_API_KEY"];

      const second = await synthesizeProfile({});
      expect(second).not.toBeNull();
      expect(second!.from_cache).toBe(true);
      expect(second!.profile).toBe("LLM Profile Result");
      // fetch should not have been called again
      expect(fetchCount).toBe(1);
    });

    it("sends correct headers including api key and anthropic-version", async () => {
      process.env["ANTHROPIC_API_KEY"] = "test-key-fake";
      seedMemory();

      let capturedHeaders: any;
      globalThis.fetch = async (_url: any, opts: any) => {
        capturedHeaders = opts.headers;
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "profile" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      };

      await synthesizeProfile({ force_refresh: true });
      expect(capturedHeaders["x-api-key"]).toBe("test-key-fake");
      expect(capturedHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(capturedHeaders["content-type"]).toBe("application/json");
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
