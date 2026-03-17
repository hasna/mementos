/**
 * Hook registry — the central nervous system connecting all memory operations.
 *
 * Blocking hooks: await handler, return false = cancel the operation.
 * Non-blocking hooks: fire-and-forget in background, never delay caller.
 *
 * Hooks run in priority order (ascending — lower number first).
 * Per-agent and per-project scoping supported.
 */

import type {
  Hook,
  HookType,
  HookHandler,
  HookRegistration,
  HookContextMap,
} from "../types/hooks.js";

let _idCounter = 0;
function generateHookId(): string {
  return `hook_${++_idCounter}_${Date.now().toString(36)}`;
}

class HookRegistry {
  private hooks = new Map<string, Hook>();

  /**
   * Register a hook. Returns the assigned hookId.
   * Built-in hooks (builtin: true) cannot be unregistered.
   */
  register<T extends HookType>(reg: HookRegistration<T>): string {
    const id = generateHookId();
    const hook: Hook<T> = {
      ...reg,
      id,
      priority: reg.priority ?? 50,
    };
    this.hooks.set(id, hook as unknown as Hook);
    return id;
  }

  /**
   * Unregister a hook by ID.
   * Returns false if hook not found or is a built-in.
   */
  unregister(hookId: string): boolean {
    const hook = this.hooks.get(hookId);
    if (!hook) return false;
    if (hook.builtin) return false;
    this.hooks.delete(hookId);
    return true;
  }

  /** List all hooks, optionally filtered by type */
  list(type?: HookType): Hook[] {
    const all = [...this.hooks.values()];
    if (!type) return all;
    return all.filter((h) => h.type === type);
  }

  /**
   * Run all hooks of a given type for a given context.
   *
   * Returns true if the operation should proceed.
   * Returns false if any blocking hook cancelled it.
   *
   * Non-blocking hooks are fired async and never delay the return.
   */
  async runHooks<T extends HookType>(
    type: T,
    context: HookContextMap[T]
  ): Promise<boolean> {
    const matching = this.getMatchingHooks(type, context);
    if (matching.length === 0) return true;

    // Sort by priority ascending (lower = runs first)
    matching.sort((a, b) => a.priority - b.priority);

    for (const hook of matching) {
      if (hook.blocking) {
        // Blocking: await and check result
        try {
          const result = await (hook.handler as HookHandler)(context);
          if (result === false) return false; // cancelled
        } catch (err) {
          console.error(`[hooks] blocking hook ${hook.id} (${type}) threw:`, err);
          // Blocking hook errors don't cancel — log and continue
        }
      } else {
        // Non-blocking: fire and forget
        void Promise.resolve()
          .then(() => (hook.handler as HookHandler)(context))
          .catch((err) =>
            console.error(`[hooks] non-blocking hook ${hook.id} (${type}) threw:`, err)
          );
      }
    }

    return true;
  }

  /**
   * Get hooks matching type + agent/project scope.
   * A hook with no agentId/projectId matches everything.
   */
  private getMatchingHooks<T extends HookType>(
    type: T,
    context: HookContextMap[T]
  ): Hook[] {
    const ctx = context as { agentId?: string; projectId?: string };
    return [...this.hooks.values()].filter((hook) => {
      if (hook.type !== type) return false;
      if (hook.agentId && hook.agentId !== ctx.agentId) return false;
      if (hook.projectId && hook.projectId !== ctx.projectId) return false;
      return true;
    });
  }

  /** Get stats about registered hooks */
  stats(): { total: number; byType: Record<string, number>; blocking: number; nonBlocking: number } {
    const all = [...this.hooks.values()];
    const byType: Record<string, number> = {};
    for (const hook of all) {
      byType[hook.type] = (byType[hook.type] ?? 0) + 1;
    }
    return {
      total: all.length,
      byType,
      blocking: all.filter((h) => h.blocking).length,
      nonBlocking: all.filter((h) => !h.blocking).length,
    };
  }
}

/** Singleton — shared across the whole process */
export const hookRegistry = new HookRegistry();

// ─── Convenience re-export ────────────────────────────────────────────────────
export type { Hook, HookType, HookHandler, HookRegistration };
