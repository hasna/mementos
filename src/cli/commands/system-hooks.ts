import type { Command } from "commander";
import chalk from "chalk";
import type { HookType } from "../../types/hooks.js";
import {
  DEFAULT_COMPACT_LIMIT,
  cursorOrOffset,
  positiveIntOrDefault,
  printPageHint,
  truncateText,
} from "../helpers.js";

export function registerHooksCommand(program: Command): void {
  // ============================================================================
  // hooks commands
  // ============================================================================

  const hooksCmd = program
    .command("hooks")
    .description("Hook registry and webhook management");

  hooksCmd
    .command("list")
    .description("List registered hooks in the in-memory registry")
    .option("--type <type>", "Filter by hook type")
    .option("--limit <n>", "Max results (compact default: 20)", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--cursor <n>", "Cursor offset for the next page", parseInt)
    .action(async (opts) => {
      const { hookRegistry } = await import("../../lib/hooks.js");
      const hooks = hookRegistry.list(opts.type);
      const limit = positiveIntOrDefault(opts.limit, DEFAULT_COMPACT_LIMIT);
      const offset = cursorOrOffset(opts.cursor, opts.offset) ?? 0;
      const page = hooks.slice(offset, offset + limit + 1);
      const hasMore = page.length > limit;
      const visibleHooks = hasMore ? page.slice(0, limit) : page;
      if (visibleHooks.length === 0) {
        console.log(chalk.gray("No hooks registered."));
        return;
      }
      for (const h of visibleHooks) {
        const builtinTag = h.builtin ? chalk.blue(" [builtin]") : "";
        const blockingTag = h.blocking ? chalk.red(" [blocking]") : chalk.gray(" [non-blocking]");
        console.log(`${chalk.cyan(h.id)} ${chalk.bold(h.type)}${builtinTag}${blockingTag} priority=${h.priority}`);
        if (h.description) console.log(`  ${chalk.gray(truncateText(h.description, 120))}`);
      }
      printPageHint({
        shown: visibleHooks.length,
        limit,
        offset,
        hasMore,
        command: "mementos hooks list",
        detailHint: "increase --limit to show more hooks",
      });
    });

  hooksCmd
    .command("stats")
    .description("Show hook registry statistics")
    .action(async () => {
      const { hookRegistry } = await import("../../lib/hooks.js");
      const stats = hookRegistry.stats();
      console.log(chalk.bold("Hook Registry Stats"));
      console.log(`  Total:       ${chalk.cyan(stats.total)}`);
      console.log(`  Blocking:    ${chalk.red(stats.blocking)}`);
      console.log(`  Non-blocking:${chalk.green(stats.nonBlocking)}`);
      if (Object.keys(stats.byType).length > 0) {
        console.log(chalk.bold("\nBy type:"));
        for (const [type, count] of Object.entries(stats.byType)) {
          console.log(`  ${type}: ${count}`);
        }
      }
    });

  // ============================================================================
  // webhooks commands
  // ============================================================================

  const webhooksCmd = hooksCmd
    .command("webhooks")
    .alias("wh")
    .description("Manage persistent HTTP webhook hooks");

  webhooksCmd
    .command("list")
    .description("List all persisted webhook hooks")
    .option("--type <type>", "Filter by hook type")
    .option("--disabled", "Show only disabled webhooks")
    .option("--limit <n>", "Max results (compact default: 20)", parseInt)
    .option("--offset <n>", "Offset for pagination", parseInt)
    .option("--cursor <n>", "Cursor offset for the next page", parseInt)
    .action(async (opts) => {
      const { listWebhookHooks } = await import("../../db/webhook_hooks.js");
      const webhooks = listWebhookHooks({
        type: opts.type,
        enabled: opts.disabled ? false : undefined,
      });
      const limit = positiveIntOrDefault(opts.limit, DEFAULT_COMPACT_LIMIT);
      const offset = cursorOrOffset(opts.cursor, opts.offset) ?? 0;
      const page = webhooks.slice(offset, offset + limit + 1);
      const hasMore = page.length > limit;
      const visibleWebhooks = hasMore ? page.slice(0, limit) : page;
      if (visibleWebhooks.length === 0) {
        console.log(chalk.gray("No webhooks registered."));
        return;
      }
      for (const wh of visibleWebhooks) {
        const enabledTag = wh.enabled ? chalk.green("enabled") : chalk.red("disabled");
        const blockingTag = wh.blocking ? chalk.red("blocking") : chalk.gray("non-blocking");
        console.log(`${chalk.cyan(wh.id)} [${enabledTag}] ${chalk.bold(wh.type)} -> ${truncateText(wh.handlerUrl, 96)}`);
        console.log(`  ${blockingTag} | priority=${wh.priority} | invocations=${wh.invocationCount} failures=${wh.failureCount}`);
        if (wh.description) console.log(`  ${chalk.gray(truncateText(wh.description, 120))}`);
      }
      printPageHint({
        shown: visibleWebhooks.length,
        limit,
        offset,
        hasMore,
        command: "mementos hooks webhooks list",
        detailHint: "increase --limit to show more webhooks",
      });
    });

  webhooksCmd
    .command("create <type> <url>")
    .description("Create a persistent webhook hook")
    .option("--blocking", "Block the operation until the webhook responds")
    .option("--priority <n>", "Hook priority (default 50)", "50")
    .option("--agent <id>", "Scope to specific agent")
    .option("--project <id>", "Scope to specific project")
    .option("--description <text>", "Human-readable description")
    .action(async (type: string, url: string, opts) => {
      const { createWebhookHook } = await import("../../db/webhook_hooks.js");
      const { reloadWebhooks } = await import("../../lib/built-in-hooks.js");
      const wh = createWebhookHook({
        type: type as HookType,
        handlerUrl: url,
        blocking: opts.blocking ?? false,
        priority: parseInt(opts.priority, 10),
        agentId: opts.agent,
        projectId: opts.project,
        description: opts.description,
      });
      reloadWebhooks();
      console.log(chalk.green("✓ Webhook created"));
      console.log(`  ID:   ${chalk.cyan(wh.id)}`);
      console.log(`  Type: ${wh.type}`);
      console.log(`  URL:  ${wh.handlerUrl}`);
    });

  webhooksCmd
    .command("delete <id>")
    .description("Delete a webhook by ID")
    .action(async (id: string) => {
      const { deleteWebhookHook } = await import("../../db/webhook_hooks.js");
      const deleted = deleteWebhookHook(id);
      if (deleted) {
        console.log(chalk.green(`✓ Webhook ${id} deleted`));
      } else {
        console.error(chalk.red(`Webhook not found: ${id}`));
        process.exit(1);
      }
    });

  webhooksCmd
    .command("enable <id>")
    .description("Enable a webhook")
    .action(async (id: string) => {
      const { updateWebhookHook } = await import("../../db/webhook_hooks.js");
      const { reloadWebhooks } = await import("../../lib/built-in-hooks.js");
      const updated = updateWebhookHook(id, { enabled: true });
      if (updated) {
        reloadWebhooks();
        console.log(chalk.green(`✓ Webhook ${id} enabled`));
      } else {
        console.error(chalk.red(`Webhook not found: ${id}`));
        process.exit(1);
      }
    });

  webhooksCmd
    .command("disable <id>")
    .description("Disable a webhook (without deleting it)")
    .action(async (id: string) => {
      const { updateWebhookHook } = await import("../../db/webhook_hooks.js");
      const { reloadWebhooks } = await import("../../lib/built-in-hooks.js");
      const updated = updateWebhookHook(id, { enabled: false });
      if (updated) {
        reloadWebhooks();
        console.log(chalk.yellow(`⊘ Webhook ${id} disabled`));
      } else {
        console.error(chalk.red(`Webhook not found: ${id}`));
        process.exit(1);
      }
    });
}
