/**
 * Session Start Briefing — pushes a project memory briefing when a new session begins.
 * Includes: synthesized profile, top memories, last session summary, flagged items.
 */

import { listMemories } from "../db/memories.js";
import { pushRawNotification, formatBriefing } from "./channel-pusher.js";
import { visibleToMachineFilter } from "./machine-visibility.js";
import type { Memory } from "../types/index.js";

export async function pushSessionBriefing(options: {
  project_id?: string;
  project_name?: string;
  agent_id?: string;
}): Promise<boolean> {
  // Skip if no project context
  if (!options.project_id) return false;

  try {
    const machineFilter = visibleToMachineFilter();

    // 1. Load synthesized profile (if available)
    let profile: string | null = null;
    try {
      const { synthesizeProfile } = await import("./profile-synthesizer.js");
      const result = await synthesizeProfile({
        project_id: options.project_id,
        scope: "project",
      });
      if (result) profile = result.profile;
    } catch {
      // Profile not available
    }

    // 2. Load top project memories (pinned first, then by importance)
    const pinnedMemories = listMemories({
      project_id: options.project_id,
      pinned: true,
      status: "active",
      ...machineFilter,
      limit: 5,
    });

    const topMemories = listMemories({
      project_id: options.project_id,
      status: "active",
      min_importance: 7,
      ...machineFilter,
      limit: 10,
    });

    // Merge and dedup (pinned first)
    const seenIds = new Set<string>();
    const memories: Memory[] = [];
    for (const m of [...pinnedMemories, ...topMemories]) {
      if (!seenIds.has(m.id) && !m.key.startsWith("_profile_")) {
        seenIds.add(m.id);
        memories.push(m);
        if (memories.length >= 10) break;
      }
    }

    // 3. Load last session summary
    let lastSession: string | null = null;
    try {
      const sessionMemories = listMemories({
        project_id: options.project_id,
        category: "history",
        status: "active",
        ...machineFilter,
        limit: 5,
      });
      const summary = sessionMemories.find(m => m.key.includes("summary"));
      if (summary) lastSession = summary.value;
    } catch {
      // No session summary available
    }

    // 4. Load flagged memories
    const allMemories = listMemories({
      project_id: options.project_id,
      status: "active",
      ...machineFilter,
      limit: 100,
    });
    const flagged = allMemories.filter(m => m.flag && m.flag !== "");

    // 5. Skip if nothing to show
    if (!profile && memories.length === 0 && !lastSession && flagged.length === 0) {
      return false;
    }

    // 6. Format and push
    const briefingText = formatBriefing({
      profile: profile || undefined,
      memories: memories.length > 0 ? memories : undefined,
      lastSession: lastSession || undefined,
      flagged: flagged.length > 0 ? flagged : undefined,
      projectName: options.project_name,
    });

    return await pushRawNotification(briefingText, "session-briefing");
  } catch {
    return false;
  }
}
