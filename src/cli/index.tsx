#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getDatabase } from "../db/database.js";
import { getPrimaryMachineStartupWarning } from "../db/machines.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerInfoCommands } from "./commands/info.js";
import { registerIoCommands } from "./commands/io.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerEntityCommands } from "./commands/entity.js";
import { registerRelationCommands } from "./commands/relation.js";
import { registerGraphCommands } from "./commands/graph.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerInitCommand } from "./commands/init.js";
import { makeBrainsCommand } from "./brains.js";

// ============================================================================
// Version
// ============================================================================

function getPackageVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version?: string;
    };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ============================================================================
// Program
// ============================================================================

const program = new Command();

program
  .name("mementos")
  .description("Universal memory system for AI agents")
  .version(getPackageVersion())
  .option("-p, --project <path>", "Project path for scoping")
  .option("-j, --json", "Output as JSON")
  .option("-f, --format <fmt>", "Output format: compact, json, csv, yaml")
  .option("-a, --agent <name>", "Agent name or ID")
  .option("-s, --session <id>", "Session ID");

let startupWarningShown = false;
program.hook("preAction", () => {
  if (startupWarningShown) return;
  startupWarningShown = true;
  try {
    const warning = getPrimaryMachineStartupWarning(getDatabase());
    if (warning) {
      console.warn(`[mementos] ${warning}`);
    }
  } catch {
    // Best-effort warning only — startup should continue.
  }
});

// ============================================================================
// Register all command groups
// ============================================================================

registerInitCommand(program);
registerMemoryCommands(program);
registerInfoCommands(program);
registerIoCommands(program);
registerAgentCommands(program);
registerProjectCommands(program);
registerEntityCommands(program);
registerRelationCommands(program);
registerGraphCommands(program);
registerSystemCommands(program);
program.addCommand(makeBrainsCommand());

// ============================================================================
// Parse and run
// ============================================================================

program.parse(process.argv);
