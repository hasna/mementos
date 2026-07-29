import type { Command } from "commander";
import chalk from "chalk";
import { getActiveProfile, setActiveProfile, listProfiles, deleteProfile } from "../../lib/config.js";
import { outputJson, type GlobalOpts } from "../helpers.js";

export function registerProfileCommand(program: Command): void {
  // ============================================================================
  // profile commands
  // ============================================================================

  const profileCmd = program.command("profile").description("Manage named profile files and active-profile metadata");

  profileCmd
    .command("list")
    .description("List all available profiles")
    .action(() => {
      const globalOpts = program.opts<GlobalOpts>();
      const profiles = listProfiles();
      const active = getActiveProfile();
      if (globalOpts.json) {
        outputJson({ profiles, active: active ?? null });
        return;
      }
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
        console.log(chalk.dim("\n  (no active-profile metadata set)"));
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
        console.log(chalk.dim("No active-profile metadata set."));
      }
    });

  profileCmd
    .command("set <name>")
    .description("Set the active-profile metadata")
    .action((name: string) => {
      const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!clean) {
        console.error(chalk.red("Invalid profile name. Use letters, numbers, hyphens, underscores."));
        process.exit(1);
      }
      setActiveProfile(clean);
      console.log(chalk.green(`✓ Active-profile metadata set: ${clean}`));
      console.log(chalk.dim(`  Profile file: ~/.hasna/mementos/profiles/${clean}.db`));
      console.log(chalk.dim("  Run `mementos storage mode` to verify the live runtime database."));
    });

  profileCmd
    .command("unset")
    .description("Clear the active-profile metadata")
    .action(() => {
      const was = getActiveProfile();
      setActiveProfile(null);
      if (was) {
        console.log(chalk.green(`✓ Cleared profile (was: ${was})`));
      } else {
        console.log(chalk.dim("No active profile was set."));
      }
      console.log(chalk.dim("  Run `mementos storage mode` to verify the live runtime database."));
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
