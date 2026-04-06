import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getDatabase } from "../../db/database.js";
import { listMemories } from "../../db/memories.js";
import type {
  MemoryScope,
  MemoryFilter,
} from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  makeHandleError,
  colorScope,
  colorCategory,
  type GlobalOpts,
} from "../helpers.js";
import { registerDoctorCommand } from "./system-doctor.js";
import { registerConfigCommand } from "./system-config.js";
import { registerProfileCommand } from "./system-profile.js";
import { registerAutoMemoryCommand } from "./system-auto-memory.js";
import { registerHooksCommand } from "./system-hooks.js";
import { registerSynthesisCommand } from "./system-synthesis.js";
import { registerSessionCommand } from "./system-session.js";
import { registerToolsCommand } from "./system-tools.js";
import { registerSynthesizedProfileCommand } from "./system-synthesized-profile.js";

export function registerSystemCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // Register extracted command groups
  registerDoctorCommand(program);
  registerConfigCommand(program);
  registerProfileCommand(program);
  registerAutoMemoryCommand(program);
  registerHooksCommand(program);
  registerSynthesisCommand(program);
  registerSessionCommand(program);
  registerToolsCommand(program);
  registerSynthesizedProfileCommand(program);

  // ============================================================================
  // mcp
  // ============================================================================

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
            // CORRECT: use `claude mcp add` CLI — do NOT write ~/.claude/.mcp.json directly
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
                console.log(chalk.green(`Installed mementos into Claude Code (user scope)`));
                console.log(chalk.gray("  Restart Claude Code for the change to take effect."));
              } catch (e) {
                // claude CLI not available — print the command for manual install
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

  // ============================================================================
  // watch
  // ============================================================================

  program
    .command("watch")
    .description("Watch for new and changed memories in real-time")
    .option("-s, --scope <scope>", "Scope filter: global, shared, private")
    .option("-c, --category <cat>", "Category filter: preference, fact, knowledge, history")
    .option("--agent <name>", "Agent filter")
    .option("--project <path>", "Project filter")
    .option("--interval <ms>", "Poll interval in milliseconds", parseInt)
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath =
          (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const { getProject } = require("../../db/projects.js") as typeof import("../../db/projects.js");
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const intervalMs = (opts.interval as number | undefined) || 500;

        // Header
        console.log(
          chalk.bold.cyan("Watching memories...") +
            chalk.dim(" (Ctrl+C to stop)")
        );

        // Show active filters
        const filters: string[] = [];
        if (opts.scope) filters.push(`scope=${colorScope(opts.scope as MemoryScope)}`);
        if (opts.category) filters.push(`category=${colorCategory(opts.category as any)}`);
        if (agentId) filters.push(`agent=${chalk.dim(agentId)}`);
        if (projectId) filters.push(`project=${chalk.dim(projectId)}`);
        if (filters.length > 0) {
          console.log(chalk.dim("Filters: ") + filters.join(chalk.dim(" | ")));
        }
        console.log(chalk.dim(`Poll interval: ${intervalMs}ms`));
        console.log();

        // Show last 20 memories as "Recent"
        const filter: MemoryFilter = {
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as any,
          agent_id: agentId,
          project_id: projectId,
          limit: 20,
        };

        const { formatWatchLine, sendNotification } = require("../helpers.js") as typeof import("../helpers.js");
        const recent = listMemories(filter);
        if (recent.length > 0) {
          console.log(chalk.bold.dim(`Recent (${recent.length}):`));
          // Show oldest first
          for (const m of recent.reverse()) {
            console.log(formatWatchLine(m));
          }
        } else {
          console.log(chalk.dim("No recent memories."));
        }

        console.log(chalk.dim("──────────── Live ────────────"));
        console.log();

        // Start polling for new/changed memories
        const { startPolling } = require("../../lib/poll.js") as typeof import("../../lib/poll.js");

        const handle = startPolling({
          interval_ms: intervalMs,
          scope: opts.scope as MemoryScope | undefined,
          category: opts.category as any,
          agent_id: agentId,
          project_id: projectId,
          on_memories: (memories: any[]) => {
            for (const m of memories) {
              console.log(formatWatchLine(m));
              sendNotification(m);
            }
          },
          on_error: (err: Error) => {
            console.error(chalk.red(`Poll error: ${err.message}`));
          },
        });

        // Graceful Ctrl+C
        const cleanup = () => {
          handle.stop();
          console.log();
          console.log(chalk.dim("Stopped watching."));
          process.exit(0);
        };
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // completions <shell>
  // ============================================================================

  program
    .command("completions <shell>")
    .description("Output shell completion script (bash, zsh, fish)")
    .action((shell: string) => {
      const commands = "init setup save recall list update forget search stats export import clean inject context pin unpin archive versions stale doctor tail diff register-agent agents projects bulk completions config backup restore report profile mcp";
      const commandList = commands.split(" ");

      switch (shell.toLowerCase()) {
        case "bash": {
          console.log(`_mementos_completions() {
  local commands="${commands}"
  local scopes="global shared private"
  local categories="preference fact knowledge history"

  if [ "\${#COMP_WORDS[@]}" -eq 2 ]; then
    COMPREPLY=($(compgen -W "$commands" -- "\${COMP_WORDS[1]}"))
  elif [ "\${COMP_WORDS[1]}" = "recall" ] || [ "\${COMP_WORDS[1]}" = "forget" ] || [ "\${COMP_WORDS[1]}" = "pin" ] || [ "\${COMP_WORDS[1]}" = "unpin" ]; then
    COMPREPLY=()
  fi
}
complete -F _mementos_completions mementos`);
          break;
        }
        case "zsh": {
          console.log(`#compdef mementos
_mementos() {
  local commands=(${commands})
  _arguments '1:command:($commands)'
}
compdef _mementos mementos`);
          break;
        }
        case "fish": {
          const descriptions: Record<string, string> = {
            save: "Save a memory",
            recall: "Recall a memory by key",
            list: "List memories",
            update: "Update a memory",
            forget: "Delete a memory",
            search: "Search memories",
            stats: "Show memory statistics",
            export: "Export memories to JSON",
            import: "Import memories from JSON",
            clean: "Clean expired memories",
            inject: "Inject memories into a prompt",
            context: "Get context-relevant memories",
            pin: "Pin a memory",
            unpin: "Unpin a memory",
            doctor: "Check database health",
            tail: "Watch recent memories",
            diff: "Show memory changes",
            init: "One-command onboarding setup (MCP + hook + auto-start)",
            "register-agent": "Register an agent (returns ID)",
            agents: "Manage agents",
            projects: "Manage projects",
            bulk: "Bulk operations",
            completions: "Output shell completion script",
            config: "Manage configuration",
            backup: "Backup the database",
            restore: "Restore from a backup",
          };
          const lines = commandList.map(
            (cmd) =>
              `complete -c mementos -n "__fish_use_subcommand" -a "${cmd}" -d "${descriptions[cmd] || cmd}"`
          );
          console.log(lines.join("\n"));
          break;
        }
        default:
          console.error(
            `Unknown shell: ${shell}. Supported: bash, zsh, fish`
          );
          process.exit(1);
      }
    });

  // ============================================================================
  // sessions commands
  // ============================================================================

  const sessionsCmd = program
    .command("sessions")
    .description("Session registry — list, clean, and inspect active Claude Code sessions");

  sessionsCmd
    .command("list")
    .description("List all active sessions in the registry")
    .option("--project <name>", "Filter by project name")
    .option("--agent <name>", "Filter by agent name")
    .option("--format <fmt>", "Output format: compact (default), json, yaml")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { listSessions } = require("../../lib/session-registry.js") as typeof import("../../lib/session-registry.js");
        const sessions = listSessions({
          project_name: opts.project as string | undefined,
          agent_name: (opts.agent as string | undefined) || globalOpts.agent,
        });

        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(sessions);
          return;
        }

        if (fmt === "yaml") {
          outputYaml(sessions);
          return;
        }

        if (sessions.length === 0) {
          console.log(chalk.yellow("No active sessions found."));
          return;
        }

        console.log(chalk.bold(`${sessions.length} active session${sessions.length === 1 ? "" : "s"}:\n`));
        for (const s of sessions) {
          const pid = chalk.dim(`pid:${s.pid}`);
          const agent = s.agent_name ? chalk.cyan(s.agent_name) : chalk.dim("(no agent)");
          const project = s.project_name ? chalk.yellow(s.project_name) : chalk.dim("(no project)");
          const mcp = chalk.dim(s.mcp_server);
          const self = s.pid === process.pid ? chalk.green(" (self)") : "";
          console.log(`  ${chalk.bold(s.id)} ${pid}${self} ${agent} ${project} ${mcp}`);
          console.log(`    ${chalk.dim(`cwd: ${s.cwd}`)}  ${chalk.dim(`last seen: ${s.last_seen_at}`)}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  sessionsCmd
    .command("send <message>")
    .description("Send a message to sessions (use MCP tool memory_send_channel for full support)")
    .option("--agent <name>", "Target agent name")
    .option("--project <name>", "Target project name")
    .option("--all", "Broadcast to all sessions")
    .action((message: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { listSessions } = require("../../lib/session-registry.js") as typeof import("../../lib/session-registry.js");

        if (!opts.agent && !opts.project && !opts.all) {
          console.error(chalk.red("Specify a target: --agent <name>, --project <name>, or --all"));
          process.exit(1);
        }

        // Show matching sessions and advise to use MCP tool
        const filter: { agent_name?: string; project_name?: string } = {};
        if (opts.agent) filter.agent_name = opts.agent as string;
        if (opts.project) filter.project_name = opts.project as string;

        const sessions = listSessions(opts.all ? undefined : filter);

        if (globalOpts.json) {
          outputJson({
            message: "Channel push requires MCP server context. Use the memory_send_channel MCP tool.",
            matching_sessions: sessions.length,
            sessions: sessions.map((s: { id: string; pid: number; agent_name: string | null; project_name: string | null }) => ({
              id: s.id, pid: s.pid, agent_name: s.agent_name, project_name: s.project_name,
            })),
          });
          return;
        }

        console.log(chalk.bold(`Found ${sessions.length} matching session${sessions.length === 1 ? "" : "s"}:`));
        for (const s of sessions) {
          const agent = s.agent_name ? chalk.cyan(s.agent_name) : chalk.dim("(no agent)");
          const project = s.project_name ? chalk.yellow(s.project_name) : "";
          console.log(`  ${s.id} pid:${s.pid} ${agent} ${project}`);
        }
        console.log();
        console.log(chalk.dim("Channel push requires the MCP server context."));
        console.log(chalk.dim("Use the MCP tool:"));
        console.log(chalk.cyan(`  memory_send_channel(content="${message.slice(0, 60)}${message.length > 60 ? "..." : ""}")`));
      } catch (e) {
        handleError(e);
      }
    });

  sessionsCmd
    .command("clean")
    .description("Remove dead/stale sessions from the registry")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { cleanStaleSessions } = require("../../lib/session-registry.js") as typeof import("../../lib/session-registry.js");
        const cleaned = cleanStaleSessions();

        if (globalOpts.json) {
          outputJson({ cleaned });
        } else if (cleaned === 0) {
          console.log(chalk.green("No stale sessions found — registry is clean."));
        } else {
          console.log(chalk.green(`Cleaned ${cleaned} stale session${cleaned === 1 ? "" : "s"}.`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // migrate-pg command
  // ============================================================================

  program
    .command("migrate-pg")
    .description("Apply PostgreSQL migrations to the configured RDS instance")
    .option("--connection-string <url>", "PostgreSQL connection string (overrides cloud config)")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const globalOpts = program.opts();
      const useJson = opts.json || globalOpts.json;

      let connStr: string;
      if (opts.connectionString) {
        connStr = opts.connectionString;
      } else {
        try {
          const { getConnectionString } = await import("@hasna/cloud");
          connStr = getConnectionString("mementos");
        } catch {
          const msg = "Cloud RDS not configured. Use --connection-string or run `cloud setup`.";
          if (useJson) {
            console.log(JSON.stringify({ error: msg }));
          } else {
            console.error(chalk.red(msg));
          }
          process.exit(1);
        }
      }

      try {
        const { applyPgMigrations } = await import("../../db/pg-migrate.js");
        const result = await applyPgMigrations(connStr);

        if (useJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        if (result.applied.length > 0) {
          console.log(chalk.green(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`));
        }
        if (result.alreadyApplied.length > 0) {
          console.log(chalk.dim(`Already applied: ${result.alreadyApplied.length} migration(s)`));
        }
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.error(chalk.red(`  Error: ${err}`));
          }
          process.exit(1);
        }
        if (result.applied.length === 0 && result.errors.length === 0) {
          console.log(chalk.dim("Schema is up to date."));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (useJson) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(`Migration failed: ${msg}`));
        }
        process.exit(1);
      }
    });

  // ============================================================================
  // feedback command
  // ============================================================================

  program
    .command("feedback")
    .description("Send feedback about mementos")
    .argument("<message>", "Feedback message")
    .option("--email <email>", "Your email (optional)")
    .option("--category <category>", "Category: bug, feature, general", "general")
    .action(async (message: string, opts) => {
      try {
        const db = getDatabase();
        const { fileURLToPath: _ftu } = await import("node:url");
        const { dirname: _dir, join: _join } = await import("node:path");
        const { readFileSync: _rfs } = await import("node:fs");
        const pkg = JSON.parse(_rfs(_join(_dir(_ftu(import.meta.url)), "../../package.json"), "utf-8"));
        db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
          message, opts.email || null, opts.category || "general", pkg.version,
        ]);
        console.log(chalk.green("Feedback saved. Thank you!"));
      } catch (e) {
        console.error(chalk.red(`Failed to save feedback: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
