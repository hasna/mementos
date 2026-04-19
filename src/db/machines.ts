import { hostname, platform } from "os";
import { getDatabase, now, uuid } from "./database.js";

export interface Machine {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  is_primary: boolean;
  created_at: string;
  last_seen_at: string;
}

interface RawMachineRow extends Omit<Machine, "is_primary"> {
  is_primary?: number | boolean | null;
}

function parseMachine(row: RawMachineRow | null): Machine | null {
  if (!row) return null;
  return {
    ...row,
    is_primary: Boolean(row.is_primary),
  };
}

/** Normalize hostname by stripping common suffixes like .local */
function normalizeHostname(host: string): string {
  return host.replace(/\.(local|lan|home|internal)$/i, "");
}

export function registerMachine(name?: string, db = getDatabase()): Machine {
  const rawHost = hostname();
  const host = normalizeHostname(rawHost);
  const plat = platform();
  const machineName = name?.trim() || host;

  // Idempotent by hostname: return existing if same hostname is already registered
  const existing = parseMachine(
    db.query("SELECT * FROM machines WHERE hostname = ?").get(host) as RawMachineRow | null
  );
  if (existing) {
    db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", [now(), existing.id]);
    return parseMachine(
      db.query("SELECT * FROM machines WHERE id = ?").get(existing.id) as RawMachineRow | null
    ) as Machine;
  }

  // Ensure name uniqueness by appending suffix if needed
  let finalName = machineName;
  let suffix = 2;
  while (db.query("SELECT id FROM machines WHERE name = ?").get(finalName)) {
    finalName = `${machineName}-${suffix++}`;
  }

  const id = uuid();
  db.run(
    "INSERT INTO machines (id, name, hostname, platform) VALUES (?, ?, ?, ?)",
    [id, finalName, host, plat]
  );
  return parseMachine(
    db.query("SELECT * FROM machines WHERE id = ?").get(id) as RawMachineRow | null
  ) as Machine;
}

export function listMachines(db = getDatabase()): Machine[] {
  const rows = db.query(
    "SELECT * FROM machines ORDER BY is_primary DESC, last_seen_at DESC, created_at ASC"
  ).all() as RawMachineRow[];
  return rows.map((row) => parseMachine(row) as Machine);
}

export function getMachine(id: string, db = getDatabase()): Machine | null {
  return parseMachine(
    db.query("SELECT * FROM machines WHERE id = ? OR name = ?").get(id, id) as RawMachineRow | null
  );
}

export function renameMachine(id: string, newName: string, db = getDatabase()): Machine {
  const m = parseMachine(
    db.query("SELECT * FROM machines WHERE id = ?").get(id) as RawMachineRow | null
  );
  if (!m) throw new Error(`Machine not found: ${id}`);
  const clash = db.query("SELECT id FROM machines WHERE name = ? AND id != ?").get(newName, id);
  if (clash) throw new Error(`Machine name already taken: ${newName}`);
  db.run("UPDATE machines SET name = ?, last_seen_at = ? WHERE id = ?", [newName, now(), id]);
  return parseMachine(
    db.query("SELECT * FROM machines WHERE id = ?").get(id) as RawMachineRow | null
  ) as Machine;
}

export function getPrimaryMachine(db = getDatabase()): Machine | null {
  return parseMachine(
    db.query("SELECT * FROM machines WHERE is_primary = 1 LIMIT 1").get() as RawMachineRow | null
  );
}

export function getPrimaryMachineCandidate(db = getDatabase()): Machine | null {
  if (getPrimaryMachine(db)) return null;
  return parseMachine(
    db.query("SELECT * FROM machines ORDER BY created_at ASC, id ASC LIMIT 1").get() as RawMachineRow | null
  );
}

export function setPrimaryMachine(id: string, db = getDatabase()): Machine {
  const machine = getMachine(id, db);
  if (!machine) throw new Error(`Machine not found: ${id}`);

  const updatedAt = now();
  db.run(
    "UPDATE machines SET is_primary = 0, last_seen_at = ? WHERE is_primary = 1 AND id != ?",
    [updatedAt, machine.id]
  );
  db.run(
    "UPDATE machines SET is_primary = 1, last_seen_at = ? WHERE id = ?",
    [updatedAt, machine.id]
  );

  return getMachine(machine.id, db) as Machine;
}

export function deleteMachine(id: string, db = getDatabase()): void {
  const machine = getMachine(id, db);
  if (!machine) throw new Error(`Machine not found: ${id}`);
  if (machine.is_primary) {
    throw new Error(`Primary machine cannot be deleted: ${machine.name}`);
  }
  db.run("DELETE FROM machines WHERE id = ?", [machine.id]);
}

export function getFallbackSyncTargetMachine(db = getDatabase()): Machine | null {
  return getPrimaryMachine(db);
}

export function getPrimaryMachineStartupWarning(db = getDatabase()): string | null {
  if (getPrimaryMachine(db)) return null;

  const candidate = getPrimaryMachineCandidate(db);
  if (!candidate) {
    return "No primary machine configured. Fallback sync target is unset because no machines are registered yet.";
  }

  return `No primary machine configured. Fallback sync target is unset. Candidate: ${candidate.name} (${candidate.id.slice(0, 8)} / ${candidate.hostname}). Confirm it with set_primary_machine.`;
}

export function touchMachine(id: string, db = getDatabase()): void {
  db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", [now(), id]);
}

/** Get or auto-register the current machine and return its ID. */
export function getCurrentMachineId(db = getDatabase()): string {
  const host = normalizeHostname(hostname());
  const m = db.query("SELECT id FROM machines WHERE hostname = ?").get(host) as { id: string } | null;
  if (m) {
    touchMachine(m.id, db);
    return m.id;
  }
  return registerMachine(undefined, db).id;
}
