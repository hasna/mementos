import type { Command } from "commander";
import { makeHandleError } from "../helpers.js";
import { registerCrudCommands } from "./memory-cmd-crud.js";
import { registerViewCommands } from "./memory-cmd-view.js";
import { registerWatchCommands } from "./memory-cmd-watch.js";
import { registerUtilCommands } from "./memory-cmd-util.js";
import { registerRecallCommand } from "./memory-cmd-recall.js";
import { registerListCommand } from "./memory-cmd-list.js";

export function registerMemoryCommands(program: Command): void {
  makeHandleError(program);
  registerCrudCommands(program);
  registerViewCommands(program);
  registerWatchCommands(program);
  registerUtilCommands(program);
  registerRecallCommand(program);
  registerListCommand(program);
}
