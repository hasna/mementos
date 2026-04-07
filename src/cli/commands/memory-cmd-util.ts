import type { Command } from "commander";
import { makeHandleError } from "../helpers.js";
import { registerSearchCommand } from "./memory-cmd-search.js";
import { registerWhenToUseCommand } from "./memory-cmd-when-to-use.js";
import { registerChainCommand } from "./memory-cmd-chain.js";
import { registerBulkCommand } from "./memory-cmd-bulk.js";
import { registerRemoveCommand } from "./memory-cmd-remove.js";

export function registerUtilCommands(program: Command): void {
  makeHandleError(program);

  registerSearchCommand(program);
  registerWhenToUseCommand(program);
  registerChainCommand(program);
  registerBulkCommand(program);
  registerRemoveCommand(program);
}
