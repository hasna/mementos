import type { Command } from "commander";
import chalk from "chalk";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  accessSync,
  statSync,
  constants as fsConstants,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { getDatabase, getDbPath } from "../../db/database.js";
import { listMemories } from "../../db/memories.js";
import { listAgents } from "../../db/agents.js";
import { listProjects } from "../../db/projects.js";
import { loadConfig, getActiveProfile, setActiveProfile, listProfiles, deleteProfile, DEFAULT_CONFIG } from "../../lib/config.js";
import type {
  MemoryScope,
  MemoryFilter,
} from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  getPackageVersion,
  makeHandleError,
  colorScope,
  colorCategory,
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

export function registerSystemCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // doctor
  // ============================================================================

  program
    .command("doctor")
    .description("Diagnose common issues with the mementos installation")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[] = [];

      // 1. Version
      const version = getPackageVersion();
      checks.push({ name: "Version", status: "ok", detail: version });

      // 2. DB connectivity
      const dbPath = getDbPath();
      let db: ReturnType<typeof getDatabase> | null = null;
      if (dbPath !== ":memory:" && existsSync(dbPath)) {
        try {
          accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
          checks.push({ name: "Database file", status: "ok", detail: dbPath });
        } catch {
          checks.push({ name: "Database file", status: "fail", detail: `Not readable/writable: ${dbPath}` });
        }
      } else if (dbPath === ":memory:") {
        checks.push({ name: "Database file", status: "ok", detail: "in-memory database" });
      } else {
        checks.push({ name: "Database file", status: "warn", detail: `Not found: ${dbPath} (will be created on first use)` });
      }

      try {
        db = getDatabase();
        checks.push({ name: "Database connection", status: "ok", detail: "Connected" });
      } catch (e) {
        checks.push({ name: "Database connection", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 3. DB file size
      try {
        if (dbPath !== ":memory:" && existsSync(dbPath)) {
          const stats = statSync(dbPath);
          const sizeKb = (stats.size / 1024).toFixed(1);
          const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
          const label = stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
          checks.push({ name: "DB file size", status: "ok", detail: label });
        } else if (dbPath === ":memory:") {
          checks.push({ name: "DB file size", status: "ok", detail: "in-memory database" });
        }
      } catch {
        checks.push({ name: "DB file size", status: "warn", detail: "Could not read file size" });
      }

      // 4. Config file
      try {
        loadConfig();
        checks.push({ name: "Config", status: "ok", detail: "valid" });
      } catch (e) {
        checks.push({ name: "Config", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      if (!db) {
        checks.push({ name: "Data checks", status: "fail", detail: "Skipped — database not available" });
        outputDoctorResults(globalOpts, checks);
        process.exitCode = 1;
        return;
      }

      // 5. Schema version
      try {
        const migRow = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
        const schemaVersion = migRow?.max_id ?? 0;
        checks.push({ name: "Schema version", status: schemaVersion > 0 ? "ok" : "warn", detail: `v${schemaVersion}` });
      } catch (e) {
        checks.push({ name: "Schema version", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 6. Memory counts with scope breakdown, expired, and stale
      try {
        const all = listMemories(undefined, db);
        const total = all.length;
        checks.push({ name: "Memories", status: "ok", detail: `${total} total` });

        const byScope: Record<string, number> = {};
        let expiredCount = 0;
        let staleCount = 0;
        const now = Date.now();
        const staleThreshold = 14 * 24 * 60 * 60 * 1000; // 14 days

        for (const m of all) {
          byScope[m.scope] = (byScope[m.scope] || 0) + 1;
          if (m.status === "expired") expiredCount++;
          const lastAccess = m.accessed_at
            ? new Date(m.accessed_at).getTime()
            : new Date(m.created_at).getTime();
          if (now - lastAccess > staleThreshold && m.status === "active") {
            staleCount++;
          }
        }

        const scopeParts = Object.entries(byScope)
          .map(([s, c]) => `${s}: ${c}`)
          .join(", ");
        if (scopeParts) {
          checks.push({ name: "  By scope", status: "ok", detail: scopeParts });
        }

        checks.push({
          name: "  Expired",
          status: expiredCount > 10 ? "warn" : "ok",
          detail: expiredCount > 10 ? `${expiredCount} (run 'mementos clean' to remove)` : String(expiredCount),
        });

        checks.push({
          name: "  Stale (14+ days)",
          status: staleCount > 10 ? "warn" : "ok",
          detail: String(staleCount),
        });
      } catch (e) {
        checks.push({ name: "Memories", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 7. Orphaned tags
      try {
        const orphanedTags = (db.query(
          "SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)"
        ).get() as { c: number }).c;
        checks.push({
          name: "Orphaned tags",
          status: orphanedTags > 0 ? "warn" : "ok",
          detail: orphanedTags > 0 ? `${orphanedTags} orphaned tag(s)` : "None",
        });
      } catch (e) {
        checks.push({ name: "Orphaned tags", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 8. Agent count
      try {
        const agents = listAgents(db);
        checks.push({ name: "Agents", status: "ok", detail: String(agents.length) });
      } catch (e) {
        checks.push({ name: "Agents", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 9. Project count
      try {
        const projects = listProjects(db);
        checks.push({ name: "Projects", status: "ok", detail: String(projects.length) });
      } catch (e) {
        checks.push({ name: "Projects", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 10. Active profile
      try {
        const activeProfile = getActiveProfile();
        const profiles = listProfiles();
        if (activeProfile) {
          checks.push({ name: "Active profile", status: "ok", detail: `${activeProfile} (${profiles.length} total)` });
        } else {
          checks.push({ name: "Active profile", status: "ok", detail: `default (~/.hasna/mementos/mementos.db) — ${profiles.length} profile(s) available` });
        }
      } catch (e) {
        checks.push({ name: "Active profile", status: "warn", detail: e instanceof Error ? e.message : String(e) });
      }

      // 11. REST server reachability (live check)
      try {
        const mementosUrl = process.env["MEMENTOS_URL"] || `http://127.0.0.1:19428`;
        let serverStatus: "ok" | "warn" = "warn";
        let serverDetail = `${mementosUrl} — not reachable (run 'mementos-serve' to start)`;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1000);
          const res = await fetch(`${mementosUrl}/api/health`, { signal: controller.signal });
          clearTimeout(timeout);
          if (res.ok) {
            const data = await res.json() as { version?: string; status?: string };
            serverStatus = "ok";
            serverDetail = `${mementosUrl} — running v${data.version || "?"} (${data.status || "ok"})`;
          }
        } catch { /* not running */ }
        checks.push({ name: "REST server", status: serverStatus, detail: serverDetail });
      } catch {
        checks.push({ name: "REST server", status: "warn", detail: "Could not check REST server" });
      }

      // 12. MCP registered with Claude Code
      try {
        const mcpProc = Bun.spawn(["claude", "mcp", "list"], { stdout: "pipe", stderr: "pipe" });
        const [mcpOut, , mcpExit] = await Promise.all([
          new Response(mcpProc.stdout).text(),
          new Response(mcpProc.stderr).text(),
          mcpProc.exited,
        ]);
        if (mcpExit === 0 && mcpOut.includes("mementos")) {
          checks.push({ name: "MCP server", status: "ok", detail: "registered with Claude Code" });
        } else if (mcpExit !== 0) {
          checks.push({ name: "MCP server", status: "warn", detail: "claude not installed or not accessible" });
        } else {
          checks.push({ name: "MCP server", status: "warn", detail: "not registered  →  run: mementos init" });
        }
      } catch {
        checks.push({ name: "MCP server", status: "warn", detail: "could not check (is claude CLI installed?)" });
      }

      // 13. Stop hook installed
      try {
        const settingsFilePath = join(homedir(), ".claude", "settings.json");
        if (existsSync(settingsFilePath)) {
          const settings = JSON.parse(readFileSync(settingsFilePath, "utf-8")) as Record<string, unknown>;
          const hooksObj = (settings["hooks"] || {}) as Record<string, unknown>;
          const stopHooks = (hooksObj["Stop"] || []) as Array<{ hooks?: Array<{ command?: string }> }>;
          const hasMementos = stopHooks.some((e) =>
            e.hooks?.some((h) => h.command && h.command.includes("mementos"))
          );
          checks.push({
            name: "Stop hook",
            status: hasMementos ? "ok" : "warn",
            detail: hasMementos ? "installed (sessions → memories)" : "not installed  →  run: mementos init",
          });
        } else {
          checks.push({ name: "Stop hook", status: "warn", detail: "~/.claude/settings.json not found  →  run: mementos init" });
        }
      } catch {
        checks.push({ name: "Stop hook", status: "warn", detail: "could not check stop hook" });
      }

      // 14. Auto-start configured (macOS launchd)
      if (process.platform === "darwin") {
        const plistFilePath = join(homedir(), "Library", "LaunchAgents", "com.hasna.mementos.plist");
        checks.push({
          name: "Auto-start",
          status: existsSync(plistFilePath) ? "ok" : "warn",
          detail: existsSync(plistFilePath)
            ? "configured (starts on login)"
            : "not configured  →  run: mementos init",
        });
      } else {
        checks.push({ name: "Auto-start", status: "ok", detail: `n/a on ${process.platform}` });
      }

      outputDoctorResults(globalOpts, checks);
    });

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
        handleError(e);
      }
    });

  // ============================================================================
  // profile commands
  // ============================================================================

  const profileCmd = program.command("profile").description("Manage memory profiles (isolated DBs per context)");

  profileCmd
    .command("list")
    .description("List all available profiles")
    .action(() => {
      const profiles = listProfiles();
      const active = getActiveProfile();
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
        console.log(chalk.dim("\n  (no active profile — using default DB)"));
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
        console.log(chalk.dim("No active profile — using default DB (~/.hasna/mementos/mementos.db)"));
      }
    });

  profileCmd
    .command("set <name>")
    .description("Switch to a named profile (creates the DB on first use)")
    .action((name: string) => {
      const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      if (!clean) {
        console.error(chalk.red("Invalid profile name. Use letters, numbers, hyphens, underscores."));
        process.exit(1);
      }
      setActiveProfile(clean);
      console.log(chalk.green(`✓ Switched to profile: ${clean}`));
      console.log(chalk.dim(`  DB: ~/.hasna/mementos/profiles/${clean}.db (created on first use)`));
    });

  profileCmd
    .command("unset")
    .description("Clear the active profile (revert to default DB)")
    .action(() => {
      const was = getActiveProfile();
      setActiveProfile(null);
      if (was) {
        console.log(chalk.green(`✓ Cleared profile (was: ${was})`));
      } else {
        console.log(chalk.dim("No active profile was set."));
      }
      console.log(chalk.dim("  Now using default DB: ~/.hasna/mementos/mementos.db"));
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
    .action(async (opts) => {
      const { hookRegistry } = await import("../../lib/hooks.js");
      const hooks = hookRegistry.list(opts.type);
      if (hooks.length === 0) {
        console.log(chalk.gray("No hooks registered."));
        return;
      }
      for (const h of hooks) {
        const builtinTag = h.builtin ? chalk.blue(" [builtin]") : "";
        const blockingTag = h.blocking ? chalk.red(" [blocking]") : chalk.gray(" [non-blocking]");
        console.log(`${chalk.cyan(h.id)} ${chalk.bold(h.type)}${builtinTag}${blockingTag} priority=${h.priority}`);
        if (h.description) console.log(`  ${chalk.gray(h.description)}`);
      }
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

  const webhooksCmd = hooksCmd
    .command("webhooks")
    .alias("wh")
    .description("Manage persistent HTTP webhook hooks");

  webhooksCmd
    .command("list")
    .description("List all persisted webhook hooks")
    .option("--type <type>", "Filter by hook type")
    .option("--disabled", "Show only disabled webhooks")
    .action(async (opts) => {
      const { listWebhookHooks } = await import("../../db/webhook_hooks.js");
      const webhooks = listWebhookHooks({
        type: opts.type,
        enabled: opts.disabled ? false : undefined,
      });
      if (webhooks.length === 0) {
        console.log(chalk.gray("No webhooks registered."));
        return;
      }
      for (const wh of webhooks) {
        const enabledTag = wh.enabled ? chalk.green("enabled") : chalk.red("disabled");
        const blockingTag = wh.blocking ? chalk.red("blocking") : chalk.gray("non-blocking");
        console.log(`${chalk.cyan(wh.id)} [${enabledTag}] ${chalk.bold(wh.type)} → ${wh.handlerUrl}`);
        console.log(`  ${blockingTag} | priority=${wh.priority} | invocations=${wh.invocationCount} failures=${wh.failureCount}`);
        if (wh.description) console.log(`  ${chalk.gray(wh.description)}`);
      }
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
        type,
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

  // ============================================================================
  // session ingestion commands
  // ============================================================================

  const sessionCmd = program
    .command("session")
    .description("Session auto-memory — ingest session transcripts for memory extraction");

  sessionCmd
    .command("ingest <transcriptFile>")
    .description("Ingest a session transcript file for memory extraction")
    .option("--session-id <id>", "Session ID (default: auto-generated)")
    .option("--agent <id>", "Agent ID")
    .option("--project <id>", "Project ID")
    .option("--source <source>", "Source (claude-code, codex, manual, open-sessions)", "manual")
    .action(async (transcriptFile: string, opts: { sessionId?: string; agent?: string; project?: string; source: string }) => {
      const { readFileSync: _rfs } = await import("node:fs");
      const { createSessionJob } = await import("../../db/session-jobs.js");
      const { enqueueSessionJob } = await import("../../lib/session-queue.js");
      const transcript = _rfs(transcriptFile, "utf-8");
      const sessionId = opts.sessionId ?? `cli-${Date.now()}`;
      const job = createSessionJob({
        session_id: sessionId,
        transcript,
        source: opts.source as "claude-code" | "codex" | "manual" | "open-sessions",
        agent_id: opts.agent,
        project_id: opts.project,
      });
      enqueueSessionJob(job.id);
      console.log(chalk.green(`✓ Session queued: ${chalk.cyan(job.id)}`));
      console.log(`  Session: ${sessionId}`);
      console.log(`  Length:  ${transcript.length} chars`);
    });

  sessionCmd
    .command("status <jobId>")
    .description("Check status of a session extraction job")
    .action(async (jobId: string) => {
      const { getSessionJob } = await import("../../db/session-jobs.js");
      const job = getSessionJob(jobId);
      if (!job) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }
      const statusColor = job.status === "completed" ? chalk.green : job.status === "failed" ? chalk.red : chalk.yellow;
      console.log(`${chalk.cyan(job.id)} [${statusColor(job.status)}]`);
      console.log(`  Session:   ${job.session_id}`);
      console.log(`  Chunks:    ${job.chunk_count}`);
      console.log(`  Extracted: ${job.memories_extracted} memories`);
      if (job.error) console.log(chalk.red(`  Error: ${job.error}`));
    });

  sessionCmd
    .command("list")
    .description("List session extraction jobs")
    .option("--agent <id>", "Filter by agent")
    .option("--project <id>", "Filter by project")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Max results", "20")
    .action(async (opts: { agent?: string; project?: string; status?: string; limit: string }) => {
      const { listSessionJobs } = await import("../../db/session-jobs.js");
      const jobs = listSessionJobs({
        agent_id: opts.agent,
        project_id: opts.project,
        status: opts.status as "pending" | "processing" | "completed" | "failed" | undefined,
        limit: parseInt(opts.limit),
      });
      if (jobs.length === 0) {
        console.log(chalk.gray("No session jobs found."));
        return;
      }
      for (const job of jobs) {
        const statusColor = job.status === "completed" ? chalk.green : job.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`${chalk.cyan(job.id.slice(0, 8))} [${statusColor(job.status)}] ${job.memories_extracted} memories | ${job.created_at.slice(0, 10)}`);
      }
    });

  sessionCmd
    .command("setup-hook")
    .description("Install mementos session hook into Claude Code or Codex")
    .option("--claude", "Install Claude Code stop hook")
    .option("--codex", "Install Codex session hook")
    .option("--show", "Print hook script instead of installing")
    .action(async (opts: { claude?: boolean; codex?: boolean; show?: boolean }) => {
      const { resolve: _resolve } = await import("node:path");
      const hookPath = _resolve(import.meta.dirname, "../../scripts/hooks");

      if (opts.claude) {
        const script = `${hookPath}/claude-stop-hook.ts`;
        if (opts.show) {
          const { readFileSync: _rfs } = await import("node:fs");
          console.log(_rfs(script, "utf-8"));
          return;
        }
        console.log(chalk.bold("Claude Code stop hook installation:"));
        console.log("");
        console.log("Add to your .claude/settings.json:");
        console.log(chalk.cyan(JSON.stringify({
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: `bun ${script}` }] }],
          },
        }, null, 2)));
        console.log("");
        console.log(`Or run: ${chalk.cyan(`claude hooks add Stop "bun ${script}"`)}`);
      } else if (opts.codex) {
        const script = `${hookPath}/codex-stop-hook.ts`;
        console.log(chalk.bold("Codex session hook installation:"));
        console.log("");
        console.log("Add to ~/.codex/config.toml:");
        console.log(chalk.cyan(`[hooks]\nsession_end = "bun ${script}"`));
      } else {
        console.log("Usage: mementos session setup-hook --claude | --codex");
      }
    });

  // ============================================================================
  // tool-events [tool_name]
  // ============================================================================

  program
    .command("tool-events [tool_name]")
    .description("List tool events, optionally filtered by tool name")
    .option("--limit <n>", "Max results (default: 20)", parseInt)
    .option("--project-id <id>", "Filter by project ID")
    .action((toolName: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { getToolEvents } = require("../../db/tool-events.js") as typeof import("../../db/tool-events.js");
        const limit = (opts.limit as number | undefined) || 20;
        const events = getToolEvents({
          tool_name: toolName,
          project_id: opts.projectId as string | undefined,
          limit,
        });

        if (globalOpts.json) {
          outputJson(events);
          return;
        }

        if (events.length === 0) {
          console.log(chalk.yellow("No tool events found."));
          return;
        }

        console.log(chalk.bold(`${events.length} tool event${events.length === 1 ? "" : "s"}:`));
        // Table header
        console.log(
          `  ${chalk.dim("tool_name".padEnd(24))} ${chalk.dim("action".padEnd(16))} ${chalk.dim("success")} ${chalk.dim("error_type".padEnd(20))} ${chalk.dim("created_at")}`
        );
        for (const e of events) {
          const successStr = e.success ? chalk.green("true   ") : chalk.red("false  ");
          const errorType = (e.error_type || "").padEnd(20);
          const action = (e.action || "-").padEnd(16);
          console.log(
            `  ${e.tool_name.padEnd(24)} ${action} ${successStr} ${errorType} ${chalk.dim(e.created_at)}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // tool-insights <tool_name>
  // ============================================================================

  program
    .command("tool-insights <tool_name>")
    .description("Show tool guide/stats and lessons for a tool")
    .option("--project-id <id>", "Filter by project ID")
    .action((toolName: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const { getToolStats, getToolLessons } = require("../../db/tool-events.js") as typeof import("../../db/tool-events.js");
        const projectId = opts.projectId as string | undefined;
        const stats = getToolStats(toolName, projectId);
        const lessons = getToolLessons(toolName, projectId);

        if (globalOpts.json) {
          outputJson({ stats, lessons });
          return;
        }

        // Stats line
        const successRate = (stats.success_rate * 100).toFixed(1);
        console.log(chalk.bold(`Tool: ${toolName}`));
        console.log(
          `  Calls: ${stats.total_calls}  Success: ${chalk.green(String(stats.success_count))}  Failures: ${chalk.red(String(stats.failure_count))}  Rate: ${successRate}%` +
          (stats.avg_latency_ms !== null ? `  Avg latency: ${stats.avg_latency_ms.toFixed(0)}ms` : "") +
          (stats.last_used ? `  Last used: ${chalk.dim(stats.last_used)}` : "")
        );

        if (stats.common_errors.length > 0) {
          console.log(chalk.bold("\n  Common errors:"));
          for (const err of stats.common_errors) {
            console.log(`    ${chalk.red(err.error_type)}: ${err.count} times`);
          }
        }

        if (lessons.length === 0) {
          console.log(chalk.dim("\n  No lessons recorded."));
          return;
        }

        console.log(chalk.bold(`\n  Lessons (${lessons.length}):`));
        for (const l of lessons) {
          console.log(`    ${chalk.cyan("-")} ${l.lesson} ${chalk.dim(`(${l.created_at.slice(0, 10)})`)}`);
          if (l.when_to_use) {
            console.log(`      ${chalk.dim("when_to_use:")} ${l.when_to_use}`);
          }
        }
      } catch (e) {
        handleError(e);
      }
    });

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
        const pkg = JSON.parse(_rfs(_join(_dir(_ftu(import.meta.url)), "../../../package.json"), "utf-8"));
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

function outputDoctorResults(
  globalOpts: GlobalOpts,
  checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[],
): void {
  if (globalOpts.json) {
    outputJson({ checks, healthy: checks.every((c) => c.status === "ok") });
  } else {
    console.log(chalk.bold("\nmementos doctor\n"));
    for (const check of checks) {
      const icon =
        check.status === "ok"
          ? chalk.green("\u2713")
          : check.status === "warn"
            ? chalk.yellow("\u26A0")
            : chalk.red("\u2717");
      console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.detail}`);
    }
    const healthy = checks.every((c) => c.status === "ok");
    const warnings = checks.filter((c) => c.status === "warn").length;
    const failures = checks.filter((c) => c.status === "fail").length;
    console.log("");
    if (healthy) {
      console.log(chalk.green("  All checks passed."));
    } else {
      if (failures > 0) console.log(chalk.red(`  ${failures} check(s) failed.`));
      if (warnings > 0) console.log(chalk.yellow(`  ${warnings} warning(s).`));
    }
    console.log("");
  }
}
