import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createRelation, getRelation, listRelations, deleteRelation } from "../../db/relations.js";
import { resolveEntityParam, resolveGraphId, formatGraphError } from "./graph-utils.js";

export function registerRelationTools(server: McpServer): void {
  server.tool(
    "relation_get",
    "Get a relation by ID.",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const relation = getRelation(args.id);
        if (!relation) return { content: [{ type: "text" as const, text: `Relation not found: ${args.id}` }] };
        return { content: [{ type: "text" as const, text: `Relation ${relation.id.slice(0, 8)}: ${relation.source_entity_id.slice(0, 8)} —[${relation.relation_type}]→ ${relation.target_entity_id.slice(0, 8)} (weight: ${relation.weight})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "relation_create",
    "Create a relation between two entities (uses, knows, depends_on, created_by, related_to, contradicts, part_of, implements).",
    {
      source_entity: z.string(),
      target_entity: z.string(),
      relation_type: z.enum(["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"]),
      weight: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const source = resolveEntityParam(args.source_entity);
        const target = resolveEntityParam(args.target_entity);
        const relation = createRelation({
          source_entity_id: source.id,
          target_entity_id: target.id,
          relation_type: args.relation_type,
          weight: args.weight,
        });
        return { content: [{ type: "text" as const, text: `Relation: ${source.name} —[${relation.relation_type}]→ ${target.name} (${relation.id.slice(0, 8)})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "relation_list",
    "List relations for an entity. Filter by type and direction (outgoing, incoming, both).",
    {
      entity_name_or_id: z.string(),
      relation_type: z.enum(["uses", "knows", "depends_on", "created_by", "related_to", "contradicts", "part_of", "implements"]).optional(),
      direction: z.enum(["outgoing", "incoming", "both"]).optional(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const relations = listRelations({
          entity_id: entity.id,
          relation_type: args.relation_type,
          direction: args.direction || "both",
        });
        if (relations.length === 0) {
          return { content: [{ type: "text" as const, text: `No relations found for: ${entity.name}` }] };
        }
        const lines = relations.map(r =>
          `${r.id.slice(0, 8)} | ${r.source_entity_id.slice(0, 8)} —[${r.relation_type}]→ ${r.target_entity_id.slice(0, 8)} (w:${r.weight})`
        );
        return { content: [{ type: "text" as const, text: `${relations.length} relation(s) for ${entity.name}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "relation_delete",
    "Delete a relation by ID.",
    {
      id: z.string(),
    },
    async (args) => {
      try {
        const id = resolveGraphId(args.id, "relations");
        deleteRelation(id);
        return { content: [{ type: "text" as const, text: `Relation ${id.slice(0, 8)} deleted.` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );
}
