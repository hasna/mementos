import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getAgent } from "../../db/agents.js";
import { getProject } from "../../db/projects.js";
import { runConsolidation } from "../../lib/consolidation.js";
import { reflectOnTrajectory, type ReflectionTarget } from "../../lib/reflection.js";
import type { MemoryScope } from "../../types/index.js";
import { getOutputFormat, outputJson, type GlobalOpts } from "../helpers.js";

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
}

function resolveAgentId(nameOrId: string | undefined): string | undefined {
  if (!nameOrId) return undefined;
  return getAgent(nameOrId)?.id ?? nameOrId;
}

function resolveProjectId(pathOrId: string | undefined): string | undefined {
  if (!pathOrId) return undefined;
  return getProject(resolve(pathOrId))?.id ?? getProject(pathOrId)?.id ?? pathOrId;
}

export function registerConsolidationCommands(program: Command): void {
  program
    .command("consolidate")
    .description("Consolidate memories: dedup, promote, summarize, and soft-delete stale low-value entries")
    .option("--dry-run", "Plan actions without mutating memories")
    .option("--scope <scope>", "Scope to consolidate: global, shared, private")
    .option("--project <idOrPath>", "Project ID, name, or path")
    .option("--agent <nameOrId>", "Agent name or ID")
    .option("--duplicate-threshold <n>", "Near-duplicate similarity threshold 0-1", parseNumber)
    .option("--stale-days <n>", "Minimum age for decay/forget candidates", parseNumber)
    .option("--decay-threshold <n>", "Maximum decay score for soft-delete candidates", parseNumber)
    .option("--limit <n>", "Maximum memories to analyze", parseNumber)
    .option("--format <fmt>", "Output format: compact, json")
    .action(async (opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const format = getOutputFormat(program, opts.format);
        const result = await runConsolidation({
          dryRun: opts.dryRun ?? false,
          scope: opts.scope as MemoryScope | undefined,
          projectId: resolveProjectId(opts.project ?? globalOpts.project),
          agentId: resolveAgentId(opts.agent ?? globalOpts.agent),
          duplicateThreshold: opts.duplicateThreshold,
          staleDays: opts.staleDays,
          decayThreshold: opts.decayThreshold,
          limit: opts.limit,
        });

        if (format === "json") {
          outputJson(result);
          return;
        }

        const mode = result.dryRun ? chalk.yellow("DRY RUN") : chalk.green("APPLIED");
        console.log(`${mode} consolidation run ${chalk.cyan(result.run.id)}`);
        console.log(`Planned: ${result.summary.planned}  Applied: ${result.summary.applied}`);
        for (const action of result.actions.slice(0, 20)) {
          const status = action.applied ? chalk.green("applied") : chalk.gray("planned");
          console.log(`- ${status} ${action.type}: ${action.reason}`);
        }
      } catch (error) {
        if (program.opts<GlobalOpts>().json) {
          outputJson({ error: error instanceof Error ? error.message : String(error) });
        } else {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        }
        process.exit(1);
      }
    });

  program
    .command("reflect")
    .description("Reflect on a session, task, or range and save structured lessons")
    .requiredOption("--on <target>", "Trajectory target: session, task, range")
    .option("--source <idOrRange>", "Session ID, task ID, or range as since..until")
    .option("--dry-run", "Critique without writing lesson memories")
    .option("--project <idOrPath>", "Project ID, name, or path")
    .option("--agent <nameOrId>", "Agent name or ID")
    .option("--since <iso>", "Range start timestamp")
    .option("--until <iso>", "Range end timestamp")
    .option("--provider <name>", "Critic provider: anthropic, openai, cerebras, grok")
    .option("--model <name>", "Critic model")
    .option("--max-tokens <n>", "Maximum critic output tokens", parseNumber)
    .option("--format <fmt>", "Output format: compact, json")
    .action(async (opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const target = opts.on as ReflectionTarget;
        if (!["session", "task", "range"].includes(target)) {
          throw new Error("--on must be one of: session, task, range");
        }

        const source = opts.source ?? (target === "session" ? globalOpts.session : undefined);
        if ((target === "session" || target === "task") && !source) {
          throw new Error(`--source is required when --on ${target}`);
        }

        const result = await reflectOnTrajectory({
          on: target,
          source,
          dryRun: opts.dryRun ?? false,
          projectId: resolveProjectId(opts.project ?? globalOpts.project),
          agentId: resolveAgentId(opts.agent ?? globalOpts.agent),
          since: opts.since,
          until: opts.until,
          provider: opts.provider,
          model: opts.model,
          maxTokens: opts.maxTokens,
        });

        const format = getOutputFormat(program, opts.format);
        if (format === "json") {
          outputJson(result);
          return;
        }

        const mode = result.dryRun ? chalk.yellow("DRY RUN") : chalk.green("SAVED");
        console.log(`${mode} reflection run ${chalk.cyan(result.run.id)}`);
        console.log(`Trajectory memories: ${result.trajectory.memoryIds.length}  Lessons: ${result.lessons.length}`);
        for (const lesson of result.lessons) {
          console.log(`- ${lessonTagForCli(lesson.kind)} (${lesson.importance}/10): ${lesson.lesson}`);
        }
      } catch (error) {
        if (program.opts<GlobalOpts>().json) {
          outputJson({ error: error instanceof Error ? error.message : String(error) });
        } else {
          console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        }
        process.exit(1);
      }
    });
}

function lessonTagForCli(kind: string): string {
  if (kind === "worked") return "worked";
  if (kind === "failed") return "failed";
  return "do-differently";
}
