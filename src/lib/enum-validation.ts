// ============================================================================
// Enum validation for the memory columns that carry a DB CHECK constraint.
//
// Why this exists: an out-of-enum value used to travel all the way from the CLI
// to SQLite, where the CHECK constraint raised SQLITE_CONSTRAINT_CHECK, which
// the server's blanket handler turned into a bare `500 Internal server error`
// naming neither the field nor the accepted values. A bad `--category` is a
// caller mistake, so it must be reported as a 400 (or rejected client-side
// before the request is spent), never as a server fault.
//
// The accepted values come from the canonical arrays in ../types/index.js, so
// this validator cannot drift from the string-union types.
// ============================================================================

import {
  MEMORY_CATEGORIES,
  MEMORY_SCOPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
} from "../types/index.js";

/** A field whose value is constrained both by the type system and a DB CHECK. */
const ENUM_FIELDS: Record<string, readonly string[]> = {
  category: MEMORY_CATEGORIES,
  scope: MEMORY_SCOPES,
  source: MEMORY_SOURCES,
  status: MEMORY_STATUSES,
};

export interface EnumViolation {
  field: string;
  value: string;
  allowed: readonly string[];
}

/** Human-readable, actionable rejection message naming the field and the accepted set. */
export function formatEnumViolation(v: EnumViolation): string {
  return `Invalid ${v.field}: "${v.value}". Allowed values: ${v.allowed.join(", ")}.`;
}

/**
 * Validate one enum-constrained field. Returns the violation, or `null` when
 * the value is acceptable. `undefined`/`null` are acceptable — they mean "leave
 * the column at its default", which is a separate concern from a bad value.
 */
export function validateEnumField(field: string, value: unknown): EnumViolation | null {
  const allowed = ENUM_FIELDS[field];
  if (!allowed) return null; // not an enum-constrained column
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && allowed.includes(value)) return null;
  return { field, value: String(value), allowed };
}

/**
 * Validate every enum-constrained field present on a create/update payload.
 * Returns the first violation so the caller can fail fast with one clear
 * message, or `null` when the payload is clean.
 */
export function validateMemoryEnums(input: Record<string, unknown>): EnumViolation | null {
  for (const field of Object.keys(ENUM_FIELDS)) {
    if (!(field in input)) continue;
    const violation = validateEnumField(field, input[field]);
    if (violation) return violation;
  }
  return null;
}
