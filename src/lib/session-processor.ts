/**
 * Session transcript processor.
 * Takes a full session transcript, chunks it, calls LLM to extract memories,
 * saves extracted memories tagged with session_id + source.
 * All failures are silently caught — never throws.
 */

import type { Database } from "bun:sqlite";
import { createMemory } from "../db/memories.js";
import { providerRegistry } from "./providers/registry.js";
import {
  updateSessionJob,
  getSessionJob,
  type SessionMemoryJob,
} from "../db/session-jobs.js";
import { extractToolLessons } from "./tool-lesson-extractor.js";
import { extractProcedures } from "./procedural-extractor.js";

// ============================================================================
// Types
// ============================================================================

export interface ChunkResult {
  chunkIndex: number;
  memoriesExtracted: number;
}

export interface ProcessingResult {
  jobId: string;
  chunksProcessed: number;
  memoriesExtracted: number;
  errors: string[];
}

// ============================================================================
// Prompts
// ============================================================================

const SESSION_EXTRACTION_USER_TEMPLATE = (chunk: string, sessionId: string) =>
  `Extract memories from this session chunk (session: ${sessionId}):\n\n${chunk}\n\nReturn JSON array: [{"key": "...", "value": "...", "category": "knowledge|fact|preference|history", "importance": 1-10, "tags": [...]}]`;

// ============================================================================
// Chunking
// ============================================================================

/**
 * Split a transcript into chunks with overlap.
 */
export function chunkTranscript(
  transcript: string,
  chunkSize = 2000,
  overlap = 200
): string[] {
  if (!transcript || transcript.length === 0) return [];
  if (transcript.length <= chunkSize) return [transcript];

  const chunks: string[] = [];
  let start = 0;

  while (start < transcript.length) {
    const end = Math.min(start + chunkSize, transcript.length);
    chunks.push(transcript.slice(start, end));
    if (end === transcript.length) break;
    start += chunkSize - overlap;
  }

  return chunks;
}

// ============================================================================
// Memory extraction
// ============================================================================

/**
 * Extract memories from a single chunk using the available LLM provider.
 * Returns the count of memories saved.
 */
export async function extractMemoriesFromChunk(
  chunk: string,
  context: {
    sessionId: string;
    agentId?: string;
    projectId?: string;
    source?: string;
  },
  db?: Database
): Promise<number> {
  const provider = providerRegistry.getAvailable();
  if (!provider) return 0;

  try {
    // Use the provider's raw LLM call via extractMemories which handles the prompt
    // We build a minimal context that uses our session-specific prompts
    const extracted = await provider.extractMemories(
      SESSION_EXTRACTION_USER_TEMPLATE(chunk, context.sessionId),
      {
        sessionId: context.sessionId,
        agentId: context.agentId,
        projectId: context.projectId,
      }
    );

    // Save whatever the provider extracted
    let savedCount = 0;
    const sourceTag = context.source ? `source:${context.source}` : "source:manual";

    for (const memory of extracted) {
      if (!memory.content || !memory.content.trim()) continue;
      try {
        createMemory(
          {
            key: memory.content.slice(0, 120).replace(/\s+/g, "-").toLowerCase(),
            value: memory.content,
            category: memory.category,
            scope: memory.suggestedScope ?? "shared",
            importance: memory.importance,
            tags: [
              ...memory.tags,
              "session-extracted",
              sourceTag,
              `session:${context.sessionId}`,
            ],
            source: "auto",
            agent_id: context.agentId,
            project_id: context.projectId,
            session_id: context.sessionId,
            metadata: {
              auto_extracted: true,
              session_source: context.source ?? "manual",
              extracted_at: new Date().toISOString(),
              reasoning: memory.reasoning,
            },
          },
          "merge",
          db
        );
        savedCount++;
      } catch {
        // Duplicate or constraint error — skip silently
      }
    }

    return savedCount;
  } catch {
    // Provider call failed — try a fallback approach with raw prompt
    try {
      // Try direct raw extraction via a fallback provider
      const fallbacks = providerRegistry.getFallbacks();
      for (const fallback of fallbacks) {
        try {
          const extracted = await fallback.extractMemories(
            SESSION_EXTRACTION_USER_TEMPLATE(chunk, context.sessionId),
            {
              sessionId: context.sessionId,
              agentId: context.agentId,
              projectId: context.projectId,
            }
          );

          let savedCount = 0;
          const sourceTag = context.source ? `source:${context.source}` : "source:manual";

          for (const memory of extracted) {
            if (!memory.content || !memory.content.trim()) continue;
            try {
              createMemory(
                {
                  key: memory.content.slice(0, 120).replace(/\s+/g, "-").toLowerCase(),
                  value: memory.content,
                  category: memory.category,
                  scope: memory.suggestedScope ?? "shared",
                  importance: memory.importance,
                  tags: [
                    ...memory.tags,
                    "session-extracted",
                    sourceTag,
                    `session:${context.sessionId}`,
                  ],
                  source: "auto",
                  agent_id: context.agentId,
                  project_id: context.projectId,
                  session_id: context.sessionId,
                  metadata: {
                    auto_extracted: true,
                    session_source: context.source ?? "manual",
                    extracted_at: new Date().toISOString(),
                    reasoning: memory.reasoning,
                  },
                },
                "merge",
                db
              );
              savedCount++;
            } catch {
              // Skip
            }
          }
          if (savedCount > 0) return savedCount;
        } catch {
          continue;
        }
      }
    } catch {
      // All providers failed
    }
    return 0;
  }
}

