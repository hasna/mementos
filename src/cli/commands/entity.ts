import type { Command } from "commander";
import chalk from "chalk";
import { resolve } from "node:path";
import { getProject } from "../../db/projects.js";
import { createEntity, listEntities, deleteEntity, mergeEntities } from "../../db/entities.js";
import { getRelatedEntities } from "../../db/relations.js";
import { linkEntityToMemory, getMemoriesForEntity } from "../../db/entity-memories.js";
import type { EntityType } from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  makeHandleError,
  resolveKeyOrId,
  resolveEntityArg,
  colorEntityType,
  type GlobalOpts,
} from "../helpers.js";

export function registerEntityCommands(program: Command): void {
  const handleError = makeHandleError(program);

  const entityCmd = program.command("entity").description("Knowledge graph entity commands");

  // ============================================================================
  // entity create <name>
  // ============================================================================

  entityCmd
    .command("create <name>")
    .description("Create a knowledge graph entity")
    .requiredOption("--type <type>", "Entity type: person, project, tool, concept, file, api, pattern, organization")
    .option("--description <text>", "Entity description")
    .option("--project <path>", "Project path for scoping")
    .action((name: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const entity = createEntity({
          name,
          type: opts.type as EntityType,
          description: opts.description as string | undefined,
          project_id: projectId,
        });

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(entity);
        } else {
          console.log(chalk.green(`Entity: ${entity.name} (${entity.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // entity show <nameOrId>
  // ============================================================================

  entityCmd
    .command("show <nameOrId>")
    .description("Show entity details with related entities and linked memories")
    .option("--type <type>", "Entity type hint for name lookup")
    .action((nameOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const entity = resolveEntityArg(nameOrId, opts.type as EntityType | undefined);
        const related = getRelatedEntities(entity.id);
        const memories = getMemoriesForEntity(entity.id);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson({ ...entity, related, memories });
          return;
        }

        console.log(`${chalk.bold("ID:")}          ${entity.id}`);
        console.log(`${chalk.bold("Name:")}        ${entity.name}`);
        console.log(`${chalk.bold("Type:")}        ${colorEntityType(entity.type)}`);
        if (entity.description) console.log(`${chalk.bold("Description:")} ${entity.description}`);
        if (entity.project_id) console.log(`${chalk.bold("Project:")}     ${entity.project_id}`);
        console.log(`${chalk.bold("Created:")}     ${entity.created_at}`);
        console.log(`${chalk.bold("Updated:")}     ${entity.updated_at}`);

        if (related.length > 0) {
          console.log(`\n${chalk.bold("Related entities:")}`);
          for (const r of related) {
            console.log(`  ${chalk.dim(r.id.slice(0, 8))} [${colorEntityType(r.type)}] ${r.name}${r.description ? chalk.dim(` — ${r.description}`) : ""}`);
          }
        }

        if (memories.length > 0) {
          console.log(`\n${chalk.bold("Linked memories:")}`);
          for (const m of memories) {
            const value = m.value.length > 60 ? m.value.slice(0, 60) + "..." : m.value;
            console.log(`  ${chalk.dim(m.id.slice(0, 8))} ${chalk.bold(m.key)} = ${value}`);
          }
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // entity list
  // ============================================================================

  entityCmd
    .command("list")
    .description("List entities with optional filters")
    .option("--type <type>", "Filter by entity type")
    .option("--project <path>", "Filter by project")
    .option("--search <query>", "Search by name or description")
    .option("--limit <n>", "Max results", parseInt)
    .option("--format <fmt>", "Output format: compact, json, csv, yaml")
    .action((opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const projectPath = (opts.project as string | undefined) || globalOpts.project;
        let projectId: string | undefined;
        if (projectPath) {
          const project = getProject(resolve(projectPath));
          if (project) projectId = project.id;
        }

        const entities = listEntities({
          type: opts.type as EntityType | undefined,
          project_id: projectId,
          search: opts.search as string | undefined,
          limit: opts.limit as number | undefined,
        });

        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(entities);
          return;
        }

        if (fmt === "csv") {
          console.log("id,type,name,description");
          for (const e of entities) {
            const desc = (e.description || "").replace(/"/g, '""');
            console.log(`${e.id.slice(0, 8)},${e.type},"${e.name}","${desc}"`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(entities);
          return;
        }

        if (entities.length === 0) {
          console.log(chalk.yellow("No entities found."));
          return;
        }

        console.log(chalk.bold(`${entities.length} entit${entities.length === 1 ? "y" : "ies"}:`));
        for (const e of entities) {
          const id = chalk.dim(e.id.slice(0, 8));
          const desc = e.description ? chalk.dim(` (${e.description})`) : "";
          console.log(`${id}  ${colorEntityType(e.type)}  ${e.name}${desc}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // entity delete <nameOrId>
  // ============================================================================

  entityCmd
    .command("delete <nameOrId>")
    .description("Delete an entity and cascade its relations and memory links")
    .option("--type <type>", "Entity type hint for name lookup")
    .action((nameOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const entity = resolveEntityArg(nameOrId, opts.type as EntityType | undefined);
        deleteEntity(entity.id);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson({ deleted: entity.id, name: entity.name });
        } else {
          console.log(chalk.green(`Deleted entity: ${entity.name} (${entity.id.slice(0, 8)}) — relations and memory links cascaded`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // entity merge <source> <target>
  // ============================================================================

  entityCmd
    .command("merge <source> <target>")
    .description("Merge source entity into target (moves relations and memory links)")
    .action((source: string, target: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const srcEntity = resolveEntityArg(source);
        const tgtEntity = resolveEntityArg(target);
        const merged = mergeEntities(srcEntity.id, tgtEntity.id);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(merged);
        } else {
          console.log(chalk.green(`Merged: ${srcEntity.name} → ${merged.name} (${merged.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // entity link <entity> <memoryKeyOrId>
  // ============================================================================

  entityCmd
    .command("link <entity> <memoryKeyOrId>")
    .description("Link an entity to a memory")
    .option("--role <role>", "Link role: subject, object, context", "context")
    .option("--type <type>", "Entity type hint for name lookup")
    .action((entityArg: string, memoryKeyOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const entity = resolveEntityArg(entityArg, opts.type as EntityType | undefined);

        // Resolve memory by key or partial ID
        const memory = resolveKeyOrId(memoryKeyOrId, {}, globalOpts);
        if (!memory) {
          console.error(chalk.red(`Memory not found: ${memoryKeyOrId}`));
          process.exit(1);
        }

        const link = linkEntityToMemory(entity.id, memory.id, opts.role as "subject" | "object" | "context");

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(link);
        } else {
          console.log(chalk.green(`Linked: ${entity.name} ↔ ${memory.key} (role: ${link.role})`));
        }
      } catch (e) {
        handleError(e);
      }
    });
}
