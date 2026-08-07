export function sqliteMementosProjectRegistrationSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS mementos_project_registration_receipts (
      receipt_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL CHECK(authority = 'mementos'),
      route TEXT NOT NULL,
      package_version TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind = 'project'),
      direction TEXT NOT NULL CHECK(direction IN ('forward', 'inverse')),
      target_selector TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      precondition_digest TEXT NOT NULL,
      normalized_call_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN (
        'accepted', 'duplicate_of_accepted', 'terminal_nonacceptance'
      )),
      reason TEXT,
      target_id TEXT,
      result_revision TEXT,
      result_digest TEXT,
      duplicate_of_receipt_id TEXT,
      accepted_receipt_id TEXT,
      created_by_operation INTEGER NOT NULL CHECK(created_by_operation IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mementos_project_registration_receipts_lookup
      ON mementos_project_registration_receipts (
        authority_id, tenant_id, corpus_id, operation_id, step_id,
        resource_kind, direction, idempotency_key, target_selector
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mementos_project_registration_receipts_accepted_step
      ON mementos_project_registration_receipts (
        authority_id, tenant_id, corpus_id, operation_id, step_id,
        resource_kind, direction
      )
      WHERE outcome = 'accepted';

    CREATE TABLE IF NOT EXISTS mementos_project_registration_bindings (
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind = 'project'),
      target_selector TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction = 'forward'),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      precondition_digest TEXT NOT NULL,
      normalized_call_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'pending', 'accepted', 'terminal_nonacceptance', 'removed'
      )),
      target_id TEXT,
      accepted_receipt_id TEXT,
      result_revision TEXT,
      result_digest TEXT,
      removed_receipt_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(authority_id, tenant_id, corpus_id, resource_kind, target_selector),
      UNIQUE(accepted_receipt_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mementos_project_registration_binding_target
      ON mementos_project_registration_bindings(
        authority_id, tenant_id, corpus_id, resource_kind, target_id
      )
      WHERE target_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS mementos_project_registration_receipts_immutable_update
    BEFORE UPDATE ON mementos_project_registration_receipts
    BEGIN
      SELECT RAISE(ABORT, 'mementos project registration receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS mementos_project_registration_receipts_immutable_delete
    BEFORE DELETE ON mementos_project_registration_receipts
    BEGIN
      SELECT RAISE(ABORT, 'mementos project registration receipts are immutable');
    END;
  `;
}

export function postgresMementosProjectRegistrationSchemaSql(): string {
  return `
    CREATE TABLE IF NOT EXISTS mementos_project_registration_receipts (
      receipt_id TEXT PRIMARY KEY,
      authority TEXT NOT NULL CHECK(authority = 'mementos'),
      route TEXT NOT NULL,
      package_version TEXT NOT NULL,
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind = 'project'),
      direction TEXT NOT NULL CHECK(direction IN ('forward', 'inverse')),
      target_selector TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      precondition_digest TEXT NOT NULL,
      normalized_call_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN (
        'accepted', 'duplicate_of_accepted', 'terminal_nonacceptance'
      )),
      reason TEXT,
      target_id TEXT,
      result_revision TEXT,
      result_digest TEXT,
      duplicate_of_receipt_id TEXT,
      accepted_receipt_id TEXT,
      created_by_operation BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mementos_project_registration_receipts_lookup
      ON mementos_project_registration_receipts (
        authority_id, tenant_id, corpus_id, operation_id, step_id,
        resource_kind, direction, idempotency_key, target_selector
      );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mementos_project_registration_receipts_accepted_step
      ON mementos_project_registration_receipts (
        authority_id, tenant_id, corpus_id, operation_id, step_id,
        resource_kind, direction
      )
      WHERE outcome = 'accepted';

    CREATE TABLE IF NOT EXISTS mementos_project_registration_bindings (
      authority_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      corpus_id TEXT NOT NULL,
      resource_kind TEXT NOT NULL CHECK(resource_kind = 'project'),
      target_selector TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction = 'forward'),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      precondition_digest TEXT NOT NULL,
      normalized_call_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'pending', 'accepted', 'terminal_nonacceptance', 'removed'
      )),
      target_id TEXT,
      accepted_receipt_id TEXT UNIQUE,
      result_revision TEXT,
      result_digest TEXT,
      removed_receipt_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(authority_id, tenant_id, corpus_id, resource_kind, target_selector)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mementos_project_registration_binding_target
      ON mementos_project_registration_bindings(
        authority_id, tenant_id, corpus_id, resource_kind, target_id
      )
      WHERE target_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION mementos_project_registration_receipts_immutable()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'mementos project registration receipts are immutable';
      END;
      $$;
    DROP TRIGGER IF EXISTS mementos_project_registration_receipts_immutable
      ON mementos_project_registration_receipts;
    CREATE TRIGGER mementos_project_registration_receipts_immutable
      BEFORE UPDATE OR DELETE ON mementos_project_registration_receipts
      FOR EACH ROW EXECUTE FUNCTION mementos_project_registration_receipts_immutable();
  `;
}
