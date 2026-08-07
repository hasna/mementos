process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { MIGRATIONS } from "../db/migrations.js";
import { PG_MIGRATIONS } from "../db/pg-migrations.js";
import {
  postgresMementosProjectRegistrationSchemaSql,
  sqliteMementosProjectRegistrationSchemaSql,
} from "./schema.js";

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

beforeEach(() => {
  resetDatabase();
});

describe("Mementos project registration schema parity", () => {
  test("migration 38 applies the complete SQLite schema and immutable triggers", () => {
    const db = getDatabase();
    const migration = db.query("SELECT MAX(id) AS id FROM _migrations").get() as { id: number };
    const receiptColumns = db.query(
      "PRAGMA table_info(mementos_project_registration_receipts)",
    ).all() as Array<{ name: string }>;
    const bindingColumns = db.query(
      "PRAGMA table_info(mementos_project_registration_bindings)",
    ).all() as Array<{ name: string }>;

    expect(migration.id).toBe(38);
    expect(receiptColumns.map(({ name }) => name)).toEqual(RECEIPT_COLUMNS);
    expect(bindingColumns.map(({ name }) => name)).toEqual(BINDING_COLUMNS);

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
  });

  test("SQLite and PostgreSQL migration tails carry equivalent receipt and binding contracts", () => {
    const sqlite = sqliteMementosProjectRegistrationSchemaSql();
    const postgres = postgresMementosProjectRegistrationSchemaSql();

    expect(MIGRATIONS.at(-1)).toContain(sqlite);
    expect(PG_MIGRATIONS.at(-1)).toContain(postgres);
    for (const column of [...RECEIPT_COLUMNS, ...BINDING_COLUMNS]) {
      expect(sqlite).toMatch(new RegExp(`\\b${column}\\b`));
      expect(postgres).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sqlite).toContain("BEFORE UPDATE ON mementos_project_registration_receipts");
    expect(sqlite).toContain("BEFORE DELETE ON mementos_project_registration_receipts");
    expect(postgres).toContain("BEFORE UPDATE OR DELETE");
    expect(postgres).toContain("created_by_operation BOOLEAN NOT NULL");
    expect(postgres).toContain("created_at TIMESTAMPTZ NOT NULL");
  });
});
