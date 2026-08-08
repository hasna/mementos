process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { MIGRATIONS } from "../db/migrations.js";
import { PG_MIGRATIONS } from "../db/pg-migrations.js";
import {
  postgresMementosProjectGuardedUpdateSchemaSql,
  postgresMementosProjectRegistrationSchemaSql,
  sqliteMementosProjectGuardedUpdateSchemaSql,
  sqliteMementosProjectRegistrationSchemaSql,
} from "./schema.js";
import { MEMENTOS_PROJECT_REFERENCE_SURFACES } from "./project-references.js";

const RECEIPT_COLUMNS = [
  "receipt_id",
  "authority",
  "route",
  "package_version",
  "authority_id",
  "tenant_id",
  "corpus_id",
  "operation_id",
  "step_id",
  "resource_kind",
  "direction",
  "target_selector",
  "idempotency_key",
  "request_digest",
  "precondition_digest",
  "normalized_call_digest",
  "outcome",
  "reason",
  "target_id",
  "result_revision",
  "result_digest",
  "duplicate_of_receipt_id",
  "accepted_receipt_id",
  "created_by_operation",
  "created_at",
] as const;

const BINDING_COLUMNS = [
  "authority_id",
  "tenant_id",
  "corpus_id",
  "resource_kind",
  "target_selector",
  "operation_id",
  "step_id",
  "direction",
  "idempotency_key",
  "request_digest",
  "precondition_digest",
  "normalized_call_digest",
  "state",
  "target_id",
  "accepted_receipt_id",
  "result_revision",
  "result_digest",
  "removed_receipt_id",
  "created_at",
  "updated_at",
] as const;

const UPDATE_RECEIPT_COLUMNS = [
  "receipt_id",
  "authority",
  "route",
  "package_version",
  "authority_id",
  "tenant_id",
  "corpus_id",
  "operation_id",
  "step_id",
  "direction",
  "idempotency_key",
  "request_digest",
  "outcome",
  "target_id",
  "expected_revision",
  "result_revision",
  "result_digest",
  "accepted_receipt_id",
  "before_project_json",
  "after_project_json",
  "created_at",
] as const;

function postgresDirectProjectReferences(): string[] {
  const ddl = PG_MIGRATIONS.join("\n");
  const references = new Set<string>();
  for (const match of ddl.matchAll(
    /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi,
  )) {
    const table = match[1]!;
    for (const line of match[2]!.split("\n")) {
      const column = line.match(/^\s*(project_id|active_project_id)\s+/i)?.[1];
      if (column) references.add(`${table}.${column.toLowerCase()}`);
    }
  }
  for (const match of ddl.matchAll(
    /ALTER TABLE\s+([a-z_][a-z0-9_]*)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+(project_id|active_project_id)\b/gi,
  )) {
    references.add(`${match[1]}.${match[2]}`.toLowerCase());
  }
  return [...references].sort();
}

beforeEach(() => {
  resetDatabase();
});

