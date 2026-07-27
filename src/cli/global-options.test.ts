import { describe, test, expect } from "bun:test";
import { Command } from "commander";
import { GLOBAL_OPTIONS, applyGlobalOptions, reservedShortFlags } from "./global-options.js";
import { registerAllCommands } from "./register-all.js";

// Structural guard for the root cause of HC-00149.
//
// commander resolves a short flag appearing after a subcommand name to the
// PARENT command's option. A subcommand that declares a short already owned by a
// global therefore has a flag that can never receive a value — while --help
// still advertises it. That is how `-s, --scope` on 14 subcommands silently
// routed scope values into `--session`, writing session_id instead of scope and
// reporting success.
//
// This walks the REAL option tables (not a regex over source), so it stays true
// as commands are added.
//
// It builds the tree through `registerAllCommands` — the SAME function
// `index.tsx` uses — because re-listing the groups here was itself a hole: the
// hand-written list covered 11 groups while the CLI wired 15 sources, leaving
// `init`, `project-panel`, `brains`, `events` and `webhooks` unwalked. Seven live
// `-j` collisions sat in that blind spot while this guard reported clean.
function buildProgram(): Command {
  const program = new Command();
  program.name("mementos");
  applyGlobalOptions(program);
  registerAllCommands(program);
  return program;
}

/**
 * Collisions owned by an external package, which this repo cannot fix in place.
 *
 * All of these are `-j, --json` on `@hasna/events`' own `events`/`webhooks`
 * subcommands. They are materially less severe than the `-s, --scope` case this
 * guard was written for: both the global and the subcommand flag are the same
 * boolean `--json`, and `mementos events list -j` was measured to still emit
 * JSON — so the flag does not misroute a VALUE into another column, it just
 * resolves to the parent's identical option.
 *
 * Listed one by one (never a wildcard) so this stays a bounded, named exception:
 * a NEW collision — including any other short on these same commands — still
 * fails the suite. Fixing them belongs upstream in @hasna/events.
 */
const EXTERNAL_KNOWN_COLLISIONS: ReadonlySet<string> = new Set([
  "webhooks add -j",
  "webhooks list -j",
  "webhooks remove -j",
  "webhooks test -j",
  "events emit -j",
  "events list -j",
  "events replay -j",
]);

/** Every (command path, short flag) pair declared below the root. */
function collectSubcommandShorts(cmd: Command, path: string[] = []): Array<{ path: string; short: string; long: string }> {
  const found: Array<{ path: string; short: string; long: string }> = [];
  for (const sub of cmd.commands) {
    const here = [...path, sub.name()];
    for (const opt of sub.options) {
      if (opt.short) found.push({ path: here.join(" "), short: opt.short, long: opt.long ?? opt.short });
    }
    found.push(...collectSubcommandShorts(sub, here));
  }
  return found;
}

describe("global option short flags", () => {
  test("no subcommand reuses a short flag owned by a global option", () => {
    const reserved = reservedShortFlags();
    const collisions = collectSubcommandShorts(buildProgram())
      .filter((o) => reserved.has(o.short))
      .filter((o) => !EXTERNAL_KNOWN_COLLISIONS.has(`${o.path} ${o.short}`));

    // Named so a failure says which command and flag, not just a count.
    expect(collisions.map((c) => `${c.path} ${c.short}, ${c.long}`)).toEqual([]);
  });

  test("the guard walks the whole shipped tree, including the externally-owned groups", () => {
    // Anti-vacuity: proves buildProgram() actually reaches the groups that used
    // to be invisible. If registerAllCommands stops wiring one of these, the
    // guard would go quietly blind again rather than fail — so assert presence.
    const paths = new Set(collectSubcommandShorts(buildProgram()).map((o) => o.path.split(" ")[0]));
    for (const group of ["events", "webhooks"]) {
      expect(paths.has(group)).toBe(true);
    }
  });

  test("every externally-owned exception still exists (no stale allowlist entries)", () => {
    // An exception that no longer corresponds to a real collision means the
    // upstream flag was fixed and the entry must be deleted — otherwise the
    // allowlist silently widens the guard over time.
    const reserved = reservedShortFlags();
    const actual = new Set(
      collectSubcommandShorts(buildProgram())
        .filter((o) => reserved.has(o.short))
        .map((o) => `${o.path} ${o.short}`),
    );
    for (const entry of EXTERNAL_KNOWN_COLLISIONS) {
      expect(actual.has(entry)).toBe(true);
    }
    expect(actual.size).toBe(EXTERNAL_KNOWN_COLLISIONS.size);
  });

  test("the guard actually detects a collision when one is introduced", () => {
    // POSITIVE CONTROL. Without this, the assertion above could pass because
    // collectSubcommandShorts returns nothing rather than because the tree is
    // clean — the same vacuous-check shape this guard exists to prevent.
    const program = new Command();
    program.name("mementos");
    applyGlobalOptions(program);
    program.command("planted").option("-s, --scope <scope>", "shadowed on purpose");

    const reserved = reservedShortFlags();
    const collisions = collectSubcommandShorts(program).filter((o) => reserved.has(o.short));
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.path).toBe("planted");
    expect(collisions[0]!.short).toBe("-s");
  });

  test("the traversal reaches nested subcommands, not just the top level", () => {
    // Guards against a false clean verdict from never descending. `mementos
    // brains`/`project` style groups nest their options one level down.
    const program = new Command();
    program.name("mementos");
    applyGlobalOptions(program);
    const group = program.command("group");
    group.command("inner").option("-a, --agent <x>", "shadowed on purpose");

    const collisions = collectSubcommandShorts(program).filter((o) => reservedShortFlags().has(o.short));
    expect(collisions.map((c) => c.path)).toEqual(["group inner"]);
  });

  test("reservedShortFlags covers every global plus commander's built-ins", () => {
    const reserved = reservedShortFlags();
    for (const [flags] of GLOBAL_OPTIONS) {
      const short = flags.split(",")[0]!.trim();
      expect(reserved.has(short)).toBe(true);
    }
    expect(reserved.has("-V")).toBe(true);
    expect(reserved.has("-h")).toBe(true);
  });
});
