// ============================================================================
// Opting a command out of the startup database access.
//
// `src/cli/index.tsx` installs a global `preAction` hook that opens the database
// to print a one-time primary-machine warning. That is fine for the commands
// that are about to use the database anyway, but it is wrong for a DIAGNOSTIC
// command whose entire value is having no storage side effects — `storage mode`
// exists to answer "which store am I pointed at?" from the environment alone,
// including when you do not yet trust the environment.
//
// Measured consequence of not having this: `storage mode` inherited the hook's
// `getDatabase()` call, so running it against a scratch path CREATED and
// migrated that SQLite file (~720KB, plus -wal/-shm). That silently voided
// `assertScratchDbCreated` in the test harnesses — it is meant to prove a WRITE
// landed in the scratch file, but the mode probe had already created the file
// during `assertLocalStoreBackend`, so the assertion could not fail.
//
// Membership is recorded on the Command object itself rather than matched by
// name string, so renaming or re-nesting a command cannot silently detach the
// opt-out, and nothing has to hardcode a command path.
// ============================================================================

import type { Command } from "commander";

const NO_STARTUP_DB_ACCESS = new WeakSet<Command>();

/**
 * Mark a command as having no startup database access, and return it so it can
 * be used inline at the end of a builder chain.
 */
export function withoutStartupDbAccess<T extends Command>(command: T): T {
  NO_STARTUP_DB_ACCESS.add(command);
  return command;
}

/** Whether the command about to run has opted out of the startup DB access. */
export function skipsStartupDbAccess(command: Command | undefined): boolean {
  return command !== undefined && NO_STARTUP_DB_ACCESS.has(command);
}
