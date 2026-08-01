// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import {
  createMemory,
  getMemory,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
} from "./memories.js";
import { MemoryNotFoundError } from "../types/index.js";
import type { CreateMemoryInput } from "../types/index.js";

// ============================================================================
// Regression: a PARTIAL (prefix) id must mutate the row it resolves to, or the
// call must fail loudly. Task 3982e7e0.
//
// updateMemory resolved a partial id for the READ (getMemory -> resolvePartialId)
// but then bound the RAW, unresolved id into `UPDATE ... WHERE id = ?`. That
// matches zero rows, and the confirmation re-read resolved the prefix a second
// time and handed back the UNCHANGED row — which the caller then reported as a
// successful write. Silent data loss with a success receipt.
//
// It only bit through the HTTP API: the CLI pre-resolves ids in local mode, but
// short-circuits resolution in api mode and passes the partial to the server,
// which calls updateMemory with it. Hence every assertion here reads the row
// BACK. Asserting the return value alone is what passed against the bug.
// ============================================================================

function seed(overrides: Partial<CreateMemoryInput> = {}) {
  return createMemory({
    key: `partial-id-${Math.random().toString(36).slice(2, 10)}`,
    value: "ORIGINAL",
    ...overrides,
  } as CreateMemoryInput);
}

/** The 8-char form that `search`, `recall` and `save` print to the operator. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

beforeEach(() => {
  resetDatabase();
  getDatabase();
});

describe("updateMemory with a partial id", () => {
  it("writes the new value and increments the version", () => {
    const created = seed({ value: "ORIGINAL" } as Partial<CreateMemoryInput>);

    updateMemory(shortId(created.id), {
      version: created.version,
      value: "REPLACEMENT",
    });

    // Read back from the store — never trust the returned object.
    const after = getMemory(created.id);
    expect(after?.value).toBe("REPLACEMENT");
    expect(after?.version).toBe(created.version + 1);
  });

  it("moves updated_at", async () => {
    const created = seed();
    await Bun.sleep(2);

    updateMemory(shortId(created.id), {
      version: created.version,
      value: "REPLACEMENT",
    });

    const after = getMemory(created.id);
    expect(after?.updated_at).not.toBe(created.updated_at);
  });

  // Every field flag `mementos update` exposes gets its own read-back
  // assertion. Three of these were measured no-ops on the live fleet; the rest
  // were never tested by anyone, and "three of six" is not a boundary.
  // (`update` has no --key flag, so there is no rename path to cover here.)
  describe("every updatable field lands", () => {
    it("--value", () => {
      const m = seed({ value: "ORIGINAL" } as Partial<CreateMemoryInput>);
      updateMemory(shortId(m.id), { version: m.version, value: "NEW_VALUE" });
      expect(getMemory(m.id)?.value).toBe("NEW_VALUE");
    });

    it("--importance", () => {
      const m = seed({ importance: 5 } as Partial<CreateMemoryInput>);
      updateMemory(shortId(m.id), { version: m.version, importance: 9 });
      expect(getMemory(m.id)?.importance).toBe(9);
    });

    it("--tags", () => {
      const m = seed();
      updateMemory(shortId(m.id), { version: m.version, tags: ["alpha", "beta"] });
      expect(getMemory(m.id)?.tags).toEqual(["alpha", "beta"]);
    });

    it("--summary", () => {
      const m = seed();
      updateMemory(shortId(m.id), { version: m.version, summary: "a summary" });
      expect(getMemory(m.id)?.summary).toBe("a summary");
    });

    it("--pin / --unpin", () => {
      const m = seed();
      updateMemory(shortId(m.id), { version: m.version, pinned: true });
      expect(getMemory(m.id)?.pinned).toBe(true);

      const pinned = getMemory(m.id)!;
      updateMemory(shortId(m.id), { version: pinned.version, pinned: false });
      expect(getMemory(m.id)?.pinned).toBe(false);
    });

    it("--category", () => {
      const m = seed({ category: "knowledge" } as Partial<CreateMemoryInput>);
      updateMemory(shortId(m.id), { version: m.version, category: "fact" });
      expect(getMemory(m.id)?.category).toBe("fact");
    });

    it("--scope", () => {
      const m = seed({ scope: "private" } as Partial<CreateMemoryInput>);
      updateMemory(shortId(m.id), { version: m.version, scope: "shared" });
      expect(getMemory(m.id)?.scope).toBe("shared");
    });

    it("--status", () => {
      const m = seed();
      updateMemory(shortId(m.id), { version: m.version, status: "archived" });
      expect(getMemory(m.id)?.status).toBe("archived");
    });
  });

  it("mutates only the row the prefix resolves to", () => {
    const target = seed({ value: "TARGET" } as Partial<CreateMemoryInput>);
    const bystander = seed({ value: "BYSTANDER" } as Partial<CreateMemoryInput>);

    updateMemory(shortId(target.id), { version: target.version, value: "CHANGED" });

    expect(getMemory(target.id)?.value).toBe("CHANGED");
    expect(getMemory(bystander.id)?.value).toBe("BYSTANDER");
    expect(getMemory(bystander.id)?.version).toBe(bystander.version);
  });

  it("throws rather than reporting success when the id matches nothing", () => {
    expect(() =>
      updateMemory("ffffffff", { version: 1, value: "NEVER" }),
    ).toThrow(MemoryNotFoundError);
  });
});

describe("deleteMemory with a partial id", () => {
  // Same root cause, opposite symptom: `forget <short-id>` bound the raw
  // partial into `DELETE ... WHERE id = ?`, deleted nothing, and reported
  // "No memory found" — a false negative about the store, from an id the CLI
  // had just printed.
  it("deletes the row the prefix resolves to", () => {
    const created = seed();

    expect(deleteMemory(shortId(created.id))).toBe(true);
    expect(getMemory(created.id)).toBeNull();
  });

  it("leaves other rows alone", () => {
    const target = seed();
    const bystander = seed();

    deleteMemory(shortId(target.id));

    expect(getMemory(target.id)).toBeNull();
    expect(getMemory(bystander.id)).not.toBeNull();
  });

  it("reports false for an id that matches nothing", () => {
    expect(deleteMemory("ffffffff")).toBe(false);
  });
});

describe("bulkDeleteMemories with partial ids", () => {
  // `WHERE id IN (...)` is an exact match, so a partial matched nothing and the
  // caller was told "0 memories affected" at rc=0 while the row survived.
  // Called out separately because, unlike the rest of this file, no server
  // redeploy repairs it — the bulk path would have stayed broken permanently
  // after the deploy that fixed everything else here.
  it("deletes the rows the prefixes resolve to", () => {
    const a = seed();
    const b = seed();

    expect(bulkDeleteMemories([shortId(a.id), shortId(b.id)])).toBe(2);
    expect(getMemory(a.id)).toBeNull();
    expect(getMemory(b.id)).toBeNull();
  });

  it("mixes full and partial ids without dropping either", () => {
    const partial = seed();
    const full = seed();

    expect(bulkDeleteMemories([shortId(partial.id), full.id])).toBe(2);
    expect(getMemory(partial.id)).toBeNull();
    expect(getMemory(full.id)).toBeNull();
  });

  it("leaves rows the prefixes do not resolve to alone", () => {
    const target = seed();
    const bystander = seed();

    expect(bulkDeleteMemories([shortId(target.id)])).toBe(1);
    expect(getMemory(target.id)).toBeNull();
    expect(getMemory(bystander.id)).not.toBeNull();
  });

  it("counts nothing for an id that matches nothing", () => {
    const survivor = seed();

    expect(bulkDeleteMemories(["ffffffff"])).toBe(0);
    expect(getMemory(survivor.id)).not.toBeNull();
  });
});
