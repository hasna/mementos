import { Database } from "bun:sqlite";
import { getDatabase, now } from "../../db/database.js";
import { getMemory } from "../../db/memories.js";
import {
  listProposals,
  updateProposal,
  type SynthesisProposal,
} from "../../db/synthesis.js";

// ============================================================================
// Types
// ============================================================================

export interface ExecutionResult {
  runId: string;
  executed: number;
  failed: number;
  rollbackData: Record<string, unknown>;
}

// ============================================================================
// Executor
// ============================================================================

export async function executeProposals(
  runId: string,
  proposals: SynthesisProposal[],
  db?: Database
): Promise<ExecutionResult> {
  const d = db || getDatabase();
  let executed = 0;
  let failed = 0;
  const rollbackData: Record<string, unknown> = {};

  for (const proposal of proposals) {
    try {
      const rollback = executeProposal(proposal, d);

      updateProposal(
        proposal.id,
        {
          status: "accepted",
          executed_at: now(),
          rollback_data: rollback,
        },
        d
      );

      rollbackData[proposal.id] = rollback;
      executed++;
    } catch (err) {
      // Partial failure is OK — mark failed and continue
      try {
        updateProposal(
          proposal.id,
          { status: "rejected" },
          d
        );
      } catch {
        // Best-effort status update
      }
      failed++;
    }
  }

  return { runId, executed, failed, rollbackData };
}

/**
 * Execute a single proposal inside a SQLite transaction.
 * Returns rollback_data for later reversal.
 */
function executeProposal(
  proposal: SynthesisProposal,
  d: Database
): Record<string, unknown> {
  let rollbackData: Record<string, unknown> = {};

  d.transaction(() => {
    switch (proposal.proposal_type) {
      case "archive":
        rollbackData = executeArchive(proposal, d);
        break;
      case "promote":
        rollbackData = executePromote(proposal, d);
        break;
      case "update_value":
        rollbackData = executeUpdateValue(proposal, d);
        break;
      case "add_tag":
        rollbackData = executeAddTag(proposal, d);
        break;
      case "merge":
        rollbackData = executeMerge(proposal, d);
        break;
      case "remove_duplicate":
        rollbackData = executeRemoveDuplicate(proposal, d);
        break;
      default:
        throw new Error(`Unknown proposal type: ${(proposal as SynthesisProposal).proposal_type}`);
    }
  })();

  return rollbackData;
}

// ============================================================================
// Individual proposal executors
// ============================================================================

function executeArchive(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  const rollback: Record<string, string> = {};

  for (const memId of proposal.memory_ids) {
    const mem = getMemory(memId, d);
    if (!mem) continue;
    rollback[memId] = mem.status;
    d.run("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?", [now(), memId]);
  }

  return { old_status: rollback };
}

function executePromote(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  const newImportance = proposal.proposed_changes["new_importance"];
  if (typeof newImportance !== "number") {
    throw new Error("promote proposal missing new_importance in proposed_changes");
  }

  const rollback: Record<string, number> = {};

  for (const memId of proposal.memory_ids) {
    const mem = getMemory(memId, d);
    if (!mem) continue;
    rollback[memId] = mem.importance;
    d.run(
      "UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?",
      [Math.max(1, Math.min(10, Math.round(newImportance))), now(), memId]
    );
  }

  return { old_importance: rollback };
}

function executeUpdateValue(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  const newValue = proposal.proposed_changes["new_value"];
  if (typeof newValue !== "string") {
    throw new Error("update_value proposal missing new_value in proposed_changes");
  }

  const rollback: Record<string, { value: string; version: number }> = {};
  const memId = proposal.memory_ids[0];
  if (!memId) throw new Error("update_value proposal has no memory_ids");

  const mem = getMemory(memId, d);
  if (!mem) throw new Error(`Memory ${memId} not found`);

  rollback[memId] = { value: mem.value, version: mem.version };

  d.run(
    "UPDATE memories SET value = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [newValue, now(), memId]
  );

  return { old_state: rollback };
}

function executeAddTag(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  const tagsToAdd = proposal.proposed_changes["tags"];
  if (!Array.isArray(tagsToAdd)) {
    throw new Error("add_tag proposal missing tags array in proposed_changes");
  }

  const rollback: Record<string, string[]> = {};

  for (const memId of proposal.memory_ids) {
    const mem = getMemory(memId, d);
    if (!mem) continue;

    rollback[memId] = [...mem.tags];

    const newTags = Array.from(new Set([...mem.tags, ...(tagsToAdd as string[])]));
    d.run(
      "UPDATE memories SET tags = ?, updated_at = ? WHERE id = ?",
      [JSON.stringify(newTags), now(), memId]
    );

    // Update memory_tags join table
    const insertTag = d.prepare(
      "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)"
    );
    for (const tag of tagsToAdd as string[]) {
      insertTag.run(memId, tag);
    }
  }

  return { old_tags: rollback };
}

