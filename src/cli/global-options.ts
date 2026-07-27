import type { Command } from "commander";

/**
 * The program-level options, in one place.
 *
 * These are declared on the root `mementos` command, and commander resolves a
 * short flag appearing AFTER a subcommand name to the parent's option. So any
 * short flag listed here is claimed globally: a subcommand that declares the
 * same short can never receive a value through it, no matter what `--help` says.
 *
 * That is not hypothetical. `save`/`update`/`list`/`recall`/... each declared
 * `-s, --scope`, which `-s, --session` below shadowed. `mementos save k v -s
 * shared` therefore wrote `session_id="shared"` and left scope at its default,
 * while `--help` advertised `-s, --scope` — a documented flag that silently
 * misrouted its value into a different column (HC-00149).
 *
 * Exported so the invariant can be enforced by a test instead of by review:
 * see `global-options.test.ts`.
 */
export const GLOBAL_OPTIONS: ReadonlyArray<readonly [flags: string, description: string]> = [
  ["-p, --project <path>", "Project path for scoping"],
  ["-j, --json", "Output as JSON"],
  ["-f, --format <fmt>", "Output format: compact, json, csv, yaml"],
  ["-a, --agent <name>", "Agent name or ID"],
  ["-s, --session <id>", "Session ID"],
];

/**
 * Short flags no subcommand may reuse: the globals above plus commander's own
 * built-ins (`-V` for --version, `-h` for --help).
 */
export function reservedShortFlags(): Set<string> {
  const reserved = new Set<string>(["-V", "-h"]);
  for (const [flags] of GLOBAL_OPTIONS) {
    const short = flags.split(",")[0]?.trim();
    if (short && /^-[A-Za-z]$/.test(short)) reserved.add(short);
  }
  return reserved;
}

/** Apply the global options to the root program. */
export function applyGlobalOptions(program: Command): Command {
  for (const [flags, description] of GLOBAL_OPTIONS) program.option(flags, description);
  return program;
}
