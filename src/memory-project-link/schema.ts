export const MEMENTOS_MEMORY_PROJECT_LINK_ROUTE =
  "mementos.memory-project-link.v1" as const;

export const MEMORY_PROJECT_LINK_RECEIPT_COLUMNS = [
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
  "target_memory_id",
  "requested_project_id",
  "expected_memory_version",
  "expected_memory_revision",
  "expected_project_revision",
  "result_memory_version",
  "result_memory_revision",
  "result_memory_digest",
  "result_project_revision",
  "result_project_digest",
  "accepted_receipt_id",
  "before_link_json",
  "after_link_json",
  "before_project_revision",
  "before_project_digest",
  "after_project_revision",
  "after_project_digest",
  "created_at",
] as const;

export function sqliteMementosMemoryProjectLinkSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS mementos_memory_project_link_receipts (
      receipt_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL CHECK(authority = 'mementos'),
      route TEXT NOT NULL CHECK(route = 'mementos.memory-project-link.v1'),
      package_version TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('forward', 'rollback')),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'no_change')),
      target_memory_id TEXT NOT NULL,
      requested_project_id TEXT NOT NULL,
      expected_memory_version INTEGER NOT NULL,
      expected_memory_revision TEXT NOT NULL,
      expected_project_revision TEXT,
      result_memory_version INTEGER NOT NULL,
      result_memory_revision TEXT NOT NULL,
      result_memory_digest TEXT NOT NULL,
      result_project_revision TEXT,
      result_project_digest TEXT,
      accepted_receipt_id TEXT,
      before_link_json TEXT NOT NULL,
      after_link_json TEXT NOT NULL,
      before_project_revision TEXT,
      before_project_digest TEXT,
      after_project_revision TEXT,
      after_project_digest TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(authority_id, tenant_id, corpus_id, direction, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_mementos_memory_project_link_receipts_target
      ON mementos_memory_project_link_receipts(
        authority_id, tenant_id, corpus_id, target_memory_id, created_at
      );

    CREATE TRIGGER IF NOT EXISTS mementos_memory_project_link_receipts_immutable_update
    BEFORE UPDATE ON mementos_memory_project_link_receipts
    BEGIN
      SELECT RAISE(ABORT, 'mementos memory project link receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS mementos_memory_project_link_receipts_immutable_delete
    BEFORE DELETE ON mementos_memory_project_link_receipts
    BEGIN
      SELECT RAISE(ABORT, 'mementos memory project link receipts are immutable');
    END;
  `;
}

export function postgresMementosMemoryProjectLinkSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS mementos_memory_project_link_receipts (
      receipt_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL CHECK(authority = 'mementos'),
      route TEXT NOT NULL CHECK(route = 'mementos.memory-project-link.v1'),
      package_version TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('forward', 'rollback')),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('accepted', 'no_change')),
      target_memory_id TEXT NOT NULL,
      requested_project_id TEXT NOT NULL,
      expected_memory_version INTEGER NOT NULL,
      expected_memory_revision TEXT NOT NULL,
      expected_project_revision TEXT,
      result_memory_version INTEGER NOT NULL,
      result_memory_revision TEXT NOT NULL,
      result_memory_digest TEXT NOT NULL,
      result_project_revision TEXT,
      result_project_digest TEXT,
      accepted_receipt_id TEXT,
      before_link_json JSONB NOT NULL,
      after_link_json JSONB NOT NULL,
      before_project_revision TEXT,
      before_project_digest TEXT,
      after_project_revision TEXT,
      after_project_digest TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      UNIQUE(authority_id, tenant_id, corpus_id, direction, idempotency_key)
    );

    CREATE INDEX IF NOT EXISTS idx_mementos_memory_project_link_receipts_target
      ON mementos_memory_project_link_receipts(
        authority_id, tenant_id, corpus_id, target_memory_id, created_at
      );

    CREATE OR REPLACE FUNCTION mementos_memory_project_link_receipts_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'mementos memory project link receipts are immutable';
      END;
      $$;
    DROP TRIGGER IF EXISTS mementos_memory_project_link_receipts_immutable
      ON mementos_memory_project_link_receipts;
    CREATE TRIGGER mementos_memory_project_link_receipts_immutable
      BEFORE UPDATE OR DELETE ON mementos_memory_project_link_receipts
      FOR EACH ROW EXECUTE FUNCTION mementos_memory_project_link_receipts_immutable();
  `;
}
