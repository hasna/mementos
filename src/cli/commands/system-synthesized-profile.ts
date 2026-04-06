import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { outputJson, makeHandleError } from "../helpers.js";
import type { GlobalOpts } from "../helpers.js";

export function registerSynthesizedProfileCommand(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // synthesized-profile [--refresh]
  // ============================================================================

  program
    .command("synthesized-profile")
    .description("Show or refresh the synthesized agent/project profile")
    .option("--project-id <id>", "Project ID")
    .option("--refresh", "Force refresh the profile (re-synthesize from memories)")
    .action(async (opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { synthesizeProfile } = await import("../../lib/profile-synthesizer.js");

        let projectId = opts.projectId as string | undefined;
        if (!projectId && globalOpts.project) {
          const { getProject } = require("../../db/projects.js") as typeof import("../../db/projects.js");
          const project = getProject(resolve(globalOpts.project));
          if (project) projectId = project.id;
        }

        const result = await synthesizeProfile({
          project_id: projectId,
          agent_id: globalOpts.agent,
          force_refresh: !!opts.refresh,
        });

        if (!result) {
          if (globalOpts.json) {
            outputJson({ error: "No profile available (no preference/fact memories found)" });
          } else {
            console.log(chalk.yellow("No profile available — save some preference or fact memories first."));
          }
          return;
        }

        if (globalOpts.json) {
          outputJson(result);
          return;
        }

        if (result.from_cache) {
          console.log(chalk.dim("(cached profile)\n"));
        } else {
          console.log(chalk.dim(`(synthesized from ${result.memory_count} memories)\n`));
        }
        console.log(result.profile);
      } catch (e) {
        handleError(e);
      }
    });
}
