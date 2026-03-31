import type { Command } from "commander";
import chalk from "chalk";
import { registerAgent, listAgents, updateAgent, getAgent, touchAgent } from "../../db/agents.js";
import { setFocus, getFocus } from "../../lib/focus.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerAgentCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // register-agent <name>
  // ============================================================================

  program
    .command("register-agent <name>")
    .alias("init-agent")
    .description("Register an agent (returns ID)")
    .option("-d, --description <text>", "Agent description")
    .option("-r, --role <role>", "Agent role")
    .option("-p, --project <id>", "Lock agent to a project (sets active_project_id)")
    .action((name: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agent = registerAgent(
          name,
          undefined,
          opts.description as string | undefined,
          opts.role as string | undefined,
          opts.project as string | undefined
        );

        if (globalOpts.json) {
          outputJson(agent);
        } else {
          console.log(chalk.green("Agent registered:"));
          console.log(`  ${chalk.bold("ID:")}        ${agent.id}`);
          console.log(`  ${chalk.bold("Name:")}      ${agent.name}`);
          console.log(
            `  ${chalk.bold("Role:")}      ${agent.role || "agent"}`
          );
          console.log(
            `  ${chalk.bold("Created:")}   ${agent.created_at}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // agents
  // ============================================================================

  program
    .command("agents")
    .description("List all registered agents")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const agents = listAgents();

        if (globalOpts.json) {
          outputJson(agents);
          return;
        }

        if (agents.length === 0) {
          console.log(chalk.yellow("No agents registered."));
          return;
        }

        console.log(
          chalk.bold(
            `${agents.length} agent${agents.length === 1 ? "" : "s"}:`
          )
        );
        for (const a of agents) {
          console.log(
            `  ${chalk.dim(a.id)} ${chalk.bold(a.name)} ${chalk.gray(a.role || "agent")} ${chalk.dim(`last seen: ${a.last_seen_at}`)}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // agent-update <id>
  // ============================================================================

  program
    .command("agent-update <id>")
    .description("Update an agent's name, description, or role")
    .option("--name <name>", "New agent name")
    .option("-d, --description <text>", "New description")
    .option("-r, --role <role>", "New role")
    .action((id: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const updates: { name?: string; description?: string; role?: string } = {};
        if (opts.name !== undefined) updates.name = opts.name as string;
        if (opts.description !== undefined) updates.description = opts.description as string;
        if (opts.role !== undefined) updates.role = opts.role as string;

        if (Object.keys(updates).length === 0) {
          if (globalOpts.json) {
            outputJson({ error: "No updates provided. Use --name, --description, or --role." });
          } else {
            console.error(chalk.red("No updates provided. Use --name, --description, or --role."));
          }
          process.exit(1);
        }

        const agent = updateAgent(id, updates);
        if (!agent) {
          if (globalOpts.json) {
            outputJson({ error: `Agent not found: ${id}` });
          } else {
            console.error(chalk.red(`Agent not found: ${id}`));
          }
          process.exit(1);
        }

        if (globalOpts.json) {
          outputJson(agent);
        } else {
          console.log(chalk.green("Agent updated:"));
          console.log(`  ${chalk.bold("ID:")}          ${agent.id}`);
          console.log(`  ${chalk.bold("Name:")}        ${agent.name}`);
          console.log(`  ${chalk.bold("Description:")} ${agent.description || "-"}`);
          console.log(`  ${chalk.bold("Role:")}        ${agent.role || "agent"}`);
          console.log(`  ${chalk.bold("Last seen:")}   ${agent.last_seen_at}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // heartbeat
  program
    .command("heartbeat [agent-id]")
    .description("Update last_seen_at to signal this agent is active")
    .action((agentId?: string) => {
      const globalOpts = program.opts() as { agent?: string; json?: boolean };
      const id = agentId || globalOpts.agent;
      if (!id) { process.stderr.write("Agent ID required. Use --agent or pass as argument.\n"); process.exit(1); }
      const agent = getAgent(id);
      if (!agent) { process.stderr.write(`Agent not found: ${id}\n`); process.exit(1); }
      touchAgent(agent.id);
      if (globalOpts.json) console.log(JSON.stringify({ agent_id: agent.id, name: agent.name, last_seen_at: new Date().toISOString() }));
      else console.log(chalk.green(`♥ ${agent.name} (${agent.id}) — heartbeat sent`));
    });

  // set-focus
  program
    .command("set-focus [project]")
    .description("Focus this agent on a project (or clear focus if no project given)")
    .option("--agent <id>", "Agent ID")
    .action((project?: string, opts?: { agent?: string }) => {
      const globalOpts = program.opts() as { agent?: string };
      const agentId = opts?.agent || globalOpts.agent;
      if (!agentId) { process.stderr.write("Agent ID required. Use --agent.\n"); process.exit(1); }
      setFocus(agentId, project ?? null);
      if (project) console.log(chalk.green(`Focused: ${agentId} → project ${project}`));
      else console.log(chalk.dim(`Focus cleared for ${agentId}`));
    });

  // get-focus
  program
    .command("get-focus")
    .description("Show the current project focus for an agent")
    .option("--agent <id>", "Agent ID")
    .action((opts?: { agent?: string }) => {
      const globalOpts = program.opts() as { agent?: string };
      const agentId = opts?.agent || globalOpts.agent;
      if (!agentId) { process.stderr.write("Agent ID required. Use --agent.\n"); process.exit(1); }
      const focus = getFocus(agentId);
      if (focus) console.log(chalk.cyan(`Focus: ${focus}`));
      else console.log(chalk.dim("No focus set."));
    });
}
