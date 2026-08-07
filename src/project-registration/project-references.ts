import type { DbAdapter } from "../storage.js";

/**
 * Every supported schema column that directly points at a Mementos project.
 * Counts, receipt digests, inverse admission, and the conditional DELETE all
 * derive from this registry so adding a relationship cannot update one guard
 * while silently bypassing another.
 */
export const MEMENTOS_PROJECT_REFERENCE_SURFACES = [
  { key: "memories", table: "memories", column: "project_id" },
  { key: "sessions", table: "sessions", column: "project_id" },
  { key: "entities", table: "entities", column: "project_id" },
  { key: "agents", table: "agents", column: "active_project_id" },
  { key: "tool_events", table: "tool_events", column: "project_id" },
  { key: "tasks", table: "tasks", column: "project_id" },
  {
    key: "memory_consolidation_runs",
    table: "memory_consolidation_runs",
    column: "project_id",
  },
  {
    key: "memory_reflection_runs",
    table: "memory_reflection_runs",
    column: "project_id",
  },
  { key: "memory_acl", table: "memory_acl", column: "project_id" },
  { key: "search_history", table: "search_history", column: "project_id" },
  {
    key: "session_memory_jobs",
    table: "session_memory_jobs",
    column: "project_id",
  },
  { key: "synthesis_events", table: "synthesis_events", column: "project_id" },
  { key: "synthesis_runs", table: "synthesis_runs", column: "project_id" },
  { key: "webhook_hooks", table: "webhook_hooks", column: "project_id" },
] as const;

export type MementosProjectReferenceKey =
  (typeof MEMENTOS_PROJECT_REFERENCE_SURFACES)[number]["key"];

export type MementosProjectReferenceCounts = Record<MementosProjectReferenceKey, number>;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe project-reference identifier: ${value}`);
  }
  return `"${value}"`;
}

export function mementosProjectReferenceCounts(
  db: DbAdapter,
  projectId: string,
): MementosProjectReferenceCounts {
  const projections = MEMENTOS_PROJECT_REFERENCE_SURFACES.map(({ key, table, column }) =>
    `(SELECT COUNT(*) FROM ${quotedIdentifier(table)} `
      + `WHERE ${quotedIdentifier(column)} = ?) AS ${quotedIdentifier(key)}`
  ).join(",\n");
  const row = db.get(
    `SELECT\n${projections}`,
    ...MEMENTOS_PROJECT_REFERENCE_SURFACES.map(() => projectId),
  ) as Record<string, unknown>;
  return Object.fromEntries(
    MEMENTOS_PROJECT_REFERENCE_SURFACES.map(({ key }) => [key, Number(row[key] ?? 0)]),
  ) as MementosProjectReferenceCounts;
}

export function hasMementosProjectReferences(
  counts: MementosProjectReferenceCounts,
): boolean {
  return MEMENTOS_PROJECT_REFERENCE_SURFACES.some(({ key }) => counts[key] > 0);
}

/** Delete exactly one project only when every registered direct relationship is absent. */
export function deleteMementosProjectIfUnreferenced(
  db: DbAdapter,
  projectId: string,
): number {
  const guards = MEMENTOS_PROJECT_REFERENCE_SURFACES.map(({ table, column }) =>
    `NOT EXISTS (SELECT 1 FROM ${quotedIdentifier(table)} `
      + `WHERE ${quotedIdentifier(column)} = ?)`
  ).join("\n      AND ");
  const result = db.run(
    `DELETE FROM projects
     WHERE id = ?
       AND ${guards}`,
    projectId,
    ...MEMENTOS_PROJECT_REFERENCE_SURFACES.map(() => projectId),
  );
  return result.changes;
}
