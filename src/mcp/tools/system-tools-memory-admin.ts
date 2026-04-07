import type { SystemToolDeps, Memory, CreateMemoryInput } from "./system-tools-shared.js";

export function registerSystemMemoryAdminTools({ server, z, createMemory, getMemory, getDatabase, formatError, resolveId, ensureAutoProject }: SystemToolDeps): void {
  server.tool(
    "memory_audit",
    "Review low-trust memories (trust_score < threshold). Returns memories flagged by the poisoning detection heuristic for manual review.",
    {
      threshold: z.coerce.number().optional().describe("Trust score threshold (default 0.8). Returns memories below this."),
      project_id: z.string().optional(),
      limit: z.coerce.number().optional().describe("Max results (default 50)"),
    },
    async (args) => {
      try {
        const db = getDatabase();
        const threshold = args.threshold ?? 0.8;
        const limit = args.limit ?? 50;
        const conditions: string[] = ["trust_score < ?", "status = 'active'"];
        const params: (string | number)[] = [threshold];
        if (args.project_id) {
          const { resolvePartialId } = await import("../../db/database.js");
          const resolved = resolvePartialId(db, "projects", args.project_id);
          conditions.push("project_id = ?");
          params.push(resolved ?? args.project_id);
        }
        params.push(limit);
        const sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY trust_score ASC LIMIT ?`;
        const rows = db.query(sql).all(...params) as Record<string, unknown>[];
        if (rows.length === 0) {
          return { content: [{ type: "text" as const, text: `No low-trust memories found (threshold: ${threshold})` }] };
        }
        const { parseMemoryRow } = await import("../../db/memories.js");
        const memories = rows.map(parseMemoryRow);
        const lines = memories.map((m) =>
          `[trust=${(m.trust_score ?? 1.0).toFixed(2)}] ${m.id.slice(0, 8)} ${m.key}: ${m.value.slice(0, 80)}${m.value.length > 80 ? "..." : ""}`
        );
        return { content: [{ type: "text" as const, text: `Low-trust memories (${rows.length}, threshold < ${threshold}):\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_rate",
    "Rate a memory as useful or not useful. Provides feedback for memory quality tracking.",
    {
      memory_id: z.string().describe("Memory ID (partial OK)"),
      useful: z.coerce.boolean().describe("Was this memory useful?"),
      agent_id: z.string().optional().describe("Agent providing the rating"),
      context: z.string().optional().describe("Optional context about why the rating was given"),
    },
    async (args) => {
      try {
        const id = resolveId(args.memory_id);
        const { rateMemory, getRatingsSummary } = await import("../../db/ratings.js");
        const rating = rateMemory(id, args.useful, args.agent_id, args.context);
        const summary = getRatingsSummary(id);
        return { content: [{ type: "text" as const, text: JSON.stringify({
          rated: rating.id.slice(0, 8),
          memory_id: id.slice(0, 8),
          useful: rating.useful,
          total_ratings: summary.total,
          usefulness_ratio: summary.usefulness_ratio.toFixed(2),
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_gdpr_erase",
    "GDPR right to be forgotten: erase all memories containing a PII identifier. Replaces content with [REDACTED], preserves anonymized audit trail. IRREVERSIBLE.",
    {
      identifier: z.string().describe("PII to search for and erase (name, email, etc.)"),
      project_id: z.string().optional(),
      dry_run: z.boolean().optional().describe("Preview what would be erased without actually erasing (default: false)"),
    },
    async (args) => {
      try {
        const { gdprErase } = await import("../../lib/gdpr.js");
        const result = gdprErase(args.identifier, { project_id: args.project_id, dry_run: args.dry_run });
        const action = args.dry_run ? "Would erase" : "Erased";
        return { content: [{ type: "text" as const, text: `${action} ${result.erased_count} memor${result.erased_count === 1 ? "y" : "ies"} containing "${args.identifier}".${args.dry_run ? " (dry run — no changes made)" : ""}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_acl_set",
    "Set an access control rule for an agent. Patterns use * for glob matching (e.g., 'architecture-*' matches all architecture keys).",
    {
      agent_id: z.string().describe("Agent ID to set ACL for"),
      key_pattern: z.string().describe("Key pattern (glob: * matches anything)"),
      permission: z.enum(["read", "readwrite", "admin"]).describe("Permission level"),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const { setAcl } = await import("../../db/acl.js");
        setAcl(args.agent_id, args.key_pattern, args.permission, args.project_id);
        return { content: [{ type: "text" as const, text: `ACL set: ${args.agent_id} → ${args.key_pattern} = ${args.permission}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_acl_list",
    "List access control rules for an agent.",
    {
      agent_id: z.string().describe("Agent ID to list ACLs for"),
    },
    async (args) => {
      try {
        const { listAcls } = await import("../../db/acl.js");
        const acls = listAcls(args.agent_id);
        if (acls.length === 0) {
          return { content: [{ type: "text" as const, text: `No ACLs set for agent ${args.agent_id} (full access by default)` }] };
        }
        const lines = acls.map((a) => `${a.key_pattern} → ${a.permission}`);
        return { content: [{ type: "text" as const, text: `ACLs for ${args.agent_id}:\n${lines.join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_evict",
    "Enforce memory bounds per scope. Archives lowest-utility memories (using decay score) when any scope exceeds its configured limit.",
    {
      project_id: z.string().optional().describe("Optional project ID to scope eviction to"),
    },
    async (args) => {
      try {
        const { enforceMemoryBounds } = await import("../../lib/retention.js");
        const result = enforceMemoryBounds(args.project_id);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_save_image",
    "Save an image memory. If OPENAI_API_KEY is set and image_url provided, auto-extracts a description via GPT-4o-mini vision. Saves with content_type='image'.",
    {
      key: z.string(),
      image_url: z.string().optional().describe("URL of the image to describe"),
      image_description: z.string().optional().describe("Manual description if no auto-extraction needed"),
      scope: z.enum(["global", "shared", "private", "working"]).optional(),
      category: z.enum(["preference", "fact", "knowledge", "history", "procedural", "resource"]).optional(),
      importance: z.coerce.number().min(1).max(10).optional(),
      tags: z.array(z.string()).optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      session_id: z.string().optional(),
    },
    async (args) => {
      try {
        ensureAutoProject();
        let description = args.image_description || "";

        if (args.image_url && process.env.OPENAI_API_KEY && !description) {
          try {
            const resp = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
              },
              body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [{
                  role: "user",
                  content: [
                    { type: "text", text: "Describe this image concisely for an AI agent's memory. Focus on what is shown, any text visible, and key details." },
                    { type: "image_url", image_url: { url: args.image_url } },
                  ],
                }],
                max_tokens: 300,
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (resp.ok) {
              const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
              description = data.choices?.[0]?.message?.content || "";
            }
          } catch {
          }
        }

        if (!description && args.image_url) {
          description = `Image at: ${args.image_url}`;
        }
        if (!description) {
          return { content: [{ type: "text" as const, text: "Error: Provide either image_url or image_description" }], isError: true };
        }

        const metadata: Record<string, unknown> = {};
        if (args.image_url) metadata.resource_uri = args.image_url;

        const memory = createMemory({
          key: args.key,
          value: description,
          scope: args.scope,
          category: args.category || "knowledge",
          importance: args.importance,
          tags: args.tags,
          agent_id: args.agent_id,
          project_id: args.project_id,
          session_id: args.session_id,
          metadata,
        });

        const db = getDatabase();
        db.run("UPDATE memories SET content_type = 'image' WHERE id = ?", [memory.id]);

        return { content: [{ type: "text" as const, text: JSON.stringify({
          saved: memory.key,
          id: memory.id.slice(0, 8),
          content_type: "image",
          has_vision_description: !!args.image_url && description !== `Image at: ${args.image_url}`,
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_compress",
    "Compress multiple memories into a single summary memory. Uses LLM if available, otherwise truncates.",
    {
      memory_ids: z.array(z.string()).describe("Memory IDs to compress"),
      max_length: z.coerce.number().optional().describe("Max chars for compression (default 500)"),
    },
    async (args) => {
      try {
        const maxLen = args.max_length || 500;
        const memories: Memory[] = [];
        for (const mid of args.memory_ids) {
          const id = resolveId(mid);
          const m = getMemory(id);
          if (m) memories.push(m);
        }

        if (memories.length === 0) {
          return { content: [{ type: "text" as const, text: "No valid memories found for the given IDs." }], isError: true };
        }

        const concatenated = memories.map((m) => `[${m.key}]: ${m.value}`).join("\n\n");

        let compressed: string;
        try {
          const { providerRegistry } = await import("../../lib/providers/registry.js");
          const provider = providerRegistry.getAvailable();
          if (provider) {
            const result = await provider.extractMemories(
              `Summarize these memories into a single concise paragraph (max ${maxLen} chars). Preserve key facts and decisions:\n\n${concatenated}`,
              {}
            );
            compressed = result?.[0]?.content || concatenated.slice(0, maxLen);
          } else {
            compressed = concatenated.slice(0, maxLen);
            if (concatenated.length > maxLen) compressed += "...";
          }
        } catch {
          compressed = concatenated.slice(0, maxLen);
          if (concatenated.length > maxLen) compressed += "...";
        }

        const timestamp = Date.now();
        const compressedMemory = createMemory({
          key: `compressed-${timestamp}`,
          value: compressed,
          category: "knowledge",
          scope: memories[0]!.scope,
          importance: Math.max(...memories.map((m) => m.importance)),
          tags: ["compressed"],
          agent_id: memories[0]!.agent_id || undefined,
          project_id: memories[0]!.project_id || undefined,
          metadata: {
            source_memory_ids: memories.map((m) => m.id),
            compression_ratio: concatenated.length > 0 ? (compressed.length / concatenated.length).toFixed(2) : "1.00",
          },
        } as CreateMemoryInput);

        return { content: [{ type: "text" as const, text: JSON.stringify({
          compressed_id: compressedMemory.id.slice(0, 8),
          key: compressedMemory.key,
          source_count: memories.length,
          original_length: concatenated.length,
          compressed_length: compressed.length,
        }) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
