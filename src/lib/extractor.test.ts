process.env.MEMENTOS_DB_PATH = ":memory:";

import { describe, test, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "../db/database.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";
import { extractEntities, type ExtractedEntity } from "./extractor.js";
import type { Memory } from "../types/index.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "test-id",
    key: overrides.key ?? "test-key",
    value: overrides.value ?? "test-value",
    category: "knowledge",
    scope: "shared",
    summary: overrides.summary ?? null,
    tags: [],
    importance: 5,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    accessed_at: null,
  };
}

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

describe("extractEntities", () => {
  describe("file path extraction", () => {
    test("extracts absolute file paths", () => {
      const memory = makeMemory({ value: "Check /usr/local/bin/mementos.ts for details" });
      const entities = extractEntities(memory);
      const files = entities.filter((e) => e.type === "file");
      expect(files.length).toBeGreaterThanOrEqual(1);
      expect(files.some((e) => e.name.includes("mementos.ts"))).toBe(true);
      expect(files[0]!.confidence).toBe(0.9);
    });

    test("extracts relative file paths", () => {
      const memory = makeMemory({ value: "Edit src/lib/extractor.ts to fix the bug" });
      const entities = extractEntities(memory);
      const files = entities.filter((e) => e.type === "file");
      expect(files.some((e) => e.name.includes("src/lib/extractor.ts"))).toBe(true);
    });

    test("extracts paths with ./ prefix", () => {
      const memory = makeMemory({ value: "Run ./scripts/build.sh" });
      const entities = extractEntities(memory);
      const files = entities.filter((e) => e.type === "file");
      expect(files.some((e) => e.name.includes("scripts/build.sh"))).toBe(true);
    });

    test("extracts paths with ~/ prefix", () => {
      const memory = makeMemory({ value: "Config at ~/config/settings.json" });
      const entities = extractEntities(memory);
      const files = entities.filter((e) => e.type === "file");
      expect(files.some((e) => e.name.includes("config/settings.json"))).toBe(true);
    });
  });

  describe("URL extraction", () => {
    test("extracts https URLs", () => {
      const memory = makeMemory({ value: "API docs at https://api.example.com/v1/docs" });
      const entities = extractEntities(memory);
      const urls = entities.filter((e) => e.type === "api");
      expect(urls.length).toBeGreaterThanOrEqual(1);
      expect(urls[0]!.name).toBe("https://api.example.com/v1/docs");
      expect(urls[0]!.confidence).toBe(0.8);
    });

    test("extracts http URLs", () => {
      const memory = makeMemory({ value: "Server at http://localhost:3000/health" });
      const entities = extractEntities(memory);
      const urls = entities.filter((e) => e.type === "api");
      expect(urls.some((e) => e.name.includes("http://localhost:3000/health"))).toBe(true);
    });
  });

  describe("npm package extraction", () => {
    test("extracts @scope/name packages", () => {
      const memory = makeMemory({ value: "Install @hasnaxyz/mementos for memory" });
      const entities = extractEntities(memory);
      const pkgs = entities.filter((e) => e.type === "tool" && e.name.startsWith("@"));
      expect(pkgs.length).toBeGreaterThanOrEqual(1);
      expect(pkgs[0]!.name).toBe("@hasnaxyz/mementos");
      expect(pkgs[0]!.confidence).toBe(0.85);
    });

    test("extracts multiple packages", () => {
      const memory = makeMemory({ value: "Uses @types/node and @modelcontextprotocol/sdk" });
      const entities = extractEntities(memory);
      const pkgs = entities.filter((e) => e.type === "tool" && e.name.startsWith("@"));
      expect(pkgs.length).toBe(2);
    });
  });

  describe("technology keyword extraction", () => {
    test("extracts known technology keywords", () => {
      const memory = makeMemory({ value: "This project uses typescript and bun with sqlite" });
      const entities = extractEntities(memory);
      const tools = entities.filter((e) => e.type === "tool" && e.confidence === 0.7);
      const names = tools.map((e) => e.name);
      expect(names).toContain("typescript");
      expect(names).toContain("bun");
      expect(names).toContain("sqlite");
    });

    test("matches whole words only", () => {
      const memory = makeMemory({ value: "the bundle was large" });
      const entities = extractEntities(memory);
      // "bun" should not match inside "bundle"
      const tools = entities.filter((e) => e.name === "bun");
      expect(tools.length).toBe(0);
    });

    test("case insensitive matching", () => {
      const memory = makeMemory({ value: "TypeScript is great" });
      const entities = extractEntities(memory);
      expect(entities.some((e) => e.name === "typescript")).toBe(true);
    });
  });

  describe("PascalCase extraction", () => {
    test("extracts PascalCase identifiers", () => {
      const memory = makeMemory({ value: "The MemoryManager handles all storage" });
      const entities = extractEntities(memory);
      const concepts = entities.filter((e) => e.type === "concept");
      expect(concepts.some((e) => e.name === "memorymanager")).toBe(true);
      expect(concepts[0]!.confidence).toBe(0.5);
    });

    test("extracts multi-word PascalCase", () => {
      const memory = makeMemory({ value: "Use EntityNotFoundError for missing entities" });
      const entities = extractEntities(memory);
      const concepts = entities.filter((e) => e.type === "concept");
      expect(concepts.some((e) => e.name === "entitynotfounderror")).toBe(true);
    });

    test("does not extract single PascalCase word", () => {
      // "Memory" alone is not PascalCase with two humps
      const memory = makeMemory({ value: "Memory is important" });
      const entities = extractEntities(memory);
      const concepts = entities.filter((e) => e.type === "concept" && e.name === "memory");
      expect(concepts.length).toBe(0);
    });
  });

  describe("known agent matching", () => {
    test("matches registered agent names", () => {
      const db = getDatabase(":memory:");
      registerAgent("maximus", undefined, "Test agent", undefined, db);

      const memory = makeMemory({ value: "maximus deployed the fix" });
      const entities = extractEntities(memory, db);
      const persons = entities.filter((e) => e.type === "person");
      expect(persons.length).toBe(1);
      expect(persons[0]!.name).toBe("maximus");
      expect(persons[0]!.confidence).toBe(0.95);
    });

    test("matches agent names case-insensitively", () => {
      const db = getDatabase(":memory:");
      registerAgent("Cassius", undefined, "Test agent", undefined, db);

      const memory = makeMemory({ value: "cassius reviewed the PR" });
      const entities = extractEntities(memory, db);
      expect(entities.some((e) => e.type === "person" && e.name === "cassius")).toBe(true);
    });
  });

  describe("known project matching", () => {
    test("matches registered project names", () => {
      const db = getDatabase(":memory:");
      registerProject("mementos", "/home/user/mementos", undefined, undefined, db);

      const memory = makeMemory({ value: "The mementos project needs a refactor" });
      const entities = extractEntities(memory, db);
      const projects = entities.filter((e) => e.type === "project");
      expect(projects.length).toBe(1);
      expect(projects[0]!.name).toBe("mementos");
      expect(projects[0]!.confidence).toBe(0.95);
    });
  });

  describe("deduplication", () => {
    test("keeps highest confidence when same entity found in key and value", () => {
      const db = getDatabase(":memory:");
      registerAgent("aurelius", undefined, "Test agent", undefined, db);

      // "aurelius" appears in both key and value; agent match (0.95) should win
      const memory = makeMemory({
        key: "aurelius-preference",
        value: "aurelius likes vim",
      });
      const entities = extractEntities(memory, db);
      const matches = entities.filter((e) => e.name === "aurelius");
      expect(matches.length).toBe(1);
      expect(matches[0]!.confidence).toBe(0.95);
    });

    test("deduplicates npm package found in multiple fields", () => {
      const memory = makeMemory({
        key: "setup @hasnaxyz/todos",
        value: "Install @hasnaxyz/todos globally",
      });
      const entities = extractEntities(memory);
      const pkgs = entities.filter((e) => e.name === "@hasnaxyz/todos");
      expect(pkgs.length).toBe(1);
    });
  });

  describe("confidence ordering", () => {
    test("results are sorted by confidence descending", () => {
      const db = getDatabase(":memory:");
      registerAgent("brutus", undefined, "Test agent", undefined, db);

      const memory = makeMemory({
        value: "brutus fixed src/lib/extractor.ts using typescript and MemoryManager at https://example.com",
      });
      const entities = extractEntities(memory, db);
      for (let i = 1; i < entities.length; i++) {
        expect(entities[i]!.confidence).toBeLessThanOrEqual(entities[i - 1]!.confidence);
      }
    });
  });

  describe("edge cases", () => {
    test("empty memory returns empty array", () => {
      const memory = makeMemory({ key: "", value: "" });
      const entities = extractEntities(memory);
      expect(entities).toEqual([]);
    });

    test("minimal memory with short strings returns empty array", () => {
      const memory = makeMemory({ key: "ab", value: "cd" });
      const entities = extractEntities(memory);
      expect(entities).toEqual([]);
    });

    test("filters out entities shorter than 3 characters", () => {
      // "go" is a tech keyword but < 3 chars, should be filtered
      const memory = makeMemory({ value: "We use go for backends" });
      const entities = extractEntities(memory);
      expect(entities.some((e) => e.name === "go")).toBe(false);
    });
  });

  describe("mixed content extraction", () => {
    test("extracts multiple entity types from rich content", () => {
      const db = getDatabase(":memory:");
      registerAgent("seneca", undefined, "Test agent", undefined, db);
      registerProject("alumia", "/home/user/alumia", undefined, undefined, db);

      const memory = makeMemory({
        value:
          "seneca deployed alumia using typescript at https://alumia.app with @hasnaxyz/mementos in src/db/database.ts via MemoryManager",
      });
      const entities = extractEntities(memory, db);

      const types = new Set(entities.map((e) => e.type));
      expect(types.has("person")).toBe(true); // seneca
      expect(types.has("project")).toBe(true); // alumia
      expect(types.has("tool")).toBe(true); // typescript, @hasnaxyz/mementos
      expect(types.has("api")).toBe(true); // https://alumia.app
      expect(types.has("file")).toBe(true); // src/db/database.ts
      expect(types.has("concept")).toBe(true); // MemoryManager
    });

    test("searches summary field too", () => {
      const memory = makeMemory({
        key: "test",
        value: "nothing here",
        summary: "Uses typescript and react",
      });
      const entities = extractEntities(memory);
      expect(entities.some((e) => e.name === "typescript")).toBe(true);
      expect(entities.some((e) => e.name === "react")).toBe(true);
    });
  });
});
