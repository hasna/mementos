import type { Command } from "commander";
import chalk from "chalk";

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description("Install mementos MCP server into Claude Code, Codex, or Gemini")
    .option("--claude", "Install into Claude Code (~/.claude/.mcp.json)")
    .option("--codex", "Install into Codex (~/.codex/config.toml)")
    .option("--gemini", "Install into Gemini (~/.gemini/settings.json)")
    .option("--all", "Install into all supported agents")
    .option("--uninstall", "Remove mementos MCP from config")
    .action((opts: { claude?: boolean; codex?: boolean; gemini?: boolean; all?: boolean; uninstall?: boolean }) => {
      const { readFileSync: _rfs, writeFileSync: _wfs, existsSync: fileExists } = require("node:fs") as typeof import("node:fs");
      const { join: pathJoin } = require("node:path") as typeof import("node:path");
      const { homedir: getHome } = require("node:os") as typeof import("node:os");
      const home = getHome();

      const mementosCmd = process.argv[0]?.includes("bun")
        ? pathJoin(home, ".bun", "bin", "mementos-mcp")
        : "mementos-mcp";

      const targets = opts.all
        ? ["claude", "codex", "gemini"]
        : [
            opts.claude ? "claude" : null,
            opts.codex ? "codex" : null,
            opts.gemini ? "gemini" : null,
          ].filter(Boolean) as string[];

      if (targets.length === 0) {
        console.log(chalk.yellow("Specify a target: --claude, --codex, --gemini, or --all"));
        console.log(chalk.gray("Example: mementos mcp --all"));
        return;
      }

      for (const target of targets) {
        try {
          if (target === "claude") {
            const { execSync } = require("node:child_process") as typeof import("node:child_process");
            if (opts.uninstall) {
              try {
                execSync(`claude mcp remove mementos`, { stdio: "pipe" });
                console.log(chalk.green("Removed mementos from Claude Code MCP"));
              } catch {
                console.log(chalk.yellow("mementos was not installed in Claude Code (or claude CLI not found)"));
              }
            } else {
              try {
                execSync(`claude mcp add --transport stdio --scope user mementos -- ${mementosCmd}`, { stdio: "pipe" });
                console.log(chalk.green("Installed mementos into Claude Code (user scope)"));
                console.log(chalk.gray("  Restart Claude Code for the change to take effect."));
              } catch {
                console.log(chalk.yellow("claude CLI not found. Run this manually:"));
                console.log(chalk.white(`  claude mcp add --transport stdio --scope user mementos -- ${mementosCmd}`));
              }
            }
          }

          if (target === "codex") {
            const configPath = pathJoin(home, ".codex", "config.toml");
            if (fileExists(configPath)) {
              let content = _rfs(configPath, "utf-8");
              if (opts.uninstall) {
                content = content.replace(/\n\[mcp_servers\.mementos\]\ncommand = "[^"]*"\nargs = \[\]\n?/g, "\n");
              } else if (!content.includes("[mcp_servers.mementos]")) {
                content += `\n[mcp_servers.mementos]\ncommand = "${mementosCmd}"\nargs = []\n`;
              }
              _wfs(configPath, content, "utf-8");
              console.log(chalk.green(`${opts.uninstall ? "Removed from" : "Installed into"} Codex: ${configPath}`));
            } else {
              console.log(chalk.yellow(`Codex config not found: ${configPath}`));
            }
          }

          if (target === "gemini") {
            const configPath = pathJoin(home, ".gemini", "settings.json");
            let config: Record<string, unknown> = {};
            if (fileExists(configPath)) {
              config = JSON.parse(_rfs(configPath, "utf-8")) as Record<string, unknown>;
            }
            const servers = (config["mcpServers"] || {}) as Record<string, unknown>;
            if (opts.uninstall) {
              delete servers["mementos"];
            } else {
              servers["mementos"] = { command: mementosCmd, args: [] };
            }
            config["mcpServers"] = servers;
            _wfs(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
            console.log(chalk.green(`${opts.uninstall ? "Removed from" : "Installed into"} Gemini: ${configPath}`));
          }
        } catch (e) {
          console.error(chalk.red(`Failed for ${target}: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
    });
}
