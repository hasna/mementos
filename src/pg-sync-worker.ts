/**
 * Postgres synchronous-bridge worker (Amendment A1 — PURE REMOTE cloud store).
 *
 * The mementos data layer is fully synchronous: every CLI/MCP/server call site
 * does `db.query(sql).get(...)`. node-postgres is async and its socket I/O is
 * driven by the event loop, so a busy-wait on the main thread (Bun.sleepSync)
 * deadlocks — the loop never advances the pending query.
 *
 * This worker owns a single long-lived `pg.Client` and processes queries on its
 * OWN event loop (via `parentPort` message events), so pg I/O completes
 * normally. The main thread posts a request then blocks on `Atomics.wait`
 * against a SharedArrayBuffer until this worker writes the response back into a
 * shared data buffer and flips the status word. One client (not a pool) keeps
 * transactions (BEGIN/COMMIT/ROLLBACK) correct since all statements are
 * serialized over the single connection.
 */
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";

interface WorkerData {
  dsn: string;
  ssl: boolean | { rejectUnauthorized: boolean } | undefined;
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
}

const { dsn, ssl, control, data } = workerData as WorkerData;
const status = new Int32Array(control); // [0]=status(0 idle,1 ok,2 err), [1]=byteLength
const dataView = new Uint8Array(data);
const encoder = new TextEncoder();

const client = new pg.Client({ connectionString: dsn, ssl });
let connected = false;
let connecting: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (connected) return;
  if (!connecting) {
    connecting = client.connect().then(() => {
      connected = true;
    });
  }
  await connecting;
}

function respond(statusCode: number, payload: unknown): void {
  const bytes = encoder.encode(JSON.stringify(payload));
  if (bytes.length > dataView.length) {
    const errBytes = encoder.encode(
      JSON.stringify({
        message: `PgSyncWorker: response of ${bytes.length} bytes exceeds shared buffer (${dataView.length})`,
      })
    );
    dataView.set(errBytes, 0);
    Atomics.store(status, 1, errBytes.length);
    Atomics.store(status, 0, 2);
    Atomics.notify(status, 0);
    return;
  }
  dataView.set(bytes, 0);
  Atomics.store(status, 1, bytes.length);
  Atomics.store(status, 0, statusCode);
  Atomics.notify(status, 0);
}

parentPort?.on("message", async (msg: { sql: string; params: unknown[] }) => {
  try {
    await ensureConnected();
    const result = await client.query(msg.sql, msg.params as unknown[]);
    respond(1, { rows: result.rows, rowCount: result.rowCount });
  } catch (error) {
    respond(2, { message: error instanceof Error ? error.message : String(error) });
  }
});
