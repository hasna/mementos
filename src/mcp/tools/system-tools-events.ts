import type { SystemToolDeps, CreateMemoryInput } from "./system-tools-shared.js";

export function registerSystemEventTools({ server, z, createMemory, getDatabase, saveToolEvent, formatError }: SystemToolDeps): void {
  server.tool(
    "memory_subscribe",
    "Subscribe an agent to memory change notifications. Matches by key pattern (glob) and/or tag pattern.",
    {
      agent_id: z.string().describe("Agent ID to subscribe"),
      key_pattern: z.string().optional().describe("Key glob pattern (e.g. 'architecture-*')"),
      tag_pattern: z.string().optional().describe("Tag pattern to match"),
      scope: z.enum(["global", "shared", "private", "working"]).optional().describe("Scope filter"),
    },
    async (args) => {
      try {
        if (!args.key_pattern && !args.tag_pattern) {
          return { content: [{ type: "text" as const, text: "Error: Provide at least one of key_pattern or tag_pattern" }], isError: true };
        }
        const db = getDatabase();
        const id = crypto.randomUUID().slice(0, 8);
        db.run(
          `INSERT INTO memory_subscriptions (id, agent_id, key_pattern, tag_pattern, scope, created_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'))`,
          [id, args.agent_id, args.key_pattern || null, args.tag_pattern || null, args.scope || null]
        );
        return { content: [{ type: "text" as const, text: JSON.stringify({
          subscription_id: id,
          agent_id: args.agent_id,
          key_pattern: args.key_pattern || null,
          tag_pattern: args.tag_pattern || null,
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_unsubscribe",
    "Remove a memory subscription by ID.",
    {
      id: z.string().describe("Subscription ID to remove"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const result = db.run("DELETE FROM memory_subscriptions WHERE id = ?", [args.id]);
        if (result.changes === 0) {
          return { content: [{ type: "text" as const, text: `Subscription not found: ${args.id}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Unsubscribed: ${args.id}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_save_tool_event",
    "Record a tool call event (success/failure, latency, tokens). Optionally saves a lesson as a shared memory.",
    {
      tool_name: z.string().describe("Name of the tool that was called (e.g. 'bash', 'read', 'grep')"),
      action: z.string().optional().describe("What was attempted (e.g. 'npm install', 'git push')"),
      success: z.boolean().describe("Whether the tool call succeeded"),
      error_type: z.enum(["timeout", "permission", "not_found", "syntax", "rate_limit", "other"]).optional().describe("Error category if failed"),
      error_message: z.string().optional().describe("Raw error text if failed"),
      tokens_used: z.number().optional().describe("Tokens consumed by the tool call"),
      latency_ms: z.number().optional().describe("Time taken in milliseconds"),
      context: z.string().optional().describe("What task triggered this tool call"),
      lesson: z.string().optional().describe("Qualitative insight learned from this call"),
      when_to_use: z.string().optional().describe("Activation context for the lesson"),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
    },
    async (args) => {
      try {
        const event = saveToolEvent(args);

        if (args.lesson) {
          try {
            createMemory({
              key: `tool-lesson-${args.tool_name}-${Date.now()}`,
              value: args.lesson,
              category: "knowledge",
              scope: "shared",
              importance: 7,
              tags: ["tool-memory", args.tool_name],
              when_to_use: args.when_to_use,
              agent_id: args.agent_id,
              project_id: args.project_id,
              session_id: args.session_id,
              source: "auto",
            } as unknown as CreateMemoryInput);
          } catch {
          }
        }

        return { content: [{ type: "text" as const, text: JSON.stringify({
          id: event.id,
          tool_name: event.tool_name,
          success: event.success,
          error_type: event.error_type,
          lesson_saved: !!args.lesson,
          created_at: event.created_at,
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "send_feedback",
    "Send feedback about this service",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async (params) => {
      try {
        const db = getDatabase();
        const { createRequire } = await import("node:module");
        const _require = createRequire(import.meta.url);
        const pkg = _require("../../../package.json") as { version: string };
        db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
          params.message, params.email || null, params.category || "general", pkg.version,
        ]);
        return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: String(e) }], isError: true };
      }
    },
  );

  server.tool(
    "migrate_pg",
    "Apply PostgreSQL schema migrations to the configured RDS instance",
    {
      connection_string: z.string().optional().describe("PostgreSQL connection string (overrides cloud config)"),
    },
    async ({ connection_string }) => {
      try {
        let connStr: string;
        if (connection_string) {
          connStr = connection_string;
        } else {
          const { getConnectionString } = await import("@hasna/cloud");
          connStr = getConnectionString("mementos");
        }

        const { applyPgMigrations } = await import("../../db/pg-migrate.js");
        const result = await applyPgMigrations(connStr);

        const lines: string[] = [];
        if (result.applied.length > 0) {
          lines.push(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`);
        }
        if (result.alreadyApplied.length > 0) {
          lines.push(`Already applied: ${result.alreadyApplied.length} migration(s)`);
        }
        if (result.errors.length > 0) {
          lines.push(`Errors:\n${result.errors.join("\n")}`);
        }
        if (result.applied.length === 0 && result.errors.length === 0) {
          lines.push("Schema is up to date.");
        }
        lines.push(`Total migrations: ${result.totalMigrations}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          isError: result.errors.length > 0,
        };
      } catch (e: any) {
        return {
          content: [{ type: "text" as const, text: `Migration failed: ${e?.message ?? String(e)}` }],
          isError: true,
        };
      }
    },
  );
}