function executeMerge(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  const targetId = proposal.target_memory_id;
  if (!targetId) throw new Error("merge proposal missing target_memory_id");

  const target = getMemory(targetId, d);
  if (!target) throw new Error(`Target memory ${targetId} not found`);

  const rollback: {
    target_old_value: string;
    target_old_version: number;
    archived_memories: Record<string, string>;
  } = {
    target_old_value: target.value,
    target_old_version: target.version,
    archived_memories: {},
  };

  // Collect values from source memories to merge into target
  const sourceValues: string[] = [];
  for (const memId of proposal.memory_ids) {
    if (memId === targetId) continue;
    const mem = getMemory(memId, d);
    if (!mem) continue;
    sourceValues.push(mem.value);
    rollback.archived_memories[memId] = mem.status;
  }

  // Build merged value
  const mergedValue = proposal.proposed_changes["merged_value"] as string | undefined
    ?? [target.value, ...sourceValues].join("\n---\n");

  // Update target with merged value
  d.run(
    "UPDATE memories SET value = ?, version = version + 1, updated_at = ? WHERE id = ?",
    [mergedValue, now(), targetId]
  );

  // Archive all source memories
  for (const memId of proposal.memory_ids) {
    if (memId === targetId) continue;
    d.run("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?", [now(), memId]);
  }

  return rollback;
}

function executeRemoveDuplicate(proposal: SynthesisProposal, d: Database): Record<string, unknown> {
  // Keep the highest-importance memory; archive the rest
  const memories = proposal.memory_ids
    .map((id) => getMemory(id, d))
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (memories.length < 2) {
    throw new Error("remove_duplicate requires at least 2 memories");
  }

  // Sort by importance desc; keep the first (highest importance)
  memories.sort((a, b) => b.importance - a.importance || a.created_at.localeCompare(b.created_at));

  const keepId = proposal.target_memory_id ?? memories[0]!.id;
  const rollback: Record<string, string> = {};

  for (const mem of memories) {
    if (mem.id === keepId) continue;
    rollback[mem.id] = mem.status;
    d.run("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?", [now(), mem.id]);
  }

  return { old_status: rollback, kept_id: keepId };
}

// ============================================================================
// Rollback
// ============================================================================

export async function rollbackRun(
  runId: string,
  db?: Database
): Promise<{ rolled_back: number; errors: string[] }> {
  const d = db || getDatabase();
  const proposals = listProposals(runId, { status: "accepted" }, d);
  let rolledBack = 0;
  const errors: string[] = [];

  for (const proposal of proposals) {
    try {
      rollbackProposal(proposal, d);
      updateProposal(proposal.id, { status: "rolled_back" }, d);
      rolledBack++;
    } catch (err) {
      errors.push(
        `Proposal ${proposal.id} (${proposal.proposal_type}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { rolled_back: rolledBack, errors };
}

function rollbackProposal(proposal: SynthesisProposal, d: Database): void {
  const rb = proposal.rollback_data;
  if (!rb) return;

  d.transaction(() => {
    switch (proposal.proposal_type) {
      case "archive":
      case "remove_duplicate": {
        const oldStatus = rb["old_status"] as Record<string, string> | undefined;
        if (!oldStatus) break;
        for (const [memId, status] of Object.entries(oldStatus)) {
          d.run("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", [status, now(), memId]);
        }
        break;
      }

      case "promote": {
        const oldImportance = rb["old_importance"] as Record<string, number> | undefined;
        if (!oldImportance) break;
        for (const [memId, importance] of Object.entries(oldImportance)) {
          d.run("UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?", [importance, now(), memId]);
        }
        break;
      }

      case "update_value": {
        const oldState = rb["old_state"] as Record<string, { value: string; version: number }> | undefined;
        if (!oldState) break;
        for (const [memId, state] of Object.entries(oldState)) {
          d.run(
            "UPDATE memories SET value = ?, version = ?, updated_at = ? WHERE id = ?",
            [state.value, state.version, now(), memId]
          );
        }
        break;
      }

      case "add_tag": {
        const oldTags = rb["old_tags"] as Record<string, string[]> | undefined;
        if (!oldTags) break;
        for (const [memId, tags] of Object.entries(oldTags)) {
          d.run("UPDATE memories SET tags = ?, updated_at = ? WHERE id = ?", [JSON.stringify(tags), now(), memId]);
          d.run("DELETE FROM memory_tags WHERE memory_id = ?", [memId]);
          const insertTag = d.prepare("INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)");
          for (const tag of tags) {
            insertTag.run(memId, tag);
          }
        }
        break;
      }

      case "merge": {
        const targetOldValue = rb["target_old_value"] as string | undefined;
        const targetOldVersion = rb["target_old_version"] as number | undefined;
        const archivedMemories = rb["archived_memories"] as Record<string, string> | undefined;
        const targetId = proposal.target_memory_id;

        if (targetId && targetOldValue !== undefined && targetOldVersion !== undefined) {
          d.run(
            "UPDATE memories SET value = ?, version = ?, updated_at = ? WHERE id = ?",
            [targetOldValue, targetOldVersion, now(), targetId]
          );
        }
        if (archivedMemories) {
          for (const [memId, status] of Object.entries(archivedMemories)) {
            d.run("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?", [status, now(), memId]);
          }
        }
        break;
      }

      default:
        break;
    }
  })();
}
