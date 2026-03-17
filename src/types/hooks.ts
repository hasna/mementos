/**
 * Hook system types for open-mementos lifecycle events.
 *
 * Blocking hooks: handler returns false → operation is cancelled.
 * Non-blocking hooks: fire-and-forget, never delay the caller.
 */

import type { Memory, CreateMemoryInput, UpdateMemoryInput } from "./index.js";

// ─── Hook lifecycle points ────────────────────────────────────────────────────

export type HookType =
  // Memory lifecycle
  | "PreMemorySave"
  | "PostMemorySave"
  | "PreMemoryUpdate"
  | "PostMemoryUpdate"
  | "PreMemoryDelete"
  | "PostMemoryDelete"
  // Entity lifecycle
  | "PreEntityCreate"
  | "PostEntityCreate"
  | "PreRelationCreate"
  | "PostRelationCreate"
  // Session lifecycle
  | "OnSessionStart"
  | "OnSessionEnd"
  // Injection lifecycle
  | "PreMemoryInject"
  | "PostMemoryInject";

// ─── Hook contexts ────────────────────────────────────────────────────────────

export interface BaseHookContext {
  agentId?: string;
  projectId?: string;
  sessionId?: string;
  timestamp: number;
}

export interface PreMemorySaveContext extends BaseHookContext {
  input: CreateMemoryInput;
}

export interface PostMemorySaveContext extends BaseHookContext {
  memory: Memory;
  wasUpdated: boolean; // true if upsert merged with existing
}

export interface PreMemoryUpdateContext extends BaseHookContext {
  memoryId: string;
  input: UpdateMemoryInput;
  existing: Memory;
}

export interface PostMemoryUpdateContext extends BaseHookContext {
  memory: Memory;
  previousValue: string;
}

export interface PreMemoryDeleteContext extends BaseHookContext {
  memoryId: string;
  memory: Memory;
}

export interface PostMemoryDeleteContext extends BaseHookContext {
  memoryId: string;
}

export interface PreEntityCreateContext extends BaseHookContext {
  name: string;
  entityType: string;
}

export interface PostEntityCreateContext extends BaseHookContext {
  entityId: string;
  name: string;
  entityType: string;
}

export interface PreRelationCreateContext extends BaseHookContext {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
}

export interface PostRelationCreateContext extends BaseHookContext {
  relationId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
}

export interface OnSessionStartContext extends BaseHookContext {
  agentId: string;
  projectId?: string;
}

export interface OnSessionEndContext extends BaseHookContext {
  agentId: string;
  projectId?: string;
  /** Optional session summary for memory extraction */
  summary?: string;
}

export interface PreMemoryInjectContext extends BaseHookContext {
  /** Memories about to be injected — hook can mutate this array */
  memories: Memory[];
  format: string;
}

export interface PostMemoryInjectContext extends BaseHookContext {
  memoriesCount: number;
  format: string;
  contextLength: number;
}

/** Union of all hook contexts keyed by type */
export type HookContextMap = {
  PreMemorySave: PreMemorySaveContext;
  PostMemorySave: PostMemorySaveContext;
  PreMemoryUpdate: PreMemoryUpdateContext;
  PostMemoryUpdate: PostMemoryUpdateContext;
  PreMemoryDelete: PreMemoryDeleteContext;
  PostMemoryDelete: PostMemoryDeleteContext;
  PreEntityCreate: PreEntityCreateContext;
  PostEntityCreate: PostEntityCreateContext;
  PreRelationCreate: PreRelationCreateContext;
  PostRelationCreate: PostRelationCreateContext;
  OnSessionStart: OnSessionStartContext;
  OnSessionEnd: OnSessionEndContext;
  PreMemoryInject: PreMemoryInjectContext;
  PostMemoryInject: PostMemoryInjectContext;
};

// ─── Hook handler ─────────────────────────────────────────────────────────────

/**
 * Blocking hook: return false to cancel the operation.
 * Non-blocking hook: return value is ignored.
 */
export type HookHandler<T extends HookType = HookType> = (
  context: HookContextMap[T]
) => Promise<boolean | void>;

// ─── Hook registration ────────────────────────────────────────────────────────

export interface Hook<T extends HookType = HookType> {
  id: string;
  type: T;
  handler: HookHandler<T>;
  /** Lower number = runs first. Default: 50 */
  priority: number;
  /**
   * If true: operation waits for handler result. Return false = cancel.
   * If false: runs async in background, return value ignored.
   */
  blocking: boolean;
  /** Scope: only fire for this agent (undefined = all agents) */
  agentId?: string;
  /** Scope: only fire for this project (undefined = all projects) */
  projectId?: string;
  /** Human-readable description */
  description?: string;
  /** Whether this is a built-in system hook (can't be unregistered) */
  builtin?: boolean;
}

export type HookRegistration<T extends HookType = HookType> = Omit<Hook<T>, "id">;

// ─── Webhook (HTTP-based hook for persistence) ────────────────────────────────

export interface WebhookHook {
  id: string;
  type: HookType;
  /** HTTP endpoint to POST the context to */
  handlerUrl: string;
  priority: number;
  blocking: boolean;
  agentId?: string;
  projectId?: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  invocationCount: number;
  failureCount: number;
}
