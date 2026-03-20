/**
 * Memory broadcast utility — notifies active agents when shared memories are saved.
 * Uses the conversations MCP service if available.
 * Non-blocking: failures are silently ignored.
 */

import type { Memory } from '../types/index.js';

const CONVERSATIONS_API = process.env.CONVERSATIONS_API_URL || 'http://localhost:7020';

/**
 * Broadcast a newly saved shared memory to all active agents on the project
 * via the conversations MCP send_message endpoint.
 */
export async function broadcastSharedMemory(memory: Memory, savingAgentId: string): Promise<void> {
  if (!memory.project_id) return;

  try {
    const listRes = await fetch(`${CONVERSATIONS_API}/api/v1/agents?active=true&project_id=${memory.project_id}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!listRes.ok) return;

    const { agents } = await listRes.json() as { agents?: Array<{ id: string; name: string }> };
    if (!agents?.length) return;

    const otherAgents = agents.filter(a => a.id !== savingAgentId);
    if (!otherAgents.length) return;

    const notification = `[Memory Update] Agent ${savingAgentId} saved shared memory: "${memory.key}" — ${memory.summary || memory.value.slice(0, 100)}. Consider recalling this memory if relevant to your current task.`;

    await Promise.all(otherAgents.map(agent =>
      fetch(`${CONVERSATIONS_API}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: savingAgentId, to: agent.id, content: notification }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {/* ignore send failures */})
    ));
  } catch {
    // Conversations service unavailable — fail silently
  }
}