describe("Mementos project registration schema parity", () => {
  test("migration 40 retains registration and guarded-update receipt contracts", () => {
    const db = getDatabase();
    const migration = db.query("SELECT MAX(id) AS id FROM _migrations").get() as { id: number };
    const receiptColumns = db.query(
      "PRAGMA table_info(mementos_project_registration_receipts)",
    ).all() as Array<{ name: string }>;
    const bindingColumns = db.query(
      "PRAGMA table_info(mementos_project_registration_bindings)",
    ).all() as Array<{ name: string }>;
    const updateReceiptColumns = db.query(
      "PRAGMA table_info(mementos_project_update_receipts)",
    ).all() as Array<{ name: string }>;

    expect(migration.id).toBe(40);
    expect(receiptColumns.map(({ name }) => name)).toEqual(RECEIPT_COLUMNS);
    expect(bindingColumns.map(({ name }) => name)).toEqual(BINDING_COLUMNS);
    expect(updateReceiptColumns.map(({ name }) => name)).toEqual(UPDATE_RECEIPT_COLUMNS);

    db.run(`
      INSERT INTO mementos_project_registration_receipts (
        receipt_id, authority, route, package_version, authority_id, tenant_id,
        corpus_id, operation_id, step_id, resource_kind, direction,
        target_selector, idempotency_key, request_digest, precondition_digest,
        normalized_call_digest, outcome, reason, target_id, result_revision,
        result_digest, duplicate_of_receipt_id, accepted_receipt_id,
        created_by_operation, created_at
      ) VALUES (?, 'mementos', ?, ?, ?, ?, ?, ?, ?, 'project', 'forward',
        ?, ?, ?, ?, ?, 'terminal_nonacceptance', ?, NULL, NULL, NULL, NULL,
        NULL, 0, ?)
    `,
    "mmpr_immutable_test",
    "mementos.project-registration.v1",
    "0.14.75-test",
    "authority",
    "tenant",
    "corpus",
    "operation-test",
    "step-test",
    "selector",
    "prk_000000000000000000000000000000000000000000000000",
    "0".repeat(64),
    "1".repeat(64),
    "2".repeat(64),
    "test",
    "2026-08-07T12:00:00.000Z",
    );

    expect(() => db.run(
      "UPDATE mementos_project_registration_receipts SET reason = ? WHERE receipt_id = ?",
      "changed",
      "mmpr_immutable_test",
    )).toThrow("immutable");
    expect(() => db.run(
      "DELETE FROM mementos_project_registration_receipts WHERE receipt_id = ?",
      "mmpr_immutable_test",
    )).toThrow("immutable");

    db.run(`
      INSERT INTO mementos_project_update_receipts (
        receipt_id, authority, route, package_version, authority_id, tenant_id,
        corpus_id, operation_id, step_id, direction, idempotency_key,
        request_digest, outcome, target_id, expected_revision, result_revision,
        result_digest, accepted_receipt_id, before_project_json,
        after_project_json, created_at
      ) VALUES (?, 'mementos', 'mementos.project-guarded-update.v1', ?, ?, ?, ?,
        ?, ?, 'forward', ?, ?, 'accepted', ?, ?, ?, ?, NULL, ?, ?, ?)
    `,
    "mpur_immutable_test",
    "0.14.75-test",
    "authority",
    "tenant",
    "corpus",
    "operation-test",
    "step-test",
    "guarded-update-idempotency-test",
    "0".repeat(64),
    "project-test",
    "2026-08-07T12:00:00.000Z",
    "2026-08-07T12:01:00.000Z",
    "1".repeat(64),
    "{}",
    "{}",
    "2026-08-07T12:01:00.000Z",
    );
    expect(() => db.run(
      "UPDATE mementos_project_update_receipts SET result_digest = ? WHERE receipt_id = ?",
      "2".repeat(64),
      "mpur_immutable_test",
    )).toThrow("immutable");
    expect(() => db.run(
      "DELETE FROM mementos_project_update_receipts WHERE receipt_id = ?",
      "mpur_immutable_test",
    )).toThrow("immutable");
  });

  test("SQLite and PostgreSQL migration tails carry equivalent receipt and binding contracts", () => {
    const sqlite = sqliteMementosProjectRegistrationSchemaSql();
    const postgres = postgresMementosProjectRegistrationSchemaSql();
    const sqliteUpdate = sqliteMementosProjectGuardedUpdateSchemaSql();
    const postgresUpdate = postgresMementosProjectGuardedUpdateSchemaSql();

    expect(MIGRATIONS.at(-3)).toContain(sqlite);
    expect(PG_MIGRATIONS.at(-3)).toContain(postgres);
    expect(MIGRATIONS.at(-2)).toContain(sqliteUpdate);
    expect(PG_MIGRATIONS.at(-2)).toContain(postgresUpdate);
    for (const column of [...RECEIPT_COLUMNS, ...BINDING_COLUMNS]) {
      expect(sqlite).toMatch(new RegExp(`\\b${column}\\b`));
      expect(postgres).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sqlite).toContain("BEFORE UPDATE ON mementos_project_registration_receipts");
    expect(sqlite).toContain("BEFORE DELETE ON mementos_project_registration_receipts");
    expect(postgres).toContain("BEFORE UPDATE OR DELETE");
    expect(postgres).toContain("created_by_operation BOOLEAN NOT NULL");
    expect(postgres).toContain("created_at TIMESTAMPTZ NOT NULL");
    for (const column of UPDATE_RECEIPT_COLUMNS) {
      expect(sqliteUpdate).toMatch(new RegExp(`\\b${column}\\b`));
      expect(postgresUpdate).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sqliteUpdate).toContain("BEFORE UPDATE ON mementos_project_update_receipts");
    expect(sqliteUpdate).toContain("BEFORE DELETE ON mementos_project_update_receipts");
    expect(postgresUpdate).toContain("BEFORE UPDATE OR DELETE");
    expect(postgresUpdate).toContain("before_project_json JSONB NOT NULL");
  });

  test("the inverse dependency registry covers every SQLite and PostgreSQL project relationship", () => {
    const expected = MEMENTOS_PROJECT_REFERENCE_SURFACES
      .map(({ table, column }) => `${table}.${column}`)
      .sort();
    const sqlite = (getDatabase().query(`
      SELECT schema_table.name AS table_name, table_column.name AS column_name
      FROM sqlite_schema AS schema_table
      JOIN pragma_table_info(schema_table.name) AS table_column
      WHERE schema_table.type = 'table'
        AND table_column.name IN ('project_id', 'active_project_id')
      ORDER BY schema_table.name, table_column.name
    `).all() as Array<{ table_name: string; column_name: string }>)
      .map(({ table_name, column_name }) => `${table_name}.${column_name}`);

    expect(expected).toHaveLength(14);
    expect(sqlite).toEqual(expected);
    expect(postgresDirectProjectReferences()).toEqual(expected);
  });
});
