process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createMemory } from "../db/memories.js";
import { applyMemoryProjectLink } from "../db/memory-project-link.js";
import { MIGRATIONS } from "../db/migrations.js";
import { PG_MIGRATIONS } from "../db/pg-migrations.js";
import { registerProject } from "../db/projects.js";
import {
  MEMORY_PROJECT_LINK_RECEIPT_COLUMNS,
  postgresMementosMemoryProjectLinkSchemaSql,
  sqliteMementosMemoryProjectLinkSchemaSql,
} from "./schema.js";

beforeEach(() => {
  resetDatabase();
});

describe("existing-memory project-link schema", () => {
  test("migration 40 installs the exact immutable SQLite receipt contract", () => {
    const db = getDatabase();
    const migration = db.query("SELECT MAX(id) AS id FROM _migrations").get() as { id: number };
    const columns = db.query(
      "PRAGMA table_info(mementos_memory_project_link_receipts)",
    ).all() as Array<{ name: string }>;

    expect(migration.id).toBe(40);
    expect(columns.map(({ name }) => name)).toEqual(MEMORY_PROJECT_LINK_RECEIPT_COLUMNS);

    const project = registerProject("Dubai", "/projects/dubai-link-schema");
    const memory = createMemory({ key: "schema-link", value: "stable" });
    const result = applyMemoryProjectLink(memory.id, {
      authority_id: "mementos",
      tenant_id: "default",
      corpus_id: "default",
      operation_id: "schema-link-operation-v1",
      step_id: "schema_link_memory_project",
      idempotency_key: "schema-link-idempotency-0001",
      expected_memory_version: memory.version,
      expected_memory_revision: memory.updated_at,
      target_project_id: project.id,
      expected_project_revision: project.updated_at,
    });
    const receiptId = result.receipt!.receipt_id;

    expect(() => db.run(
      "UPDATE mementos_memory_project_link_receipts SET outcome = ? WHERE receipt_id = ?",
      "no_change",
      receiptId,
    )).toThrow("immutable");
    expect(() => db.run(
      "DELETE FROM mementos_memory_project_link_receipts WHERE receipt_id = ?",
      receiptId,
    )).toThrow("immutable");
  });

  test("SQLite and PostgreSQL migration tails carry equivalent receipt contracts", () => {
    const sqlite = sqliteMementosMemoryProjectLinkSchemaSql();
    const postgres = postgresMementosMemoryProjectLinkSchemaSql();

    expect(MIGRATIONS.at(-1)).toContain(sqlite);
    expect(PG_MIGRATIONS.at(-1)).toContain(postgres);
    for (const column of MEMORY_PROJECT_LINK_RECEIPT_COLUMNS) {
      expect(sqlite).toMatch(new RegExp(`\\b${column}\\b`));
      expect(postgres).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sqlite).toContain(
      "UNIQUE(authority_id, tenant_id, corpus_id, direction, idempotency_key)",
    );
    expect(postgres).toContain(
      "UNIQUE(authority_id, tenant_id, corpus_id, direction, idempotency_key)",
    );
    expect(sqlite).toContain("BEFORE UPDATE ON mementos_memory_project_link_receipts");
    expect(sqlite).toContain("BEFORE DELETE ON mementos_memory_project_link_receipts");
    expect(postgres).toContain("BEFORE UPDATE OR DELETE");
    expect(postgres).toContain("before_link_json JSONB NOT NULL");
    expect(postgres).toContain("after_link_json JSONB NOT NULL");
    expect(postgres).toContain("created_at TIMESTAMPTZ NOT NULL");
  });
});
