import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createSessionJob, getSessionJob, listSessionJobs } from "../../db/session-jobs.js";
import { enqueueSessionJob } from "../../lib/session-queue.js";
import {
  createMemory,
} from "../../db/memories.js";
import type { MemoryCategory, CreateMemoryInput } from "../../types/index.js";

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "memory_ingest_session",
    "Submit a session transcript for async memory extraction. Returns job_id to track progress.",
    {
      transcript: z.string(),
      session_id: z.string(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      source: z.enum(["claude-code", "codex", "manual", "open-sessions"]).optional(),
    },
    async (args) => {
      try {
        const job = createSessionJob({
          session_id: args.session_id,
          transcript: args.transcript,
          source: args.source ?? "manual",
          agent_id: args.agent_id,
          project_id: args.project_id,
        });
        enqueueSessionJob(job.id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ job_id: job.id, status: "queued" }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_session_status",
    "Get the status of a session memory extraction job.",
    { job_id: z.string() },
    async (args) => {
      try {
        const job = getSessionJob(args.job_id);
        if (!job) return { content: [{ type: "text" as const, text: `Job not found: ${args.job_id}` }], isError: true };
        return { content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "memory_session_list",
    "List session memory extraction jobs.",
    {
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
      status: z.enum(["pending", "processing", "completed", "failed"]).optional(),
      limit: z.coerce.number().optional(),
    },
    async (args) => {
      try {
        const jobs = listSessionJobs({ agent_id: args.agent_id, project_id: args.project_id, status: args.status, limit: args.limit ?? 20 });
        return { content: [{ type: "text" as const, text: JSON.stringify(jobs, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );

  server.tool(
    "session_extract",
    "Extract memories from a session summary. Auto-creates structured memories from title, topics, notes.",
    {
      session_id: z.string(),
      title: z.string().optional(),
      project: z.string().optional(),
      model: z.string().optional(),
      messages: z.coerce.number().optional(),
      key_topics: z.array(z.string()).optional(),
      summary: z.string().optional(),
      agent_id: z.string().optional(),
      project_id: z.string().optional(),
    },
    async (args) => {
      try {
        const { session_id, title, project, model, messages, key_topics, summary, agent_id, project_id } = args;
        const created: string[] = [];

        function saveExtracted(key: string, value: string, category: MemoryCategory, importance: number): void {
          try {
            const mem = createMemory({
              key, value, category, scope: "shared", importance,
              source: "auto", agent_id, project_id, session_id,
            } as CreateMemoryInput);
            created.push(`${key} (${mem.id.slice(0, 8)})`);
          } catch {
            // duplicate — skip
          }
        }

        if (title) {
          saveExtracted(`session-${session_id}-title`, title, "history", 5);
        }
        if (project) {
          saveExtracted(`session-${session_id}-project`, project, "fact", 6);
        }
        if (model) {
          saveExtracted(`session-${session_id}-model`, model, "fact", 4);
        }
        if (messages !== undefined) {
          saveExtracted(`session-${session_id}-messages`, String(messages), "history", 4);
        }
        if (key_topics && key_topics.length > 0) {
          for (const topic of key_topics) {
            const topicKey = `topic-${topic.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;
            saveExtracted(topicKey, `Session ${session_id}: ${title || ""}`, "knowledge", 6);
          }
        }
        if (summary) {
          saveExtracted(`session-${session_id}-summary`, summary, "history", 7);
        }

        return {
          content: [{
            type: "text" as const,
            text: created.length > 0
              ? `Extracted ${created.length} memor${created.length === 1 ? "y" : "ies"} from session ${session_id}:\n${created.join("\n")}`
              : `No new memories extracted from session ${session_id} (all already exist).`,
          }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: formatError(e) }], isError: true };
      }
    }
  );
}
