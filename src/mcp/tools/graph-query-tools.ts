import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDatabase, resolvePartialId } from "../../db/database.js";
import { getEntityGraph, findPath } from "../../db/relations.js";
import { graphTraverse } from "../../db/entities.js";
import { resolveEntityParam, formatGraphError } from "./graph-utils.js";
import { buildFileDependencyGraph } from "../../lib/file-deps.js";
import { getToolStats, getToolLessons, getToolEvents } from "../../db/tool-events.js";

export function registerGraphQueryTools(server: McpServer): void {
  server.tool(
    "graph_query",
    "Traverse the knowledge graph from an entity up to N hops. Returns entities and relations.",
    {
      entity_name_or_id: z.string(),
      depth: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const depth = args.depth ?? 2;
        const graph = getEntityGraph(entity.id, depth);
        if (graph.entities.length === 0) {
          return { content: [{ type: "text" as const, text: `No graph found for: ${entity.name}` }] };
        }
        const entityLines = graph.entities.map(e => `  ${e.id.slice(0, 8)} | ${e.type} | ${e.name}`);
        const relationLines = graph.relations.map(r =>
          `  ${r.source_entity_id.slice(0, 8)} —[${r.relation_type}]→ ${r.target_entity_id.slice(0, 8)}`
        );
        const lines = [
          `Graph for ${entity.name} (depth ${depth}):`,
          `Entities (${graph.entities.length}):`,
          ...entityLines,
        ];
        if (relationLines.length > 0) {
          lines.push(`Relations (${graph.relations.length}):`, ...relationLines);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "graph_path",
    "Find shortest path between two entities in the knowledge graph.",
    {
      from_entity: z.string(),
      to_entity: z.string(),
      max_depth: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const from = resolveEntityParam(args.from_entity);
        const to = resolveEntityParam(args.to_entity);
        const maxDepth = args.max_depth ?? 5;
        const path = findPath(from.id, to.id, maxDepth);
        if (!path || path.length === 0) {
          return { content: [{ type: "text" as const, text: `No path found: ${from.name} → ${to.name} (max depth ${maxDepth})` }] };
        }
        const pathStr = path.map(e => e.name).join(" → ");
        return { content: [{ type: "text" as const, text: `Path: ${pathStr}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "graph_stats",
    "Comprehensive knowledge graph statistics: entity/relation counts by type, most-connected entities, orphan count, average degree.",
    {},
    async () => {
      try {
        const db = getDatabase();
        const entityTotal = (db.query("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
        const byType = db.query("SELECT type, COUNT(*) as c FROM entities GROUP BY type").all() as { type: string; c: number }[];
        const relationTotal = (db.query("SELECT COUNT(*) as c FROM relations").get() as { c: number }).c;
        const byRelType = db.query("SELECT relation_type, COUNT(*) as c FROM relations GROUP BY relation_type").all() as { relation_type: string; c: number }[];
        const linkTotal = (db.query("SELECT COUNT(*) as c FROM entity_memories").get() as { c: number }).c;

        // Most-connected entities (top 10 by total degree)
        const mostConnected = db.query(`
          SELECT e.id, e.name, e.type,
            (SELECT COUNT(*) FROM relations WHERE source_entity_id = e.id) +
            (SELECT COUNT(*) FROM relations WHERE target_entity_id = e.id) as degree
          FROM entities e ORDER BY degree DESC LIMIT 10
        `).all() as { id: string; name: string; type: string; degree: number }[];

        // Orphan entities (no relations)
        const orphanCount = (db.query(`
          SELECT COUNT(*) as c FROM entities e
          WHERE NOT EXISTS (SELECT 1 FROM relations WHERE source_entity_id = e.id OR target_entity_id = e.id)
        `).get() as { c: number }).c;

        // Average degree
        const avgDegree = entityTotal > 0 ? (relationTotal * 2) / entityTotal : 0;

        const lines = [
          `Entities: ${entityTotal}`,
        ];
        if (byType.length > 0) {
          lines.push(`  By type: ${byType.map(r => `${r.type}=${r.c}`).join(", ")}`);
        }
        lines.push(`Relations: ${relationTotal}`);
        if (byRelType.length > 0) {
          lines.push(`  By type: ${byRelType.map(r => `${r.relation_type}=${r.c}`).join(", ")}`);
        }
        lines.push(`Entity-memory links: ${linkTotal}`);
        lines.push(`Avg degree: ${avgDegree.toFixed(1)}`);
        lines.push(`Orphan entities: ${orphanCount}`);
        if (mostConnected.length > 0 && mostConnected[0]!.degree > 0) {
          lines.push(`Most connected:`);
          for (const e of mostConnected.filter(e => e.degree > 0)) {
            lines.push(`  ${e.name} (${e.type}) — ${e.degree} connections`);
          }
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "graph_traverse",
    "Multi-hop graph traversal from an entity. Returns all paths with entities and relations at each hop. Supports direction and relation-type filtering.",
    {
      entity_name_or_id: z.string().describe("Starting entity name or ID"),
      max_depth: z.coerce.number().optional().describe("Max traversal depth (default 2)"),
      relation_types: z.array(z.string()).optional().describe("Filter by relation types"),
      direction: z.enum(["outgoing", "incoming", "both"]).optional().describe("Traversal direction (default both)"),
      limit: z.coerce.number().optional().describe("Max paths to return (default 50)"),
    },
    async (args) => {
      try {
        const entity = resolveEntityParam(args.entity_name_or_id);
        const result = graphTraverse(entity.id, {
          max_depth: args.max_depth,
          relation_types: args.relation_types,
          direction: args.direction,
          limit: args.limit,
        });

        if (result.total_paths === 0) {
          return { content: [{ type: "text" as const, text: `No paths found from: ${entity.name}` }] };
        }

        const lines = [
          `Traversal from ${entity.name} (${result.total_paths} paths, ${result.visited_entities.length} entities):`,
        ];

        for (const path of result.paths) {
          const pathStr = path.entities.map((e) => e.name).join(" -> ");
          const relStr = path.relations.map((r) => r.relation_type).join(", ");
          lines.push(`  [depth ${path.depth}] ${pathStr} (${relStr})`);
        }

        lines.push(`\nVisited entities:`);
        for (const ve of result.visited_entities) {
          lines.push(`  ${ve.id.slice(0, 8)} | ${ve.type} | ${ve.name}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "build_file_dep_graph",
    "Scan a codebase directory and build a file dependency graph: creates 'file' entities and 'depends_on' relations based on import/require statements. Use graph_query to find blast radius of a file change.",
    {
      root_dir: z.string().describe("Root directory to scan"),
      project_id: z.string().optional().describe("Project to associate file entities with"),
      extensions: z.array(z.string()).optional().describe("File extensions to scan (default: .ts .tsx .js .jsx .py .go .rs)"),
      exclude_patterns: z.array(z.string()).optional().describe("Directory/file patterns to skip (default: node_modules, dist, .git, etc.)"),
      incremental: z.boolean().optional().describe("Skip files that already have entities (default: true)"),
    },
    async (args) => {
      try {
        const result = await buildFileDependencyGraph({
          root_dir: args.root_dir,
          project_id: args.project_id ? resolvePartialId(getDatabase(), "projects", args.project_id) ?? args.project_id : undefined,
          extensions: args.extensions,
          exclude_patterns: args.exclude_patterns,
          incremental: args.incremental ?? true,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_tool_insights",
    "Get usage stats, lessons learned, and recommendations for MCP tools. Helps agents avoid past mistakes and reuse successful patterns.",
    {
      tool_name: z.string().optional().describe("Specific tool to get insights for. If omitted, returns insights for all tools."),
      task_context: z.string().optional().describe("What the agent is about to do — used to find relevant tool lessons via semantic match"),
      project_id: z.string().optional(),
      agent_id: z.string().optional(),
      limit: z.coerce.number().optional().default(10).describe("Max lessons to return per tool"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const projId = args.project_id ? resolvePartialId(db, "projects", args.project_id) ?? args.project_id : undefined;
        const limit = args.limit ?? 10;

        // Determine which tools to report on
        let toolNames: string[];
        if (args.tool_name) {
          toolNames = [args.tool_name];
        } else {
          // Get unique tool names from recent events
          const filters: Parameters<typeof getToolEvents>[0] = { limit: 200 };
          if (projId) filters.project_id = projId;
          if (args.agent_id) filters.agent_id = args.agent_id;
          const events = getToolEvents(filters);
          toolNames = [...new Set(events.map(e => e.tool_name))];
        }

        if (toolNames.length === 0) {
          return { content: [{ type: "text" as const, text: "No tool events recorded yet." }] };
        }

        const sections: string[] = [];

        for (const tn of toolNames) {
          const stats = getToolStats(tn, projId);
          const lessons = getToolLessons(tn, projId, limit);

          // Build stats line
          const successPct = stats.total_calls > 0 ? Math.round(stats.success_rate * 100) : 0;
          const avgTok = stats.avg_tokens != null ? Math.round(stats.avg_tokens) : "?";
          const avgLat = stats.avg_latency_ms != null ? (stats.avg_latency_ms / 1000).toFixed(1) : "?";
          let section = `## Tool: ${tn}\nStats: ${stats.total_calls} calls | ${successPct}% success | avg ${avgTok} tokens | avg ${avgLat}s`;

          // Common errors
          if (stats.common_errors.length > 0) {
            const errParts = stats.common_errors.map(e => `${e.error_type} (${e.count})`);
            section += `\nCommon errors: ${errParts.join(", ")}`;
          }

          // Recommendations from lessons
          if (lessons.length > 0) {
            const dos: string[] = [];
            const donts: string[] = [];
            for (const l of lessons) {
              const ctx = (l.when_to_use || "").toLowerCase();
              if (ctx.includes("fail") || ctx.includes("error") || ctx.includes("avoid") || ctx.includes("don't") || ctx.includes("never")) {
                donts.push(l.lesson);
              } else {
                dos.push(l.lesson);
              }
            }

            if (dos.length > 0 || donts.length > 0) {
              section += "\n\n### Recommendations";
              for (const d of dos.slice(0, 5)) section += `\n✅ DO: ${d}`;
              for (const d of donts.slice(0, 5)) section += `\n❌ DON'T: ${d}`;
            }

            // Full lesson list
            section += "\n\n### Lessons (newest first)";
            for (const l of lessons) {
              const when = l.when_to_use ? ` (when: ${l.when_to_use})` : "";
              section += `\n- ${l.lesson}${when}`;
            }
          }

          sections.push(section);
        }

        // If task_context provided, highlight which lessons are most relevant
        let header = "";
        if (args.task_context) {
          header = `> Context: "${args.task_context}"\n> Showing insights filtered for relevance.\n\n`;
        }

        return { content: [{ type: "text" as const, text: header + sections.join("\n\n---\n\n") }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatGraphError(e) }], isError: true };
      }
    }
  );
}
