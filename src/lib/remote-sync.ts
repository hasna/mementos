/**
 * Remote sync — push/pull memories to/from a remote mementos-serve instance.
 *
 * The remote must be running `mementos-serve`. Point at it via:
 *   MEMENTOS_REMOTE_URL=http://apple01:19428
 * or pass the URL directly to push/pull functions.
 */

import { createMemory, listMemories } from "../db/memories.js";
import type { Memory, CreateMemoryInput } from "../types/index.js";

const DEFAULT_PORT = 19428;

export interface RemoteSyncOptions {
  remoteUrl?: string;
  scope?: "global" | "shared" | "private" | "working";
  agentId?: string;
  projectId?: string;
  since?: string;
  limit?: number;
  overwrite?: boolean;
}

export interface RemoteSyncResult {
  pushed?: number;
  pulled?: number;
  errors: string[];
  remote_url: string;
}

function resolveUrl(url?: string): string {
  const raw = url ?? process.env["MEMENTOS_REMOTE_URL"] ?? "";
  if (!raw) throw new Error("No remote URL. Set MEMENTOS_REMOTE_URL or pass url.");
  return raw.replace(/\/$/, "");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Remote ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Push local memories to a remote mementos-serve instance.
 * Uses POST /api/memories/import on the remote.
 */
export async function pushToRemote(opts: RemoteSyncOptions = {}): Promise<RemoteSyncResult> {
  const baseUrl = resolveUrl(opts.remoteUrl);
  const errors: string[] = [];

  const memories = listMemories({
    scope: opts.scope,
    agent_id: opts.agentId,
    project_id: opts.projectId,
    limit: opts.limit ?? 10000,
  });

  if (!memories.length) {
    return { pushed: 0, errors: [], remote_url: baseUrl };
  }

  const result = await fetchJson<{ imported: number; errors: string[]; total: number }>(
    `${baseUrl}/api/memories/import`,
    {
      method: "POST",
      body: JSON.stringify({ memories, overwrite: opts.overwrite ?? true }),
    }
  );

  return {
    pushed: result.imported,
    errors: [...errors, ...result.errors],
    remote_url: baseUrl,
  };
}

/**
 * Pull memories from a remote mementos-serve instance into local DB.
 * Uses POST /api/memories/export on the remote.
 */
export async function pullFromRemote(opts: RemoteSyncOptions = {}): Promise<RemoteSyncResult> {
  const baseUrl = resolveUrl(opts.remoteUrl);
  const errors: string[] = [];

  const filter: Record<string, unknown> = { limit: opts.limit ?? 10000 };
  if (opts.scope) filter.scope = opts.scope;
  if (opts.agentId) filter.agent_id = opts.agentId;
  if (opts.projectId) filter.project_id = opts.projectId;

  const result = await fetchJson<{ memories: Memory[]; count: number }>(
    `${baseUrl}/api/memories/export`,
    { method: "POST", body: JSON.stringify(filter) }
  );

  let pulled = 0;
  for (const mem of result.memories) {
    try {
      createMemory(mem as unknown as CreateMemoryInput, opts.overwrite !== false ? "merge" : "create");
      pulled++;
    } catch (e) {
      errors.push(`Failed to import "${mem.key}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { pulled, errors, remote_url: baseUrl };
}

/**
 * Bidirectional sync: push local then pull remote.
 * On key conflict, newer timestamp wins.
 */
export async function syncWithRemote(opts: RemoteSyncOptions = {}): Promise<RemoteSyncResult> {
  const baseUrl = resolveUrl(opts.remoteUrl);
  const pushResult = await pushToRemote({ ...opts, remoteUrl: baseUrl });
  const pullResult = await pullFromRemote({ ...opts, remoteUrl: baseUrl, overwrite: false });
  return {
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    errors: [...pushResult.errors, ...pullResult.errors],
    remote_url: baseUrl,
  };
}

/**
 * Check if a remote mementos-serve is reachable.
 */
export async function pingRemote(url?: string): Promise<{ ok: boolean; url: string; status?: number; error?: string }> {
  const baseUrl = resolveUrl(url);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return { ok: res.ok, url: baseUrl, status: res.status };
  } catch (e) {
    return { ok: false, url: baseUrl, error: e instanceof Error ? e.message : String(e) };
  }
}

export { DEFAULT_PORT };
