// brains CLI subcommand for @hasna/mementos
// Provides gather/train/model commands for fine-tuning integration

import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { gatherTrainingData } from "../lib/gatherer.js";
import {
  getActiveModel,
  setActiveModel,
  clearActiveModel,
  DEFAULT_MODEL,
} from "../lib/model-config.js";

// ============================================================================
// Helpers
// ============================================================================

function printSuccess(msg: string): void {
  console.log(chalk.green("✓ " + msg));
}

function printError(msg: string): void {
  console.error(chalk.red("✗ " + msg));
}

function printInfo(msg: string): void {
  console.log(chalk.cyan("ℹ " + msg));
}

// ============================================================================
// brains command
// ============================================================================

export function makeBrainsCommand(): Command {
  const brains = new Command("brains");
  brains.description("Fine-tuned model training and management (via @hasna/brains)");

  // ── gather ────────────────────────────────────────────────────────────────

  brains
    .command("gather")
    .description("Gather training data from memories and write to JSONL")
    .option("--limit <n>", "Maximum number of examples to gather", parseInt)
    .option("--since <date>", "Only include memories created since this date (ISO 8601)")
    .option("--output <dir>", "Output directory (default: ~/.mementos/training/)")
    .option("--json", "Output result summary as JSON")
    .action(
      async (opts: {
        limit?: number;
        since?: string;
        output?: string;
        json?: boolean;
      }) => {
        try {
          const since = opts.since ? new Date(opts.since) : undefined;
          if (since && isNaN(since.getTime())) {
            printError(`Invalid date: ${opts.since}`);
            process.exit(1);
          }

          if (!opts.json) {
            printInfo("Gathering training data from memories...");
          }

          const result = await gatherTrainingData({
            limit: opts.limit,
            since,
          });

          const outputDir =
            opts.output ?? join(homedir(), ".mementos", "training");
          if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
          }

          const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, "-")
            .slice(0, 19);
          const outputPath = join(
            outputDir,
            `mementos-training-${timestamp}.jsonl`
          );

          const jsonl = result.examples
            .map((ex) => JSON.stringify(ex))
            .join("\n");
          writeFileSync(outputPath, jsonl + "\n", "utf-8");

          if (opts.json) {
            console.log(
              JSON.stringify({
                source: result.source,
                count: result.count,
                path: outputPath,
              })
            );
          } else {
            printSuccess(
              `Gathered ${result.count} training examples from memories`
            );
            console.log(chalk.dim(`  Output: ${outputPath}`));
          }
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  // ── train ─────────────────────────────────────────────────────────────────

  brains
    .command("train")
    .description("Start a fine-tuning job using gathered memory training data")
    .option("--base-model <model>", "Base model to fine-tune", "gpt-4o-mini-2024-07-18")
    .option("--provider <provider>", "Provider (openai|thinker-labs)", "openai")
    .option("--dataset <path>", "Path to JSONL dataset (auto-detects latest if omitted)")
    .option("--name <name>", "Display name for the fine-tuned model")
    .option("--json", "Output result as JSON")
    .action(
      async (opts: {
        baseModel: string;
        provider: string;
        dataset?: string;
        name?: string;
        json?: boolean;
      }) => {
        try {
          // Resolve dataset path
          let datasetPath = opts.dataset;
          if (!datasetPath) {
            const trainingDir = join(
              homedir(),
              ".mementos",
              "training"
            );
            if (!existsSync(trainingDir)) {
              printError(
                "No training data found. Run `mementos brains gather` first."
              );
              process.exit(1);
            }
            const files = readdirSync(trainingDir)
              .filter((f) => f.endsWith(".jsonl"))
              .sort()
              .reverse();
            const latestFile = files[0];
            if (!latestFile) {
              printError(
                "No JSONL training files found. Run `mementos brains gather` first."
              );
              process.exit(1);
            }
            datasetPath = join(trainingDir, latestFile);
          }

          if (!datasetPath || !existsSync(datasetPath)) {
            printError(`Dataset file not found: ${datasetPath ?? "(unresolved)"}`);
            process.exit(1);
          }

          if (!opts.json) {
            printInfo(
              `Starting fine-tuning job with dataset: ${datasetPath}`
            );
          }

          // Delegate to @hasna/brains SDK
          let brainsSDK: Record<string, unknown>;
          try {
            // @ts-ignore — optional peer dependency
            brainsSDK = (await import("@hasna/brains")) as Record<
              string,
              unknown
            >;
          } catch {
            printError(
              "@hasna/brains is not installed. Run `bun add @hasna/brains` to enable training."
            );
            process.exit(1);
          }

          const startFinetune = brainsSDK["startFinetune"] as
            | ((opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
            | undefined;
          if (typeof startFinetune !== "function") {
            printError(
              "@hasna/brains does not export startFinetune. Please update @hasna/brains."
            );
            process.exit(1);
          }

          const modelName = opts.name ?? `mementos-${new Date().toISOString().slice(0, 10)}`;
          const jobResult = await startFinetune({
            provider: opts.provider,
            baseModel: opts.baseModel,
            datasetPath,
            name: modelName,
          });

          if (opts.json) {
            console.log(JSON.stringify(jobResult));
          } else {
            printSuccess(`Fine-tuning job started: ${String(jobResult["jobId"] ?? "(unknown)")}`);
            console.log(chalk.dim(`  Provider:   ${opts.provider}`));
            console.log(chalk.dim(`  Base model: ${opts.baseModel}`));
            console.log(chalk.dim(`  Name:       ${modelName}`));
            if (jobResult["jobId"]) {
              console.log();
              printInfo(
                `Use \`mementos brains model set <model-id>\` once training completes.`
              );
            }
          }
        } catch (err) {
          printError(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  // ── model ─────────────────────────────────────────────────────────────────

  const modelCmd = brains.command("model").description("Manage the active fine-tuned model");

  modelCmd
    .command("get")
    .description("Show the currently active fine-tuned model")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      try {
        const active = getActiveModel();
        const isDefault = active === DEFAULT_MODEL;
        if (opts.json) {
          console.log(JSON.stringify({ activeModel: active, isDefault }));
        } else {
          if (isDefault) {
            console.log(
              `Active model: ${chalk.cyan(active)} ${chalk.dim("(default)")}`
            );
          } else {
            console.log(`Active model: ${chalk.green(active)}`);
          }
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  modelCmd
    .command("set <modelId>")
    .description("Set the active fine-tuned model ID")
    .action((modelId: string) => {
      try {
        setActiveModel(modelId);
        printSuccess(`Active model set to: ${modelId}`);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  modelCmd
    .command("clear")
    .description(`Clear the active fine-tuned model (reverts to ${DEFAULT_MODEL})`)
    .action(() => {
      try {
        clearActiveModel();
        printSuccess(`Active model cleared. Using default: ${DEFAULT_MODEL}`);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // Default "model" with no subcommand shows the active model
  modelCmd.action((opts: { json?: boolean }) => {
    try {
      const active = getActiveModel();
      const isDefault = active === DEFAULT_MODEL;
      if ((opts as { json?: boolean }).json) {
        console.log(JSON.stringify({ activeModel: active, isDefault }));
      } else {
        if (isDefault) {
          console.log(
            `Active model: ${chalk.cyan(active)} ${chalk.dim("(default)")}`
          );
        } else {
          console.log(`Active model: ${chalk.green(active)}`);
        }
      }
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

  return brains;
}
