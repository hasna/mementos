import { SqliteAdapter as Database } from "@hasna/cloud";
import { getCurrentMachineId } from "../db/machines.js";
import type { MemoryFilter, Memory } from "../types/index.js";

export function resolveVisibleMachineId(
  machineId?: string | null,
  db?: Database
): string | null {
  if (machineId !== undefined) {
    return machineId;
  }

  try {
    return getCurrentMachineId(db);
  } catch {
    return null;
  }
}

export function visibleToMachineFilter(
  machineId?: string | null,
  db?: Database
): Pick<MemoryFilter, "visible_to_machine_id"> {
  return {
    visible_to_machine_id: resolveVisibleMachineId(machineId, db),
  };
}

export function isMemoryVisibleToMachine(
  memory: Pick<Memory, "machine_id">,
  machineId?: string | null,
  db?: Database
): boolean {
  if (!memory.machine_id) {
    return true;
  }

  const visibleMachineId = resolveVisibleMachineId(machineId, db);
  return visibleMachineId !== null && memory.machine_id === visibleMachineId;
}
