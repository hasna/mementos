#!/usr/bin/env bun
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getDatabase } from "../db/database.js";
import { getPrimaryMachineStartupWarning } from "../db/machines.js";
import { skipsStartupDbAccess } from "./startup-side-effects.js";
import { applyGlobalOptions } from "./global-options.js";
import { registerAllCommands } from "./register-all.js";

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
  .version(getPackageVersion());

// Declared in one place so the "no subcommand may reuse a global short flag"
// invariant is testable rather than a review convention. See global-options.ts.
applyGlobalOptions(program);

let startupWarningShown = false;
program.hook("preAction", (_thisCommand, actionCommand) => {
  // Diagnostic commands opt out: opening the database here would create and
  // migrate the very file a side-effect-free probe only means to report on.
  if (skipsStartupDbAccess(actionCommand)) return;
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
// The list itself lives in register-all.ts so the short-flag guard test walks
// the SAME tree that ships. See register-all.ts for why that matters.

registerAllCommands(program);

// ============================================================================
// Parse and run
// ============================================================================

program.parse(process.argv);
