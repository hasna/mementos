// CLI-wide exit-status contract: separate "the CLI never ran your verb" from
// "your verb ran and answered".
//
// Kept in its own module, free of any import, so tests and callers can assert
// against the contract without pulling command or database dependencies into
// their own process — the same reasoning as memory-cmd-recall-exit.ts, which
// this extends rather than replaces.
//
//   0  — success (also: --help, --version).
//   64 — USAGE. Commander rejected the command line itself: an unknown verb, an
//        unknown option, a missing or excess argument, or a command group named
//        with no subcommand. THE VERB NEVER RAN, so nothing was learned about
//        the store or the data.
//   1  — the verb ran and reported a normal failure (for `recall`/`get`: the key
//        was not found). Unchanged.
//   2  — `recall`/`get --fuzzy` substituted a DIFFERENT record. Unchanged; see
//        memory-cmd-recall-exit.ts.
//
// WHY 64 AND NOT 1 (todos 518ad20c). Before this, a caller that branched on the
// exit code alone could not tell a MISTYPED COMMAND from a GENUINE MISS — both
// were 1 — so a verification script read its own typo as an authoritative
// absence and failed open. The collision was wider than a typo: measured on
// 0.14.73, exit 1 was also returned for an unreachable store and for a 401, so
// "the memory is not there" and "your token expired" were the same signal to a
// script. Moving only the command-line-rejection class out of 1 is the smallest
// change that breaks the ambiguity.
//
// WHY IT IS SAFE. Every code here stays NON-ZERO for every failure, so a shell
// `if mementos ...` / `&&` / `||` keeps behaving exactly as before — the same
// property memory-cmd-recall-exit.ts relies on for exit 2. Only a caller doing
// an exact `[ $? -eq 1 ]` against a MALFORMED command line sees a change, and
// such a caller is already misreading a usage error as a data answer.
//
// 64 is EX_USAGE from sysexits.h, the long-standing convention for "the command
// line was wrong". It is deliberately not 127, which shells reserve for "no such
// executable" — here the executable was found and it was the ARGUMENTS that were
// rejected.

export const EXIT_USAGE = 64;

/**
 * Commander error codes that mean "the command line was rejected", i.e. no
 * command action ever executed.
 *
 * `commander.error` is deliberately absent: that is the code Commander attaches
 * to `Command#error()`, which command implementations use to report DOMAIN
 * failures. Those keep their own exit codes.
 *
 * `commander.help` is present because Commander uses it when a command group is
 * invoked with no subcommand (`help({ error: true })`, command.js:1564) — a
 * usage error. An explicit `--help` is a different code (`commander.helpDisplayed`)
 * and in any case arrives with exitCode 0, which is short-circuited below.
 */
const USAGE_ERROR_CODES: ReadonlySet<string> = new Set([
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingArgument",
  "commander.optionMissingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.excessArguments",
  "commander.conflictingOption",
  "commander.invalidArgument",
  "commander.help",
]);

/**
 * Map a CommanderError onto this CLI's exit-status contract.
 *
 * Pure and total: given the `code`/`exitCode` pair Commander produces, returns
 * the status the process should exit with. Success paths (`--help`, `--version`,
 * which arrive with exitCode 0) are passed through untouched.
 */
export function resolveExitCode(err: {
  code?: string;
  exitCode?: number;
}): number {
  const exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;

  // --help and --version reach here with 0. Never turn a success into a failure.
  if (exitCode === 0) return 0;

  return USAGE_ERROR_CODES.has(err.code ?? "") ? EXIT_USAGE : exitCode;
}
