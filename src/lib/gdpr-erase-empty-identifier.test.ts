// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { gdprErase } from "./gdpr.js";

// ============================================================================
// Regression: `gdprErase("")` REDACTED THE ENTIRE STORE. Task 80b3c695.
//
// The identifier is interpolated into `%${escapeLikePrefix(identifier)}%`. On an
// empty string that yields the pattern `%%`, which matches EVERY row. Escaping
// cannot help here and the #34 fix did not touch it — there is nothing to
// escape. Measured on ff2943f5 (post-#34): 3 of 3 seeded rows redacted.
//
// Reachable over the wire: the `memory_gdpr_erase` MCP tool declared
// `identifier: z.string()` with no `.min(1)`, on an operation its own
// description calls IRREVERSIBLE.
//
// `dry_run` returns from the SAME SELECT, so the preview reported "would erase
// N" for the whole store — an operator who previewed first was CONFIRMED in the
// mistake rather than warned by it.
//
// The remedy has precedent IN THIS FILE'S OWN DEPENDENCY: `resolvePartialId` in
// `src/db/database.ts` carries `if (partialId === "") return null;` with a
// comment naming this exact hazard, ~25 lines above the `escapeLikePrefix` that
// `gdpr.ts` imports. The NON-DESTRUCTIVE lookup had the guard; the DESTRUCTIVE
// erase did not.
//
// Every assertion READS THE ROW BACK. Asserting on `erased_count` is precisely
// what a mass-redaction bug survives when the count is truthful — the count was
// never the wrong part.
//
// Both directions are asserted. "Nothing was erased" passes trivially against a
// guard that rejects EVERYTHING, so the ordinary-identifier control below must
// keep passing or the fix has broken GDPR erasure while looking safe.
// ============================================================================

const REDACTED = "[REDACTED]";

/** Marker on every fixture, so a live-store contamination check can grep for it. */
const FIXTURE = "80b3c695-gdpr-fixture";

let seq = 0;

function seed(value: string): string {
  return createMemory(
    { key: `${FIXTURE}-${seq++}`, value, scope: "global" },
    "merge",
    getDatabase(),
  ).id;
}

function valueOf(id: string): string {
  return getMemory(id, getDatabase())!.value;
}

/** The inputs that collapse to the `%%` pattern. */
const emptyish: Array<{ name: string; identifier: string }> = [
  { name: "an empty string", identifier: "" },
  { name: "a single space", identifier: " " },
  { name: "whitespace only", identifier: "   " },
  { name: "a tab", identifier: "\t" },
  { name: "a newline", identifier: "\n" },
];

describe("gdprErase rejects an empty identifier (80b3c695)", () => {
  beforeEach(() => {
    resetDatabase();
    seq = 0;
  });

  // The call is made inside a try/catch rather than under `expect(...).toThrow`
  // DELIBERATELY. Under `toThrow`, a missing throw fails the assertion and the
  // row-state expectations below it never execute — so the test would report
  // "did not throw" while saying nothing about the store, and the mass redaction
  // (the actual defect) would go unmeasured. Swallowing first makes the SURVIVING
  // ROWS the primary evidence, and pins the guard's behaviour even if a later
  // change chose to return an empty result instead of throwing.
  function eraseSwallowing(
    identifier: string,
    options: Parameters<typeof gdprErase>[1] = {},
  ): unknown {
    try {
      gdprErase(identifier, options, getDatabase());
      return null;
    } catch (e) {
      return e;
    }
  }

  for (const { name, identifier } of emptyish) {
    it(`leaves every row intact when the identifier is ${name}`, () => {
      const a = seed("Contact alice@example.com for access");
      const b = seed("billing record for bob@example.com");
      const c = seed("nothing sensitive in this row");

      const thrown = eraseSwallowing(identifier);

      // The store is the assertion, not the return value.
      expect(valueOf(a)).toBe("Contact alice@example.com for access");
      expect(valueOf(b)).toBe("billing record for bob@example.com");
      expect(valueOf(c)).toBe("nothing sensitive in this row");
      // And it refused loudly rather than silently doing nothing.
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/identifier/i);
    });

    it(`refuses the dry_run preview for ${name} rather than previewing the whole store`, () => {
      // The preview shares one SELECT with the erase. A guard that covered only
      // the erase path would leave the preview answering "would erase 3" for a
      // store of 3 — which is the sentence that talks an operator into
      // confirming. Both paths must refuse.
      const a = seed("Contact alice@example.com for access");
      const b = seed("billing record for bob@example.com");

      const thrown = eraseSwallowing(identifier, { dry_run: true });

      expect(valueOf(a)).toBe("Contact alice@example.com for access");
      expect(valueOf(b)).toBe("billing record for bob@example.com");
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/identifier/i);
    });
  }

  it("still erases the named row for an ordinary identifier", () => {
    // POSITIVE CONTROL on the guard itself. Without this, a guard that rejected
    // every identifier would pass every assertion above while silently breaking
    // the feature — and that breakage is invisible until someone needs an
    // erasure to have worked.
    const target = seed("Contact alice@example.com for access");
    const unrelated = seed("Contact bob@example.com for access");

    const result = gdprErase("alice@example.com", {}, getDatabase());

    expect(valueOf(target)).toBe(REDACTED);
    expect(valueOf(unrelated)).toBe("Contact bob@example.com for access");
    expect(result.erased_count).toBe(1);
    expect(result.memory_ids).toEqual([target]);
  });

  it("still erases an identifier whose own edges are whitespace", () => {
    // The emptiness check must TRIM to decide, but must NOT trim the value it
    // matches with — trimming the match would silently change which rows a
    // legitimate identifier reaches.
    const target = seed("prefix< alice@example.com >suffix");
    const unrelated = seed("prefix<alice@example.com>suffix");

    const result = gdprErase(" alice@example.com ", {}, getDatabase());

    expect(valueOf(target)).toBe(REDACTED);
    expect(valueOf(unrelated)).toBe("prefix<alice@example.com>suffix");
    expect(result.memory_ids).toEqual([target]);
  });

  it("an identifier that matches nothing is a no-op, not an error", () => {
    // The guard rejects an ABSENT identifier, never an unmatched one. A
    // legitimate erase request for PII we do not hold must still return 0.
    const a = seed("Contact alice@example.com for access");

    const result = gdprErase("nobody@example.com", {}, getDatabase());

    expect(result.erased_count).toBe(0);
    expect(result.memory_ids).toEqual([]);
    expect(valueOf(a)).toBe("Contact alice@example.com for access");
  });

  it("an empty identifier is rejected even when scoped to a project", () => {
    // `project_id` narrows the blast radius but does not remove it: `%%` still
    // matches every row in that project.
    const a = seed("Contact alice@example.com for access");

    const thrown = eraseSwallowing("", { project_id: "some-project" });

    expect(valueOf(a)).toBe("Contact alice@example.com for access");
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/identifier/i);
  });
});
