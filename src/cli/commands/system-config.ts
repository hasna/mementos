import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, DEFAULT_CONFIG } from "../../lib/config.js";
import {
  outputJson,
  getNestedValue,
  setNestedValue,
  deleteNestedKey,
  parseConfigValue,
  validateConfigKeyValue,
  getConfigPath,
  readFileConfig,
  writeFileConfig,
  type GlobalOpts,
} from "../helpers.js";

export function registerConfigCommand(program: Command): void {
  // ============================================================================
  // config [subcommand]
  // ============================================================================

  program
    .command("config [subcommand] [args...]")
    .description(
      "View or modify configuration. Subcommands: get <key>, set <key> <value>, reset [key], path"
    )
    .action((subcommand: string | undefined, args: string[]) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const useJson = globalOpts.json || globalOpts.format === "json";

        // No subcommand: show full merged config
        if (!subcommand) {
          const config = loadConfig();
          if (useJson) {
            outputJson(config);
          } else {
            console.log(JSON.stringify(config, null, 2));
          }
          return;
        }

        // config path
        if (subcommand === "path") {
          const p = getConfigPath();
          if (useJson) {
            outputJson({ path: p });
          } else {
            console.log(p);
          }
          return;
        }

        // config get <key>
        if (subcommand === "get") {
          const key = args[0];
          if (!key) {
            console.error(chalk.red("Usage: mementos config get <key>"));
            process.exit(1);
          }
          const config = loadConfig();
          const value = getNestedValue(config as unknown as Record<string, unknown>, key);
          if (value === undefined) {
            console.error(chalk.red(`Unknown config key: ${key}`));
            process.exit(1);
          }
          if (useJson) {
            outputJson({ key, value });
          } else if (typeof value === "object" && value !== null) {
            console.log(JSON.stringify(value, null, 2));
          } else {
            console.log(String(value));
          }
          return;
        }

        // config set <key> <value>
        if (subcommand === "set") {
          const key = args[0];
          const rawValue = args[1];
          if (!key || rawValue === undefined) {
            console.error(chalk.red("Usage: mementos config set <key> <value>"));
            process.exit(1);
          }
          const value = parseConfigValue(rawValue);
          const err = validateConfigKeyValue(key, value, DEFAULT_CONFIG);
          if (err) {
            console.error(chalk.red(err));
            process.exit(1);
          }
          const fileConfig = readFileConfig();
          setNestedValue(fileConfig, key, value);
          writeFileConfig(fileConfig);
          if (useJson) {
            outputJson({ key, value, saved: true });
          } else {
            console.log(chalk.green(`Set ${key} = ${JSON.stringify(value)}`));
          }
          return;
        }

        // config reset [key]
        if (subcommand === "reset") {
          const key = args[0];
          if (key) {
            // Validate key exists in defaults
            const defaultVal = getNestedValue(DEFAULT_CONFIG as unknown as Record<string, unknown>, key);
            if (defaultVal === undefined) {
              console.error(chalk.red(`Unknown config key: ${key}`));
              process.exit(1);
            }
            const fileConfig = readFileConfig();
            deleteNestedKey(fileConfig, key);
            writeFileConfig(fileConfig);
            if (useJson) {
              outputJson({ key, reset: true, default_value: defaultVal });
            } else {
              console.log(chalk.green(`Reset ${key} to default (${JSON.stringify(defaultVal)})`));
            }
          } else {
            // Reset all: delete the config file
            const configPath = getConfigPath();
            const { unlinkSync, existsSync: _existsSync } = require("node:fs") as typeof import("node:fs");
            if (_existsSync(configPath)) {
              unlinkSync(configPath);
            }
            if (useJson) {
              outputJson({ reset: true, all: true });
            } else {
              console.log(chalk.green("Config reset to defaults (file removed)"));
            }
          }
          return;
        }

        console.error(chalk.red(`Unknown config subcommand: ${subcommand}`));
        console.error("Usage: mementos config [get|set|reset|path]");
        process.exit(1);
      } catch (e) {
        throw e;
      }
    });
}
