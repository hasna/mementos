import type { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";

import { registerMemoryCommands } from "./commands/memory.js";
import { registerInfoCommands } from "./commands/info.js";
import { registerIoCommands } from "./commands/io.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerProjectPanelCommand } from "./commands/project-panel.js";
import { registerEntityCommands } from "./commands/entity.js";
import { registerRelationCommands } from "./commands/relation.js";
import { registerGraphCommands } from "./commands/graph.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerInitCommand } from "./commands/init.js";
import { registerConsolidationCommands } from "./commands/consolidation.js";
import { makeBrainsCommand } from "./brains.js";

/**
 * Attach EVERY command group to `program`, in the order the CLI presents them.
 *
 * This is the single registration list. `index.tsx` calls it to build the real
 * CLI, and `global-options.test.ts` calls it to walk the real option tables — so
 * the structural short-flag guard cannot silently check a smaller tree than the
 * one that ships.
 *
 * That drift was real: the guard originally re-listed 11 groups by hand while
 * the CLI wired 15 sources, leaving `init`, `project-panel`, `brains` and the
 * `@hasna/events` groups (`events`, `webhooks`) unwalked. Seven live `-j`
 * collisions sat in that blind spot while the guard reported clean. Adding a
 * command group here is now the only step required for it to be covered.
 */
export function registerAllCommands(program: Command): Command {
  registerInitCommand(program);
  registerMemoryCommands(program);
  registerInfoCommands(program);
  registerIoCommands(program);
  registerAgentCommands(program);
  registerProjectCommands(program);
  registerProjectPanelCommand(program);
  registerEntityCommands(program);
  registerRelationCommands(program);
  registerGraphCommands(program);
  registerSystemCommands(program);
  registerStorageCommands(program);
  registerConsolidationCommands(program);
  program.addCommand(makeBrainsCommand());
  registerEventsCommands(program, { source: "mementos" });
  return program;
}
