import type { Command } from "commander";
import chalk from "chalk";
import { getDatabase } from "../../db/database.js";
import { getEntityGraph, findPath } from "../../db/relations.js";
import type { Entity } from "../../types/index.js";
import {
  outputJson,
  makeHandleError,
  resolveEntityArg,
  colorEntityType,
  type GlobalOpts,
} from "../helpers.js";

export function registerGraphCommands(program: Command): void {
  const handleError = makeHandleError(program);

  const graphCmd = program.command("graph").description("Knowledge graph traversal commands");

  // ============================================================================
  // graph show <entityNameOrId>
  // ============================================================================

  graphCmd
    .command("show <entityNameOrId>")
    .description("Show connected entities as an indented tree")
    .option("--depth <n>", "Traversal depth (default: 2)", parseInt)
    .action((entityNameOrId: string, opts) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const entity = resolveEntityArg(entityNameOrId);
        const depth = (opts.depth as number | undefined) || 2;
        const graph = getEntityGraph(entity.id, depth);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(graph);
          return;
        }

        if (graph.entities.length === 0) {
          console.log(chalk.yellow(`No graph data for: ${entity.name}`));
          return;
        }

        // Build adjacency list for tree display
        const adj = new Map<string, { entity: Entity; relation: string }[]>();
        const entityMap = new Map<string, Entity>();
        for (const e of graph.entities) {
          entityMap.set(e.id, e);
          adj.set(e.id, []);
        }
        for (const r of graph.relations) {
          const srcList = adj.get(r.source_entity_id);
          const tgtList = adj.get(r.target_entity_id);
          if (srcList && entityMap.has(r.target_entity_id)) {
            srcList.push({ entity: entityMap.get(r.target_entity_id)!, relation: r.relation_type });
          }
          if (tgtList && entityMap.has(r.source_entity_id)) {
            tgtList.push({ entity: entityMap.get(r.source_entity_id)!, relation: r.relation_type });
          }
        }

        // BFS tree print
        const visited = new Set<string>();
        const printTree = (id: string, indent: string, isLast: boolean) => {
          const e = entityMap.get(id);
          if (!e) return;
          visited.add(id);

          const prefix = indent === "" ? "" : (isLast ? "└── " : "├── ");
          const label = `[${colorEntityType(e.type)}] ${e.name}`;
          console.log(`${indent}${prefix}${label}`);

          const children = (adj.get(id) || []).filter((c) => !visited.has(c.entity.id));
          for (let i = 0; i < children.length; i++) {
            const child = children[i]!;
            const childIndent = indent + (indent === "" ? "" : (isLast ? "    " : "│   "));
            const relLabel = chalk.dim(` (${child.relation})`);
            const childPrefix = i === children.length - 1 ? "└── " : "├── ";
            visited.add(child.entity.id);
            console.log(`${childIndent}${childPrefix}[${colorEntityType(child.entity.type)}] ${child.entity.name}${relLabel}`);

            // Recurse one more level for nested children
            const grandChildren = (adj.get(child.entity.id) || []).filter((c) => !visited.has(c.entity.id));
            for (let j = 0; j < grandChildren.length; j++) {
              const gc = grandChildren[j]!;
              const gcIndent = childIndent + (i === children.length - 1 ? "    " : "│   ");
              const gcPrefix = j === grandChildren.length - 1 ? "└── " : "├── ";
              const gcRelLabel = chalk.dim(` (${gc.relation})`);
              visited.add(gc.entity.id);
              console.log(`${gcIndent}${gcPrefix}[${colorEntityType(gc.entity.type)}] ${gc.entity.name}${gcRelLabel}`);
            }
          }
        };

        printTree(entity.id, "", true);
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // graph path <from> <to>
  // ============================================================================

  graphCmd
    .command("path <from> <to>")
    .description("Show shortest path between two entities")
    .action((from: string, to: string) => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const fromEntity = resolveEntityArg(from);
        const toEntity = resolveEntityArg(to);
        const path = findPath(fromEntity.id, toEntity.id);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson(path);
          return;
        }

        if (!path) {
          console.log(chalk.yellow(`No path found between ${fromEntity.name} and ${toEntity.name}`));
          return;
        }

        console.log(chalk.bold(`Path (${path.length} hop${path.length === 1 ? "" : "s"}):`));
        for (let i = 0; i < path.length; i++) {
          const e = path[i]!;
          const arrow = i < path.length - 1 ? " →" : "";
          console.log(`  ${i + 1}. [${colorEntityType(e.type)}] ${e.name}${arrow}`);
        }
      } catch (e) {
        handleError(e);
      }
    });

  // ============================================================================
  // graph stats
  // ============================================================================

  graphCmd
    .command("stats")
    .description("Show knowledge graph statistics")
    .action(() => {
      try {
        const globalOpts = program.opts<GlobalOpts>();
        const db = getDatabase();

        // Entity counts by type
        const entityRows = db.query(
          "SELECT type, COUNT(*) as count FROM entities GROUP BY type ORDER BY count DESC"
        ).all() as { type: string; count: number }[];

        // Relation counts by type
        const relationRows = db.query(
          "SELECT relation_type, COUNT(*) as count FROM relations GROUP BY relation_type ORDER BY count DESC"
        ).all() as { relation_type: string; count: number }[];

        // Total memory links
        const linkCount = db.query(
          "SELECT COUNT(*) as count FROM entity_memories"
        ).get() as { count: number };

        const totalEntities = entityRows.reduce((sum, r) => sum + r.count, 0);
        const totalRelations = relationRows.reduce((sum, r) => sum + r.count, 0);

        if (globalOpts.json || globalOpts.format === "json") {
          outputJson({
            entities: { total: totalEntities, by_type: Object.fromEntries(entityRows.map((r) => [r.type, r.count])) },
            relations: { total: totalRelations, by_type: Object.fromEntries(relationRows.map((r) => [r.relation_type, r.count])) },
            memory_links: linkCount.count,
          });
          return;
        }

        console.log(chalk.bold("Knowledge Graph Stats"));
        console.log();

        console.log(chalk.bold(`Entities: ${totalEntities}`));
        for (const r of entityRows) {
          console.log(`  ${colorEntityType(r.type)}: ${r.count}`);
        }

        console.log();
        console.log(chalk.bold(`Relations: ${totalRelations}`));
        for (const r of relationRows) {
          console.log(`  ${chalk.cyan(r.relation_type)}: ${r.count}`);
        }

        console.log();
        console.log(chalk.bold(`Memory links: ${linkCount.count}`));
      } catch (e) {
        handleError(e);
      }
    });
}
