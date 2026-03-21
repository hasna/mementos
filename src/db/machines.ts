import { hostname, platform } from "os";
import { getDatabase, now, uuid } from "./database.js";

export interface Machine {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
}

export function registerMachine(name?: string, db = getDatabase()): Machine {
  const host = hostname();
  const plat = platform();
  const machineName = name?.trim() || host;

  // Idempotent by hostname: return existing if same hostname is already registered
  const existing = db.query("SELECT * FROM machines WHERE hostname = ?").get(host) as Machine | null;
  if (existing) {
    db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", [now(), existing.id]);
    return { ...existing, last_seen_at: now() };
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
  return db.query("SELECT * FROM machines WHERE id = ?").get(id) as Machine;
}

export function listMachines(db = getDatabase()): Machine[] {
  return db.query("SELECT * FROM machines ORDER BY last_seen_at DESC").all() as Machine[];
}

export function getMachine(id: string, db = getDatabase()): Machine | null {
  return db.query("SELECT * FROM machines WHERE id = ? OR name = ?").get(id, id) as Machine | null;
}

export function renameMachine(id: string, newName: string, db = getDatabase()): Machine {
  const m = db.query("SELECT * FROM machines WHERE id = ?").get(id) as Machine | null;
  if (!m) throw new Error(`Machine not found: ${id}`);
  const clash = db.query("SELECT id FROM machines WHERE name = ? AND id != ?").get(newName, id);
  if (clash) throw new Error(`Machine name already taken: ${newName}`);
  db.run("UPDATE machines SET name = ?, last_seen_at = ? WHERE id = ?", [newName, now(), id]);
  return db.query("SELECT * FROM machines WHERE id = ?").get(id) as Machine;
}

export function touchMachine(id: string, db = getDatabase()): void {
  db.run("UPDATE machines SET last_seen_at = ? WHERE id = ?", [now(), id]);
}

/** Get or auto-register the current machine and return its ID. */
export function getCurrentMachineId(db = getDatabase()): string {
  const host = hostname();
  const m = db.query("SELECT id FROM machines WHERE hostname = ?").get(host) as { id: string } | null;
  if (m) {
    touchMachine(m.id, db);
    return m.id;
  }
  return registerMachine(undefined, db).id;
}
