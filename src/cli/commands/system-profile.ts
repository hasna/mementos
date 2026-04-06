import type { Command } from "commander";
import chalk from "chalk";
import { getActiveProfile, setActiveProfile, listProfiles, deleteProfile } from "../../lib/config.js";

export function registerProfileCommand(program: Command): void {
  // ============================================================================
  // profile commands
  // ============================================================================

  const profileCmd = program.command("profile").description("Manage memory profiles (isolated DBs per context)");

  profileCmd
    .command("list")
    .description("List all available profiles")
    .action(() => {
      const profiles = listProfiles();
      const active = getActiveProfile();
      if (profiles.length === 0) {
        console.log(chalk.dim("No profiles yet. Create one with: mementos profile set <name>"));
        return;
      }
      console.log(chalk.bold("Profiles:"));
      for (const p of profiles) {
        const marker = p === active ? chalk.green(" ✓ (active)") : "";
        console.log(`  ${p}${marker}`);
      }
      if (!active) {
        console.log(chalk.dim("\n  (no active profile — using default DB)"));
      }
    });

  profileCmd
    .command("get")
    .description("Show the currently active profile")
    .action(() => {
      const active = getActiveProfile();
      if (active) {
        console.log(chalk.green(`Active profile: ${active}`));
        if (!process.env["MEMENTOS_PROFILE"]) {
          console.log(chalk.dim("(persisted in ~/.hasna/mementos/config.json)"));
        } else {
          console.log(chalk.dim("(from MEMENTOS_PROFILE env var)"));
        }
      } else {
        console.log(chalk.dim("No active profile — using default DB (~/.hasna/mementos/mementos.db)"));
      }
    });

  profileCmd
    .command("set <name>")
    .description("Switch to a named profile (creates the DB on first use)")
    .action((name: string) => {
      const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!clean) {
        console.error(chalk.red("Invalid profile name. Use letters, numbers, hyphens, underscores."));
        process.exit(1);
      }
      setActiveProfile(clean);
      console.log(chalk.green(`✓ Switched to profile: ${clean}`));
      console.log(chalk.dim(`  DB: ~/.hasna/mementos/profiles/${clean}.db (created on first use)`));
    });

  profileCmd
    .command("unset")
    .description("Clear the active profile (revert to default DB)")
    .action(() => {
      const was = getActiveProfile();
      setActiveProfile(null);
      if (was) {
        console.log(chalk.green(`✓ Cleared profile (was: ${was})`));
      } else {
        console.log(chalk.dim("No active profile was set."));
      }
      console.log(chalk.dim("  Now using default DB: ~/.hasna/mementos/mementos.db"));
    });

  profileCmd
    .command("delete <name>")
    .description("Delete a profile and its DB file (irreversible)")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const profiles = listProfiles();
        if (!profiles.includes(name)) {
          console.error(chalk.red(`Profile not found: ${name}`));
          process.exit(1);
        }
        // Simple readline confirmation
        process.stdout.write(chalk.yellow(`Delete profile "${name}" and its DB? This cannot be undone. [y/N] `));
        const answer = await new Promise<string>((resolve) => {
          process.stdin.once("data", (d) => resolve(d.toString().trim().toLowerCase()));
        });
        if (answer !== "y" && answer !== "yes") {
          console.log(chalk.dim("Cancelled."));
          return;
        }
      }
      const deleted = deleteProfile(name);
      if (deleted) {
        console.log(chalk.green(`✓ Profile "${name}" deleted.`));
      } else {
        console.error(chalk.red(`Profile not found: ${name}`));
        process.exit(1);
      }
    });
}
