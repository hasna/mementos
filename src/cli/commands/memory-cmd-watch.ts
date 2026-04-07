import type { Command } from "commander";
import { makeHandleError } from "../helpers.js";
import { registerTailCommand } from "./memory-cmd-tail.js";
import { registerDiffCommand } from "./memory-cmd-diff.js";

export function registerWatchCommands(program: Command): void {
  makeHandleError(program);

  registerTailCommand(program);
  registerDiffCommand(program);
}
