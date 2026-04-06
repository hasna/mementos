import type { Command } from "commander";
import chalk from "chalk";

export function registerAutoMemoryCommand(program: Command): void {
  // ============================================================================
  // auto-memory commands
  // ============================================================================

  const autoMemory = program
    .command("auto-memory")
    .description("LLM-based auto-memory extraction pipeline");

  autoMemory
    .command("process <turn>")
    .description("Enqueue text for async LLM memory extraction (fire-and-forget)")
    .option("--agent <id>", "agent ID")
    .option("--project <id>", "project ID")
    .option("--session <id>", "session ID")
    .option("--sync", "run synchronously and print extracted memories")
    .action(async (turn: string, opts: Record<string, string | boolean>) => {
      const { processConversationTurn, getAutoMemoryStats } = await import("../../lib/auto-memory.js");
      const { providerRegistry } = await import("../../lib/providers/registry.js");
      if (opts.sync) {
        const provider = providerRegistry.getAvailable();
        if (!provider) {
          console.error(chalk.red("No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, CEREBRAS_API_KEY, or XAI_API_KEY."));
          process.exit(1);
        }
        console.log(chalk.dim(`Using ${provider.name} / ${provider.config.model}...`));
        const memories = await provider.extractMemories(turn, {
          agentId: opts.agent as string,
          projectId: opts.project as string,
        });
        if (memories.length === 0) {
          console.log(chalk.dim("Nothing worth remembering extracted."));
        } else {
          memories.forEach((m: any, i: number) => {
            console.log(chalk.bold(`\n[${i + 1}] ${m.category} · importance ${m.importance}/10 · ${m.suggestedScope}`));
            console.log(`  ${m.content}`);
            if (m.tags.length) console.log(chalk.dim(`  tags: ${m.tags.join(", ")}`));
          });
        }
      } else {
        processConversationTurn(turn, {
          agentId: opts.agent as string,
          projectId: opts.project as string,
          sessionId: opts.session as string,
        });
        const stats = getAutoMemoryStats();
        console.log(chalk.green("✓ Queued for extraction"));
        console.log(chalk.dim(`Queue: ${stats.pending} pending · ${stats.processed} processed · ${stats.failed} failed`));
      }
    });

  autoMemory
    .command("status")
    .description("Show auto-memory queue stats and provider health")
    .action(async () => {
      const { getAutoMemoryStats } = await import("../../lib/auto-memory.js");
      const { providerRegistry } = await import("../../lib/providers/registry.js");
      const stats = getAutoMemoryStats();
      const config = providerRegistry.getConfig();
      const health = providerRegistry.health();
      console.log(chalk.bold("Auto-Memory Status"));
      console.log(`  Provider:    ${config.enabled ? chalk.green(config.provider) : chalk.red("disabled")} / ${config.model ?? "default"}`);
      console.log(`  Queue:       ${stats.pending} pending · ${stats.processing} processing · ${stats.processed} processed`);
      console.log(`  Errors:      ${stats.failed} failed · ${stats.dropped} dropped`);
      console.log(chalk.bold("\nProvider Health"));
      for (const [name, info] of Object.entries(health as Record<string, { available: boolean; model: string }>)) {
        const icon = info.available ? chalk.green("✓") : chalk.red("✗");
        console.log(`  ${icon} ${name.padEnd(12)} ${info.model}`);
      }
    });

  autoMemory
    .command("config")
    .description("Show or update auto-memory provider config")
    .option("--provider <name>", "provider: anthropic | openai | cerebras | grok")
    .option("--model <name>", "model name override")
    .option("--min-importance <n>", "minimum importance threshold (0-10)")
    .action(async (opts: Record<string, string>) => {
      const { configureAutoMemory } = await import("../../lib/auto-memory.js");
      const { providerRegistry } = await import("../../lib/providers/registry.js");
      if (opts.provider || opts.model || opts.minImportance) {
        configureAutoMemory({
          ...(opts.provider && { provider: opts.provider as "anthropic" | "openai" | "cerebras" | "grok" }),
          ...(opts.model && { model: opts.model }),
          ...(opts.minImportance && { minImportance: Number(opts.minImportance) }),
        });
        console.log(chalk.green("✓ Config updated"));
      }
      const config = providerRegistry.getConfig();
      console.log(chalk.bold("Auto-Memory Config"));
      console.log(JSON.stringify(config, null, 2));
    });

  autoMemory
    .command("test <turn>")
    .description("Test extraction without saving (dry run)")
    .option("--provider <name>", "force a specific provider")
    .option("--agent <id>", "agent ID for context")
    .option("--project <id>", "project ID for context")
    .action(async (turn: string, opts: Record<string, string>) => {
      const { providerRegistry } = await import("../../lib/providers/registry.js");
      const provider = opts.provider
        ? providerRegistry.getProvider(opts.provider as "anthropic" | "openai" | "cerebras" | "grok")
        : providerRegistry.getAvailable();
      if (!provider) {
        console.error(chalk.red("No LLM provider configured."));
        process.exit(1);
      }
      console.log(chalk.dim(`DRY RUN — ${provider.name} / ${provider.config.model} — nothing will be saved\n`));
      const memories = await provider.extractMemories(turn, {
        agentId: opts.agent,
        projectId: opts.project,
      });
      if (memories.length === 0) {
        console.log(chalk.dim("Nothing extracted."));
      } else {
        memories.forEach((m: any, i: number) => {
          console.log(chalk.bold(`[${i + 1}] ${m.category.toUpperCase()} · importance ${m.importance}/10 · ${m.suggestedScope}`));
          console.log(`  ${chalk.white(m.content)}`);
          if (m.tags.length) console.log(chalk.dim(`  tags: ${m.tags.join(", ")}`));
          if (m.reasoning) console.log(chalk.dim(`  why: ${m.reasoning}`));
          console.log();
        });
      }
    });

  autoMemory
    .command("enable")
    .description("Enable auto-memory extraction")
    .action(async () => {
      const { configureAutoMemory } = await import("../../lib/auto-memory.js");
      configureAutoMemory({ enabled: true });
      console.log(chalk.green("✓ Auto-memory enabled"));
    });

  autoMemory
    .command("disable")
    .description("Disable auto-memory extraction")
    .action(async () => {
      const { configureAutoMemory } = await import("../../lib/auto-memory.js");
      configureAutoMemory({ enabled: false });
      console.log(chalk.yellow("⚠ Auto-memory disabled"));
    });
}
