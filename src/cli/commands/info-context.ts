import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { listMemories, touchMemory } from "../../db/memories.js";
import { searchMemories } from "../../lib/search.js";
import type { MemoryCategory, MemoryScope, MemoryFilter } from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  type GlobalOpts,
} from "../helpers.js";

export function registerContextCommand(program: Command): void {
  const handleError = makeHandleError(program);

  program
    .command("context [query]")
    .description(
      "Get formatted, prompt-ready block of relevant memories"
    )
    .option("--max-tokens <n>", "Max approximate token budget", parseInt)
    .option("--min-importance <n>", "Minimum importance threshold", parseInt)
    .option("--scope <scope>", "Filter by scope (global, shared, private)")
    .option("--categories <cats>", "Comma-separated categories to include")
    .option("--agent <name>", "Agent ID for scope filtering")
    .option("--project <path>", "Project path for scope filtering")
    .action((query: string | undefined, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const maxTokens = (opts.maxTokens as number | undefined) || 500;
        const minImportance = (opts.minImportance as number | undefined) || 1;
        const scope = opts.scope as MemoryScope | undefined;
        const categoriesRaw = opts.categories as string | undefined;
        const categories = categoriesRaw
          ? (categoriesRaw.split(",").map((c: string) => c.trim()) as MemoryCategory[])
          : undefined;
        const agentId = (opts.agent as string | undefined) || globalOpts.agent;
        const projectPath = (opts.project as string | undefined) || globalOpts.project;

        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        let memories: import("../../types/index.js").Memory[];

        if (query) {
          // Use search for relevance-ranked results
          const filter: MemoryFilter = {
            min_importance: minImportance,
            status: "active",
          };
          if (scope) filter.scope = scope;
          if (categories) filter.category = categories;
          if (agentId) filter.agent_id = agentId;
          if (projectId) filter.project_id = projectId;

          const results = searchMemories(query, filter);
          memories = results.map((r: { memory: import("../../types/index.js").Memory }) => r.memory);
        } else {
          // No query — gather all relevant memories like inject
          memories = [];
          const baseFilter = {
            min_importance: minImportance,
            status: "active" as const,
            category: categories,
            limit: 100,
          };

          if (!scope || scope === "global") {
            memories.push(
              ...listMemories({ ...baseFilter, scope: "global", project_id: projectId })
            );
          }
          if (!scope || scope === "shared") {
            memories.push(
              ...listMemories({ ...baseFilter, scope: "shared", project_id: projectId })
            );
          }
          if (!scope || scope === "private") {
            if (agentId) {
              memories.push(
                ...listMemories({ ...baseFilter, scope: "private", agent_id: agentId })
              );
            }
          }
        }

        // Deduplicate
        const seen = new Set<string>();
        memories = memories.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });

        // Sort by importance DESC, then recency
        memories.sort((a, b) => {
          if (b.importance !== a.importance) return b.importance - a.importance;
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
        });

        // Trim to token budget (~4 chars per token)
        const charBudget = maxTokens * 4;
        const lines: string[] = [];
        let totalChars = 0;

        for (const m of memories) {
          const line = `- [${m.category}] ${m.key}: ${m.value} (importance: ${m.importance})`;
          if (totalChars + line.length > charBudget) break;
          lines.push(line);
          totalChars += line.length;
          touchMemory(m.id);
        }

        if (globalOpts.json) {
          outputJson({ context: lines.length > 0 ? `## Memories\n\n${lines.join("\n")}` : "", count: lines.length });
          return;
        }

        if (lines.length === 0) {
          // Pipe-friendly: output nothing if no memories
          if (process.stdout.isTTY) {
            console.log(chalk.yellow("No relevant memories found."));
          }
          return;
        }

        console.log(`## Memories\n\n${lines.join("\n")}`);
      } catch (e) {
        handleError(e);
      }
    });
}
