import type { Command } from "commander";
import { makeHandleError } from "../helpers.js";
import { registerDoctorCommand } from "./system-doctor.js";
import { registerConfigCommand } from "./system-config.js";
import { registerProfileCommand } from "./system-profile.js";
import { registerAutoMemoryCommand } from "./system-auto-memory.js";
import { registerHooksCommand } from "./system-hooks.js";
import { registerSynthesisCommand } from "./system-synthesis.js";
import { registerSessionCommand } from "./system-session.js";
import { registerToolsCommand } from "./system-tools.js";
import { registerSynthesizedProfileCommand } from "./system-synthesized-profile.js";
import { registerSessionsCommand } from "./system-sessions.js";
import { registerMiscCommands } from "./system-misc.js";
import { registerMcpCommand } from "./system-mcp.js";
import { registerWatchCommand } from "./system-watch.js";
import { registerCompletionsCommand } from "./system-completions.js";

export function registerSystemCommands(program: Command): void {
  makeHandleError(program);

  // Register extracted command groups
  registerDoctorCommand(program);
  registerConfigCommand(program);
  registerProfileCommand(program);
  registerAutoMemoryCommand(program);
  registerHooksCommand(program);
  registerSynthesisCommand(program);
  registerSessionCommand(program);
  registerToolsCommand(program);
  registerSynthesizedProfileCommand(program);
  registerSessionsCommand(program);
  registerMiscCommands(program);

  registerMcpCommand(program);
  registerWatchCommand(program);
  registerCompletionsCommand(program);
}
