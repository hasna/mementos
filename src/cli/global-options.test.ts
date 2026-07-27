import { describe, test, expect } from "bun:test";
import { Command } from "commander";
import { GLOBAL_OPTIONS, applyGlobalOptions, reservedShortFlags } from "./global-options.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerInfoCommands } from "./commands/info.js";
import { registerIoCommands } from "./commands/io.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerEntityCommands } from "./commands/entity.js";
import { registerRelationCommands } from "./commands/relation.js";
import { registerGraphCommands } from "./commands/graph.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerConsolidationCommands } from "./commands/consolidation.js";

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
function buildProgram(): Command {
  const program = new Command();
  program.name("mementos");
  applyGlobalOptions(program);
  registerMemoryCommands(program);
  registerInfoCommands(program);
  registerIoCommands(program);
  registerAgentCommands(program);
  registerProjectCommands(program);
  registerEntityCommands(program);
  registerRelationCommands(program);
  registerGraphCommands(program);
  registerSystemCommands(program);
  registerStorageCommands(program);
  registerConsolidationCommands(program);
  return program;
}

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
    const collisions = collectSubcommandShorts(buildProgram()).filter((o) => reserved.has(o.short));

    // Named so a failure says which command and flag, not just a count.
    expect(collisions.map((c) => `${c.path} ${c.short}, ${c.long}`)).toEqual([]);
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
