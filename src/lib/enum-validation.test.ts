import { describe, expect, test } from "bun:test";
import { validateEnumField, validateMemoryEnums, formatEnumViolation } from "./enum-validation.js";
import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
} from "../types/index.js";

describe("enum validation", () => {
  test("rejects the category that caused the incident and names the alternatives", () => {
    const v = validateEnumField("category", "decision");
    expect(v).not.toBeNull();
    expect(v!.field).toBe("category");
    expect(v!.value).toBe("decision");
    expect(formatEnumViolation(v!)).toBe(
      'Invalid category: "decision". Allowed values: preference, fact, knowledge, history, procedural, resource.',
    );
  });

  test.each(MEMORY_CATEGORIES)("accepts canonical category %s", (c) => {
    expect(validateEnumField("category", c)).toBeNull();
  });

  test.each(MEMORY_SCOPES)("accepts canonical scope %s", (s) => {
    expect(validateEnumField("scope", s)).toBeNull();
  });

  test.each(MEMORY_SOURCES)("accepts canonical source %s", (s) => {
    expect(validateEnumField("source", s)).toBeNull();
  });

  test.each(MEMORY_STATUSES)("accepts canonical status %s", (s) => {
    expect(validateEnumField("status", s)).toBeNull();
  });

  test("absent or empty means 'use the default', not a violation", () => {
    expect(validateEnumField("category", undefined)).toBeNull();
    expect(validateEnumField("category", null)).toBeNull();
    expect(validateEnumField("category", "")).toBeNull();
  });

  test("non-enum columns are not policed here", () => {
    expect(validateEnumField("value", "anything at all")).toBeNull();
  });

  test("a non-string value is still a violation, not a crash", () => {
    const v = validateEnumField("category", 42);
    expect(v).not.toBeNull();
    expect(v!.value).toBe("42");
  });

  test("validateMemoryEnums scans a whole payload and reports the offender", () => {
    expect(validateMemoryEnums({ key: "k", value: "v" })).toBeNull();
    expect(validateMemoryEnums({ key: "k", value: "v", category: "knowledge" })).toBeNull();
    const v = validateMemoryEnums({ key: "k", value: "v", scope: "public" });
    expect(v!.field).toBe("scope");
  });

  test("a field only counts when present — an absent key is not a violation", () => {
    expect(validateMemoryEnums({ key: "k" })).toBeNull();
  });
});
