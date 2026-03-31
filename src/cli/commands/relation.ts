import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { getEntity } from "../../db/entities.js";
import { createRelation, listRelations, deleteRelation } from "../../db/relations.js";
import type { Entity, RelationType } from "../../types/index.js";
import {
  outputJson,
  outputYaml,
  getOutputFormat,
  makeHandleError,
  resolveEntityArg,
  type GlobalOpts,
} from "../helpers.js";

export function registerRelationCommands(program: Command): void {
  const handleError = makeHandleError(program);

  const relationCmd = program.command("relation").description("Knowledge graph relation commands");

  // ============================================================================
  // relation create <source> <target>
  // ============================================================================

  relationCmd
    .command("create <source> <target>")
    .description("Create a relation between two entities")
    .requiredOption("--type <relationType>", "Relation type: uses, knows, depends_on, created_by, related_to, contradicts, part_of, implements")
    .option("--weight <n>", "Relation weight (default: 1.0)", parseFloat)
    .action((source: string, target: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const srcEntity = resolveEntityArg(source);
        const tgtEntity = resolveEntityArg(target);

        const relation = createRelation({
          source_entity_id: srcEntity.id,
          target_entity_id: tgtEntity.id,
          relation_type: opts.type as RelationType,
          weight: opts.weight as number | undefined,
        });

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(relation);
        } else {
          console.log(chalk.green(`Relation: ${srcEntity.name} —[${relation.relation_type}]→ ${tgtEntity.name} (${relation.id.slice(0, 8)})`));
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // relation list <entityNameOrId>
  // ============================================================================

  relationCmd
    .command("list <entityNameOrId>")
    .description("List relations for an entity")
    .option("--type <relationType>", "Filter by relation type")
    .option("--direction <dir>", "Direction: outgoing, incoming, both", "both")
    .option("--format <fmt>", "Output format: compact, json, csv, yaml")
    .action((entityNameOrId: string, opts) => {
      try {
        const entity = resolveEntityArg(entityNameOrId);

        const relations = listRelations({
          entity_id: entity.id,
          relation_type: opts.type as RelationType | undefined,
          direction: opts.direction as "outgoing" | "incoming" | "both",
        });

        const fmt = getOutputFormat(program, opts.format as string | undefined);

        if (fmt === "json") {
          outputJson(relations);
          return;
        }

        if (fmt === "csv") {
          console.log("id,source,target,type,weight");
          for (const r of relations) {
            console.log(`${r.id.slice(0, 8)},${r.source_entity_id.slice(0, 8)},${r.target_entity_id.slice(0, 8)},${r.relation_type},${r.weight}`);
          }
          return;
        }

        if (fmt === "yaml") {
          outputYaml(relations);
          return;
        }

        if (relations.length === 0) {
          console.log(chalk.yellow(`No relations found for: ${entity.name}`));
          return;
        }

        // Resolve entity names for display
        const entityCache = new Map<string, Entity>();
        entityCache.set(entity.id, entity);
        const resolveName = (id: string): string => {
          if (entityCache.has(id)) return entityCache.get(id)!.name;
          try {
            const e = getEntity(id);
            entityCache.set(id, e);
            return e.name;
          } catch {
            return id.slice(0, 8);
          }
        };

        console.log(chalk.bold(`${relations.length} relation${relations.length === 1 ? "" : "s"} for ${entity.name}:`));
        for (const r of relations) {
          const src = resolveName(r.source_entity_id);
          const tgt = resolveName(r.target_entity_id);
          const id = chalk.dim(r.id.slice(0, 8));
          const weight = r.weight !== 1.0 ? chalk.dim(` w:${r.weight}`) : "";
          console.log(`${id}  ${src} —[${chalk.cyan(r.relation_type)}]→ ${tgt}${weight}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // relation delete <id>
  // ============================================================================

  relationCmd
    .command("delete <id>")
    .description("Delete a relation by ID")
    .action((id: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();
        const resolvedId = resolvePartialId(db, "relations", id);
        if (!resolvedId) {
          console.error(chalk.red(`Relation not found: ${id}`));
          process.exit(1);
        }

        deleteRelation(resolvedId);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson({ deleted: resolvedId });
        } else {
          console.log(chalk.green(`Deleted relation: ${resolvedId.slice(0, 8)}`));
        }
      } catch (e) {
        handleError(e);
      }
    });
}
