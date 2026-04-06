import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createEntity, listEntities, updateEntity, deleteEntity, mergeEntities } from "../../db/entities.js";
import { listRelations } from "../../db/relations.js";
import { linkEntityToMemory, unlinkEntityFromMemory, getMemoriesForEntity } from "../../db/entity-memories.js";
import { resolveEntityParam, resolveGraphId, formatGraphError } from "./graph-utils.js";

export function registerEntityTools(server: McpServer): void {
  server.tool(
    "entity_create",
    "Create a knowledge graph entity (person, project, tool, concept, file, api, pattern, organization).",
    {
      name: z.string(),
      type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]),
      description: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const entity = createEntity(args);
        return { content: [{ type: "text" as const, text: `Entity: ${entity.name} [${entity.type}] (${entity.id.slice(0, 8)})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_get",
    "Get entity details by name or ID, including relations summary and memory count.",
    {
      name_or_id: z.string(),
      type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]).optional(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.name_or_id, args.type);
        const relations = listRelations({ entity_id: entity.id });
        const memories = getMemoriesForEntity(entity.id);
        const lines = [
          `ID: ${entity.id}`,
          `Name: ${entity.name}`,
          `Type: ${entity.type}`,
        ];
        if (entity.description) lines.push(`Description: ${entity.description}`);
        if (entity.project_id) lines.push(`Project: ${entity.project_id}`);
        lines.push(`Relations: ${relations.length}`);
        lines.push(`Memories: ${memories.length}`);
        lines.push(`Created: ${entity.created_at}`);
        lines.push(`Updated: ${entity.updated_at}`);
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_list",
    "List entities. Optional filters: type, project_id, search, limit.",
    {
      type: z.enum(["person", "project", "tool", "concept", "file", "api", "pattern", "organization"]).optional(),
      project_id: z.string().optional(),
      search: z.string().optional(),
      limit: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const entities = listEntities({ ...args, limit: args.limit || 50 });
        if (entities.length === 0) {
          return { content: [{ type: "text" as const, text: "No entities found." }] };
        }
        const lines = entities.map(e => `${e.id.slice(0, 8)} | ${e.type} | ${e.name}`);
        return { content: [{ type: "text" as const, text: `${entities.length} entit${entities.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_delete",
    "Delete an entity by name or ID.",
    {
      name_or_id: z.string(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.name_or_id);
        deleteEntity(entity.id);
        return { content: [{ type: "text" as const, text: `Entity deleted: ${entity.name} (${entity.id.slice(0, 8)})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_merge",
    "Merge source entity into target. Moves all relations and memory links.",
    {
      source: z.string(),
      target: z.string(),
    },
    async (args) => {
      try {
        const sourceEntity = resolveEntityParam(args.source);
        const targetEntity = resolveEntityParam(args.target);
        const merged = mergeEntities(sourceEntity.id, targetEntity.id);
        return { content: [{ type: "text" as const, text: `Merged: ${sourceEntity.name} → ${merged.name} [${merged.type}] (${merged.id.slice(0, 8)})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_link",
    "Link an entity to a memory with a role (subject, object, or context).",
    {
      entity_name_or_id: z.string(),
      memory_id: z.string(),
      role: z.enum(["subject", "object", "context"]).optional(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const memoryId = resolveGraphId(args.memory_id);
        const link = linkEntityToMemory(entity.id, memoryId, args.role || "context");
        return { content: [{ type: "text" as const, text: `Linked: ${entity.name} → memory ${memoryId.slice(0, 8)} [${link.role}]` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_update",
    "Update an entity's name, description, or metadata.",
    {
      entity_name_or_id: z.string(),
      name: z.string().optional(),
      description: z.string().nullable().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const { entity_name_or_id: _id, ...updates } = args;
        const updated = updateEntity(entity.id, updates);
        return { content: [{ type: "text" as const, text: `Updated entity: ${updated.name} (${updated.id.slice(0, 8)})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_unlink",
    "Unlink a memory from an entity.",
    {
      entity_name_or_id: z.string(),
      memory_id: z.string(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const memoryId = resolveGraphId(args.memory_id);
        unlinkEntityFromMemory(entity.id, memoryId);
        return { content: [{ type: "text" as const, text: `Unlinked: ${entity.name} ↛ memory ${memoryId.slice(0, 8)}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "entity_disambiguate",
    "Find potential duplicate entities by name similarity (trigram). Returns pairs above the threshold within same type+project.",
    {
      threshold: z.coerce.number().min(0).max(1).optional().describe("Similarity threshold 0-1 (default 0.8)"),
    },
    async (args) => {
      try {
        const { findDuplicateEntities } = await import("../../db/entities.js");
        const pairs = findDuplicateEntities(args.threshold ?? 0.8);
        if (pairs.length === 0) {
          return { content: [{ type: "text" as const, text: "No duplicate entities found." }] };
        }
        const lines = pairs.map((p) =>
          `${p.entity_a.name} <-> ${p.entity_b.name} [${p.entity_a.type}] similarity=${p.similarity.toFixed(2)}`
        );
        return { content: [{ type: "text" as const, text: `Found ${pairs.length} potential duplicate(s):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );
}
