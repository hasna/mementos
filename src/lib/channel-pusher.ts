/**
 * Channel Pusher — pushes memory notifications into the Claude Code conversation
 * via the experimental claude/channel MCP notification protocol.
 *
 * Requires: --dangerously-load-development-channels server:mementos
 */

import type { Memory } from "../types/index.js";

// The MCP server reference — set from the MCP module
let _serverRef: any = null;

export function setServerRef(server: any): void {
  _serverRef = server;
}

export function hasChannelCapability(): boolean {
  return _serverRef !== null;
}

/**
 * Push a formatted memory notification into the conversation.
 */
export async function pushMemoryNotification(
  memories: Memory[],
  context: string,
  type: "auto-inject" | "session-briefing" | "alert" = "auto-inject"
): Promise<boolean> {
  if (!_serverRef) return false;
  if (memories.length === 0) return false;

  const formatted = formatMemories(memories, context, type);

  try {
    // The underlying Server (not McpServer) handles notifications
    // McpServer wraps it — access via .server property if needed
    const server = _serverRef.server || _serverRef;
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: formatted,
        meta: {
          source: "mementos",
          type,
          memory_count: memories.length,
          context: context.slice(0, 200),
        },
      },
    });
    return true;
  } catch (e) {
    // Channel not available (not launched with --dangerously-load-development-channels)
    return false;
  }
}

/**
 * Push raw text as a channel notification.
 */
export async function pushRawNotification(
  text: string,
  type: string = "info"
): Promise<boolean> {
  if (!_serverRef) return false;

  try {
    const server = _serverRef.server || _serverRef;
    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content: text,
        meta: { source: "mementos", type },
      },
    });
    return true;
  } catch {
    return false;
  }
}

function formatMemories(memories: Memory[], context: string, type: string): string {
  const header = type === "session-briefing"
    ? "📋 Mementos Session Briefing"
    : `⚡ Mementos activated (${context.slice(0, 100)})`;

  const lines = memories.map(m => {
    const importance = m.importance >= 8 ? "❗" : "";
    const flag = m.flag ? ` ⚠️ ${m.flag}` : "";
    return `• [${m.category}] ${m.key}: ${m.value.slice(0, 200)}${m.value.length > 200 ? "..." : ""} (importance: ${m.importance})${importance}${flag}`;
  });

  const footer = memories.length > 3
    ? `\nUse memory_recall(key="...") for full details on any of these.`
    : "";

  return `${header}\n\n${lines.join("\n")}${footer}`;
}

// ============================================================================
// Targeted push functions
// ============================================================================

import { getSessionByAgent, getSessionsByProject } from "./session-registry.js";

/**
 * Push to a specific agent by name.
 * Finds their session PID and pushes if they have mementos MCP loaded.
 */
export async function pushToAgent(agentName: string, content: string, type: string = "targeted"): Promise<boolean> {
  // For now, we can only push to our OWN session (same process).
  // Cross-session push requires a broker (future work).
  // But we CAN check if the target agent is in our session.
  const session = getSessionByAgent(agentName);
  if (!session || session.pid !== process.pid) return false;
  return pushRawNotification(content, type);
}

/**
 * Push to all sessions in a project.
 * Returns count of sessions pushed to.
 */
export async function pushToProject(projectName: string, content: string, type: string = "broadcast"): Promise<number> {
  // Same limitation — can only push to own session for now
  const sessions = getSessionsByProject(projectName);
  let count = 0;
  for (const s of sessions) {
    if (s.pid === process.pid) {
      const ok = await pushRawNotification(content, type);
      if (ok) count++;
    }
  }
  return count;
}

/**
 * Push to all known sessions.
 */
export async function pushToAll(content: string, type: string = "broadcast"): Promise<number> {
  // Can only push to own session currently
  const ok = await pushRawNotification(content, type);
  return ok ? 1 : 0;
}

export function formatBriefing(sections: {
  profile?: string;
  memories?: Memory[];
  lastSession?: string;
  flagged?: Memory[];
  projectName?: string;
}): string {
  const parts: string[] = [];

  parts.push(`📋 Mementos Session Briefing${sections.projectName ? ` — project: ${sections.projectName}` : ""}`);

  if (sections.profile) {
    parts.push(`\n## Profile\n${sections.profile}`);
  }

  if (sections.memories && sections.memories.length > 0) {
    parts.push(`\n## Key Memories (${sections.memories.length})`);
    for (const m of sections.memories) {
      parts.push(`• [${m.category}] ${m.key}: ${m.value.slice(0, 150)}${m.value.length > 150 ? "..." : ""}`);
    }
  }

  if (sections.lastSession) {
    parts.push(`\n## Last Session\n${sections.lastSession}`);
  }

  if (sections.flagged && sections.flagged.length > 0) {
    parts.push(`\n## Needs Attention`);
    for (const m of sections.flagged) {
      parts.push(`⚠️ [${m.flag}] ${m.key}: ${m.value.slice(0, 150)}`);
    }
  }

  parts.push(`\nUse memory_recall, memory_search, or memory_inject for more details.`);

  return parts.join("\n");
}