// ============================================================================
// Job processor
// ============================================================================

/**
 * Process a session memory job end-to-end.
 * Fetches the job, marks it processing, chunks transcript, extracts memories.
 * Updates job status to completed or failed.
 */
export async function processSessionJob(
  jobId: string,
  db?: Database
): Promise<ProcessingResult> {
  const result: ProcessingResult = {
    jobId,
    chunksProcessed: 0,
    memoriesExtracted: 0,
    errors: [],
  };

  let job: SessionMemoryJob | null;
  try {
    job = getSessionJob(jobId, db);
    if (!job) {
      result.errors.push(`Job not found: ${jobId}`);
      return result;
    }
  } catch (e) {
    result.errors.push(`Failed to fetch job: ${String(e)}`);
    return result;
  }

  // Mark as processing
  try {
    updateSessionJob(
      jobId,
      { status: "processing", started_at: new Date().toISOString() },
      db
    );
  } catch (e) {
    result.errors.push(`Failed to mark job as processing: ${String(e)}`);
    return result;
  }

  // Chunk the transcript
  const chunks = chunkTranscript(job.transcript);
  try {
    updateSessionJob(jobId, { chunk_count: chunks.length }, db);
  } catch {
    // Non-fatal
  }

  // Process each chunk
  let totalMemories = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    try {
      const count = await extractMemoriesFromChunk(
        chunk,
        {
          sessionId: job.session_id,
          agentId: job.agent_id ?? undefined,
          projectId: job.project_id ?? undefined,
          source: job.source,
        },
        db
      );
      totalMemories += count;
      result.chunksProcessed++;
    } catch (e) {
      result.errors.push(`Chunk ${i} failed: ${String(e)}`);
    }
  }

  result.memoriesExtracted = totalMemories;

  // Extract tool lessons from the full transcript (non-blocking — errors are silently caught)
  try {
    await extractToolLessons(job.transcript, {
      agent_id: job.agent_id ?? undefined,
      project_id: job.project_id ?? undefined,
      session_id: job.session_id,
    });
  } catch {
    // Tool lesson extraction is best-effort — never block job completion
  }

  // Extract procedural memories (workflows, step sequences, failure patterns)
  try {
    await extractProcedures(job.transcript, {
      agent_id: job.agent_id ?? undefined,
      project_id: job.project_id ?? undefined,
      session_id: job.session_id,
    });
  } catch {
    // Procedural extraction is best-effort — never block job completion
  }

  // Mark as completed or failed
  try {
    if (result.errors.length > 0 && result.chunksProcessed === 0) {
      updateSessionJob(
        jobId,
        {
          status: "failed",
          error: result.errors.join("; "),
          completed_at: new Date().toISOString(),
          memories_extracted: totalMemories,
          chunk_count: chunks.length,
        },
        db
      );
    } else {
      updateSessionJob(
        jobId,
        {
          status: "completed",
          completed_at: new Date().toISOString(),
          memories_extracted: totalMemories,
          chunk_count: chunks.length,
        },
        db
      );
    }
  } catch (e) {
    result.errors.push(`Failed to update job status: ${String(e)}`);
  }

  return result;
}
