/**
 * IO commands have been split into separate modules:
 * - io-export.ts: export command
 * - io-import.ts: import command
 * - io-clean.ts: clean command
 * - io-backup.ts: backup command
 * - io-restore.ts: restore command
 * This stub remains for backwards compatibility with any code that imports from this module.
 */
import type { Command } from "commander";
import { registerExportCommand } from "./io-export.js";
import { registerImportCommand } from "./io-import.js";
import { registerCleanCommand } from "./io-clean.js";
import { registerBackupCommand } from "./io-backup.js";
import { registerRestoreCommand } from "./io-restore.js";

export function registerIoCommands(program: Command): void {
  registerExportCommand(program);
  registerImportCommand(program);
  registerCleanCommand(program);
  registerBackupCommand(program);
  registerRestoreCommand(program);
}
