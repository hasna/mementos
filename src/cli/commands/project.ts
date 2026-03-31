import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { registerProject, getProject, listProjects } from "../../db/projects.js";
import { listMemories, touchMemory } from "../../db/memories.js";
import type {
  Memory,
  MemoryCategory,
  MemoryScope,
} from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerProjectCommands(program: Command): void {
  const handleError = makeHandleError(program);

  // ============================================================================
  // projects
  // ============================================================================

  program
    .command("projects")
    .description("Manage projects")
    .option("--add", "Add a new project")
    .option("--name <name>", "Project name")
    .option("--path <path>", "Project path")
    .option("--description <text>", "Project description")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();

        if (opts.add) {
          const name = opts.name as string | undefined;
          const path = opts.path as string | undefined;
          if (!name || !path) {
            console.error(
              chalk.red("--name and --path are required when adding a project")
            );
            process.exit(1);
          }
          const project = registerProject(
            name,
            resolve(path),
            opts.description as string | undefined
          );

          if (globalOpts.json) {
            outputJson(project);
          } else {
            console.log(chalk.green("Project registered:"));
            console.log(`  ${chalk.bold("ID:")}     ${project.id}`);
            console.log(
              `  ${chalk.bold("Name:")}   ${project.name}`
            );
            console.log(
              `  ${chalk.bold("Path:")}   ${project.path}`
            );
          }
          return;
        }

        // List projects
        const projects = listProjects();

        if (globalOpts.json) {
          outputJson(projects);
          return;
        }

        if (projects.length === 0) {
          console.log(chalk.yellow("No projects registered."));
          return;
        }

        console.log(
          chalk.bold(
            `${projects.length} project${projects.length === 1 ? "" : "s"}:`
          )
        );
        for (const p of projects) {
          console.log(
            `  ${chalk.dim(p.id.slice(0, 8))} ${chalk.bold(p.name)} ${chalk.gray(p.path)}${p.description ? chalk.dim(` — ${p.description}`) : ""}`
          );
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // inject
  // ============================================================================

  program
    .command("inject")
    .description(
      "Output injection context for agent system prompts"
    )
    .option("--agent <name>", "Agent ID for scope filtering")
    .option("--project <path>", "Project path for scope filtering")
    .option("--session <id>", "Session ID for scope filtering")
    .option(
      "--max-tokens <n>",
      "Max approximate token budget",
      parseInt
    )
    .option(
      "--categories <cats>",
      "Comma-separated categories to include"
    )
    .option("--format <fmt>", "Output format: xml (default), compact, markdown, json")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const maxTokens =
          (opts.maxTokens as number | undefined) || 500;
        const minImportance = 3;
        const categoriesRaw =
          (opts.categories as string | undefined) ||
          "preference,fact,knowledge";
        const categories = categoriesRaw
          .split(",")
          .map((c: string) => c.trim()) as MemoryCategory[];

        const agentId =
          (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath =
          (opts.project as string | undefined) || globalOpts.project;
        const sessionId =
          (opts.session as string | undefined) || globalOpts.session;

        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        // Collect memories from all visible scopes
        const allMemories: Memory[] = [];

        // Global memories
        const globalMems = listMemories({
          scope: "global",
          category: categories,
          min_importance: minImportance,
          status: "active",
          project_id: projectId,
          limit: 50,
        });
        allMemories.push(...globalMems);

        // Shared memories (project-scoped)
        if (projectId) {
          const sharedMems = listMemories({
            scope: "shared",
            category: categories,
            min_importance: minImportance,
            status: "active",
            project_id: projectId,
            limit: 50,
          });
          allMemories.push(...sharedMems);
        }

        // Private memories (agent-scoped)
        if (agentId) {
          const privateMems = listMemories({
            scope: "private",
            category: categories,
            min_importance: minImportance,
            status: "active",
            agent_id: agentId,
            session_id: sessionId,
            limit: 50,
          });
          allMemories.push(...privateMems);
        }

        // Deduplicate by ID
        const seen = new Set<string>();
        const unique = allMemories.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        // Sort by importance DESC, then recency
        unique.sort((a, b) => {
          if (b.importance !== a.importance)
            return b.importance - a.importance;
          return (
            new Date(b.updated_at).getTime() -
            new Date(a.updated_at).getTime()
          );
        });

        // Build context within token budget (~4 chars per token estimate)
        const charBudget = maxTokens * 4;
        const lines: string[] = [];
        let totalChars = 0;

        const fmt = (opts.format as string | undefined) || "xml";

        for (const m of unique) {
          let line: string;
          if (fmt === "compact") {
            line = `${m.key}: ${m.value}`;
          } else if (fmt === "json") {
            line = JSON.stringify({ key: m.key, value: m.value, scope: m.scope, category: m.category, importance: m.importance });
          } else {
            line = `- [${m.scope}/${m.category}] ${m.key}: ${m.value}`;
          }
          if (totalChars + line.length > charBudget) break;
          lines.push(line);
          totalChars += line.length;
          touchMemory(m.id);
        }

        if (lines.length === 0) {
          if (globalOpts.json) {
            outputJson({ context: "", count: 0 });
          } else {
            console.log(
              chalk.yellow(
                "No relevant memories found for injection."
              )
            );
          }
          return;
        }

        let context: string;
        if (fmt === "compact") {
          context = lines.join("\n");
        } else if (fmt === "json") {
          context = `[${lines.join(",")}]`;
        } else if (fmt === "markdown") {
          context = `## Agent Memories\n\n${lines.join("\n")}`;
        } else {
          context = `<agent-memories>\n${lines.join("\n")}\n</agent-memories>`;
        }

        if (globalOpts.json) {
          outputJson({ context, count: lines.length });
        } else {
          console.log(context);
        }
      } catch (e) {
        handleError(e);
      }
    });
}
