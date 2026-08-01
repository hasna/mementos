// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory, getMemory } from "../db/memories.js";
import { gdprErase } from "./gdpr.js";

// ============================================================================
// Regression: `gdprErase` built `%<identifier>%` with NO `ESCAPE` clause, so a
// `_` or `%` arriving in the caller-supplied identifier was a live SQL wildcard.
// `_` matches any single character, and UNDERSCORES ARE ORDINARY IN EMAIL
// LOCAL-PARTS — which is the exact input this function takes. Task dd80bbe1.
//
// Measured on main 8356cfa: erasing "first_last@example.com" redacted TWO rows,
// the second being a bystander whose value read "firstXlast@example.com".
//
// This is worse than the sibling defect fixed in #33, because `dry_run` and the
// erase share ONE SELECT — so the preview presented the same over-matched set as
// correct, and an operator who previewed first was CONFIRMED in the mistake.
// The parity test below pins that shared-query property in the RIGHT direction.
//
// Every assertion READS THE ROW BACK. Asserting on `erased_count` is exactly
// what passes against this bug: the count was truthful, it was the SET that was
// wrong. A receipt cannot distinguish "erased the right row" from "erased the
// right row AND a stranger".
//
// Both directions are asserted throughout. A bystander surviving proves nothing
// on its own — an escaper that over-escapes makes EVERY erase match nothing,
// which passes every "bystander survived" assertion while silently breaking
// GDPR erasure, and that failure is invisible until someone needs it to have
// worked. So each case also asserts its genuine target WAS redacted.
// ============================================================================

const REDACTED = "[REDACTED]";

/** Marker on every fixture, so a live-store contamination check can grep for it. */
const FIXTURE = "dd80bbe1-gdpr-fixture";

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

describe("gdprErase LIKE wildcard escaping (dd80bbe1)", () => {
  beforeEach(() => {
    resetDatabase();
    seq = 0;
  });

  it("`_` in the identifier does not redact a bystander differing at that position", () => {
    // vitellius's exact repro.
    const target = seed("Contact first_last@example.com for access");
    const bystander = seed("Contact firstXlast@example.com here");
    const unrelated = seed("nothing sensitive in this row");

    const result = gdprErase("first_last@example.com", {}, getDatabase());

    expect(valueOf(bystander)).toBe("Contact firstXlast@example.com here");
    expect(valueOf(unrelated)).toBe("nothing sensitive in this row");
    // Positive control: the genuine row IS still erased.
    expect(valueOf(target)).toBe(REDACTED);
    expect(result.memory_ids).toEqual([target]);
    expect(result.erased_count).toBe(1);
  });

  it("`%` in the identifier does not redact a bystander spanning that position", () => {
    const target = seed("billing a%b@example.com record");
    const bystander = seed("billing aZZZb@example.com record");

    const result = gdprErase("a%b@example.com", {}, getDatabase());

    expect(valueOf(bystander)).toBe("billing aZZZb@example.com record");
    expect(valueOf(target)).toBe(REDACTED);
    expect(result.memory_ids).toEqual([target]);
  });

  it("an ordinary identifier with no wildcard characters is still erased", () => {
    // The control that fails if the escaping is applied too eagerly.
    const target = seed("Contact alice@example.com for access");
    const unrelated = seed("Contact bob@example.com for access");

    const result = gdprErase("alice@example.com", {}, getDatabase());

    expect(valueOf(target)).toBe(REDACTED);
    expect(valueOf(unrelated)).toBe("Contact bob@example.com for access");
    expect(result.erased_count).toBe(1);
  });

  // A hand-rolled escaper that mishandles the ESCAPE CHARACTER ITSELF is the
  // classic failure, and introducing `ESCAPE '\'` is what creates the hazard:
  // before this fix a bare `\` was an ordinary literal to SQLite, after it a
  // bare `\` would consume the next character. Each case below is a POSITIVE
  // control — the row containing the literal identifier must still be erased.
  const backslashCases: Array<{ name: string; identifier: string }> = [
    { name: "a literal backslash", identifier: "a\\b@example.com" },
    { name: "a doubled backslash", identifier: "a\\\\b@example.com" },
    { name: "an escaped percent", identifier: "a\\%b@example.com" },
    { name: "an escaped underscore", identifier: "a\\_b@example.com" },
    { name: "a trailing lone backslash", identifier: "trailing-slash\\" },
    { name: "percent and underscore combined", identifier: "%_@example.com" },
  ];

  for (const { name, identifier } of backslashCases) {
    it(`erases the row for an identifier containing ${name}`, () => {
      const target = seed(`prefix ${identifier} suffix`);
      const unrelated = seed("an unrelated row with no identifier in it");

      const result = gdprErase(identifier, {}, getDatabase());

      expect(valueOf(target)).toBe(REDACTED);
      expect(valueOf(unrelated)).toBe("an unrelated row with no identifier in it");
      expect(result.memory_ids).toEqual([target]);
    });
  }

  it("`%_@example.com` does not sweep in rows it never named", () => {
    // Unescaped, `%_@example.com` matches ANY row ending in one character then
    // "@example.com" — so this bystander is the whole point.
    const target = seed("literal %_@example.com value");
    const bystander = seed("ordinary z@example.com value");

    const result = gdprErase("%_@example.com", {}, getDatabase());

    expect(valueOf(bystander)).toBe("ordinary z@example.com value");
    expect(valueOf(target)).toBe(REDACTED);
    expect(result.memory_ids).toEqual([target]);
  });

  it("the dry_run preview returns exactly the set the erase redacts", () => {
    // The property that was true in the WRONG direction: preview and action
    // share one SELECT, so the preview endorsed the over-match. Pin it here so
    // a future change cannot fix one path and leave the other over-matching.
    const target = seed("Contact first_last@example.com for access");
    const bystander = seed("Contact firstXlast@example.com here");

    const preview = gdprErase("first_last@example.com", { dry_run: true }, getDatabase());

    // A dry run redacts nothing.
    expect(valueOf(target)).toBe("Contact first_last@example.com for access");
    expect(valueOf(bystander)).toBe("Contact firstXlast@example.com here");

    const erase = gdprErase("first_last@example.com", {}, getDatabase());

    expect(erase.memory_ids).toEqual(preview.memory_ids);
    expect(erase.erased_count).toBe(preview.erased_count);
    expect(preview.memory_ids).toEqual([target]);
    // And the set the preview promised is the set that actually changed.
    expect(valueOf(target)).toBe(REDACTED);
    expect(valueOf(bystander)).toBe("Contact firstXlast@example.com here");
  });

  it("matches the identifier in tags and metadata without wildcard expansion", () => {
    // The identifier reaches five columns; the escaping must hold on all of
    // them, not only `value`.
    const db = getDatabase();
    const target = createMemory(
      {
        key: `${FIXTURE}-tagged`,
        value: "no address in the value",
        scope: "global",
        tags: ["first_last@example.com"],
        metadata: { owner: "first_last@example.com" },
      },
      "merge",
      db,
    ).id;
    const bystander = createMemory(
      {
        key: `${FIXTURE}-tagged-bystander`,
        value: "no address in the value",
        scope: "global",
        tags: ["firstXlast@example.com"],
        metadata: { owner: "firstXlast@example.com" },
      },
      "merge",
      db,
    ).id;

    const result = gdprErase("first_last@example.com", {}, db);

    expect(result.memory_ids).toEqual([target]);
    expect(getMemory(bystander, db)!.tags).toEqual(["firstXlast@example.com"]);
    expect(getMemory(target, db)!.value).toBe(REDACTED);
  });
});
