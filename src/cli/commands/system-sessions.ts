import type { Command } from "commander";
import chalk from "chalk";
import { outputJson, outputYaml, getOutputFormat, makeHandleError } from "../helpers.js";
import type { GlobalOpts } from "../helpers.js";

export function registerSessionsCommand(program: Command): void {
  const handleError = makeHandleError(program);

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
}
