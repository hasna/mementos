/**
 * Mementos Export v1 — portable JSONL format.
 * One JSON object per line. Includes all memory fields + entity links.
 */

import type { Memory, MemoryFilter } from "../types/index.js";
import { listMemories } from "../db/memories.js";
import { getEntityMemoryLinks } from "../db/entity-memories.js";
import { getEntity } from "../db/entities.js";
import { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";

export interface ExportV1Entry {
  _format: "mementos-export-v1";
  _exported_at: string;
  memory: Memory;
  entity_links: Array<{
    entity_name: string;
    entity_type: string;
    role: string;
  }>;
}

/**
 * Export memories in mementos-export-v1 JSONL format.
 * Returns an array of export entries (caller serializes to JSONL).
 */
export function exportV1(
  filter?: MemoryFilter,
  db?: Database
): ExportV1Entry[] {
  const d = db || getDatabase();
  const memories = listMemories(filter, d);
  const exportedAt = new Date().toISOString();

  return memories.map((memory) => {
    // Get entity links for this memory
    let entityLinks: ExportV1Entry["entity_links"] = [];
    try {
      const links = getEntityMemoryLinks(undefined, memory.id, d);
      entityLinks = links.map((link) => {
        const entity = getEntity(link.entity_id, d);
        return {
          entity_name: entity?.name ?? "unknown",
          entity_type: entity?.type ?? "unknown",
          role: link.role,
        };
      });
    } catch {
      // Entity tables may not exist
    }

    return {
      _format: "mementos-export-v1" as const,
      _exported_at: exportedAt,
      memory,
      entity_links: entityLinks,
    };
  });
}

/**
 * Serialize export entries to JSONL string (one JSON object per line).
 */
export function toJsonl(entries: ExportV1Entry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

/**
 * Parse JSONL string back to export entries.
 */
export function fromJsonl(jsonl: string): ExportV1Entry[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ExportV1Entry);
}
