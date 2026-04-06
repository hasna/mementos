import type { Command } from "commander";
import chalk from "chalk";

export function registerSynthesisCommand(program: Command): void {
  // ============================================================================
  // synthesis commands
  // ============================================================================

  const synthesisCmd = program
    .command("synthesis")
    .alias("synth")
    .description("ALMA memory synthesis — analyze and consolidate memories");

  synthesisCmd
    .command("run")
    .description("Run memory synthesis on the corpus")
    .option("--project <id>", "Project ID to synthesize")
    .option("--dry-run", "Preview proposals without applying them")
    .option("--max-proposals <n>", "Maximum proposals to generate", "20")
    .option("--provider <name>", "LLM provider (anthropic, openai, cerebras, grok)")
    .action(async (opts) => {
      const { runSynthesis } = await import("../../lib/synthesis/index.js");
      console.log(chalk.blue("Running memory synthesis..."));
      const result = await runSynthesis({
        projectId: opts.project,
        dryRun: opts.dryRun ?? false,
        maxProposals: opts.maxProposals ? parseInt(opts.maxProposals) : 20,
        provider: opts.provider,
      });
      if (result.dryRun) {
        console.log(chalk.yellow(`DRY RUN — ${result.proposals.length} proposals generated (not applied)`));
      } else {
        console.log(chalk.green(`✓ Synthesis complete`));
        console.log(`  Corpus:    ${result.run.corpus_size} memories`);
        console.log(`  Proposals: ${result.run.proposals_generated} generated, ${result.run.proposals_accepted} applied`);
      }
      if (result.metrics) {
        console.log(`  Reduction: ${(result.metrics.corpusReduction * 100).toFixed(1)}%`);
      }
      console.log(`  Run ID: ${chalk.cyan(result.run.id)}`);
    });

  synthesisCmd
    .command("status")
    .description("Show recent synthesis runs")
    .option("--project <id>", "Filter by project")
    .action(async (opts) => {
      const { listSynthesisRuns } = await import("../../db/synthesis.js");
      const runs = listSynthesisRuns({ project_id: opts.project, limit: 10 });
      if (runs.length === 0) {
        console.log(chalk.gray("No synthesis runs found."));
        return;
      }
      for (const run of runs) {
        const statusColor = run.status === "completed" ? chalk.green : run.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`${chalk.cyan(run.id)} [${statusColor(run.status)}] corpus=${run.corpus_size} accepted=${run.proposals_accepted}/${run.proposals_generated} ${run.started_at.slice(0,10)}`);
      }
    });

  synthesisCmd
    .command("rollback <runId>")
    .description("Roll back a synthesis run")
    .action(async (runId: string) => {
      const { rollbackSynthesis } = await import("../../lib/synthesis/index.js");
      console.log(chalk.yellow(`Rolling back synthesis run ${runId}...`));
      const result = await rollbackSynthesis(runId);
      console.log(chalk.green(`✓ Rolled back ${result.rolled_back} proposals`));
      if (result.errors.length > 0) {
        console.log(chalk.red(`  Errors: ${result.errors.join(", ")}`));
      }
    });
}
