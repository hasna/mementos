/**
 * Hooks system tests.
 * Tests: HookRegistry, WebhookHooks DB layer, integration with entity/relation/session lifecycle.
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { getDatabase, resetDatabase } from "../db/database.js";
import { hookRegistry } from "./hooks.js";
import type { HookRegistration, HookType } from "../types/hooks.js";
import {
  createWebhookHook,
  getWebhookHook,
  listWebhookHooks,
  updateWebhookHook,
  deleteWebhookHook,
  recordWebhookInvocation,
} from "../db/webhook_hooks.js";
import { createEntity } from "../db/entities.js";
import { createRelation } from "../db/relations.js";
import { setFocus, unfocus } from "./focus.js";
import { registerAgent } from "../db/agents.js";
import { registerProject } from "../db/projects.js";

// ─── Test DB helpers ─────────────────────────────────────────────────────────

let testDb: Database;

function freshDb(): Database {
  resetDatabase();
  testDb = getDatabase(":memory:");
  return testDb;
}

// ============================================================================
// HookRegistry
// ============================================================================

describe("HookRegistry", () => {
  test("register and list hooks", () => {
    const handler = mock(async () => {});
    const id = hookRegistry.register({
      type: "PostMemorySave",
      blocking: false,
      handler,
    });

    expect(id).toMatch(/^hook_/);

    const all = hookRegistry.list("PostMemorySave");
    const found = all.find((h) => h.id === id);
    expect(found).toBeDefined();
    expect(found!.type).toBe("PostMemorySave");
    expect(found!.blocking).toBe(false);

    // Clean up
    hookRegistry.unregister(id);
  });

  test("default priority is 50", () => {
    const id = hookRegistry.register({
      type: "PostMemoryDelete",
      blocking: false,
      handler: async () => {},
    });
    const h = hookRegistry.list("PostMemoryDelete").find((h) => h.id === id)!;
    expect(h.priority).toBe(50);
    hookRegistry.unregister(id);
  });

  test("unregister removes hook", () => {
    const id = hookRegistry.register({
      type: "PreMemorySave",
      blocking: false,
      handler: async () => {},
    });
    expect(hookRegistry.list("PreMemorySave").find((h) => h.id === id)).toBeDefined();
    const removed = hookRegistry.unregister(id);
    expect(removed).toBe(true);
    expect(hookRegistry.list("PreMemorySave").find((h) => h.id === id)).toBeUndefined();
  });

  test("cannot unregister builtin hooks", () => {
    const id = hookRegistry.register({
      type: "PostEntityCreate",
      blocking: false,
      builtin: true,
      handler: async () => {},
    });
    const removed = hookRegistry.unregister(id);
    expect(removed).toBe(false);
    // Clean up by not trying (it's immovable — just note it's there)
  });

  test("runHooks returns true when no hooks", async () => {
    const result = await hookRegistry.runHooks("OnSessionEnd", {
      agentId: "test-agent",
      timestamp: Date.now(),
    });
    expect(result).toBe(true);
  });

  test("blocking hook can cancel operation", async () => {
    const id = hookRegistry.register({
      type: "PreMemorySave",
      blocking: true,
      priority: 1,
      handler: async () => false, // cancel
    });

    const result = await hookRegistry.runHooks("PreMemorySave", {
      input: { key: "test", value: "test", category: "knowledge", scope: "global" },
      agentId: "agent-x",
      timestamp: Date.now(),
    });

    expect(result).toBe(false);
    hookRegistry.unregister(id);
  });

  test("non-blocking hook return value ignored", async () => {
    const calls: number[] = [];
    const id = hookRegistry.register({
      type: "PostMemoryUpdate",
      blocking: false,
      handler: async () => {
        calls.push(1);
        return false as unknown as void; // return false but should not cancel
      },
    });

    const result = await hookRegistry.runHooks("PostMemoryUpdate", {
      memory: {} as never,
      previousValue: "old",
      timestamp: Date.now(),
    });

    // Non-blocking hooks don't affect result
    expect(result).toBe(true);
    hookRegistry.unregister(id);
  });

  test("hooks run in priority order ascending", async () => {
    const order: number[] = [];
    const id1 = hookRegistry.register({
      type: "PreMemoryDelete",
      blocking: true,
      priority: 30,
      handler: async () => { order.push(30); },
    });
    const id2 = hookRegistry.register({
      type: "PreMemoryDelete",
      blocking: true,
      priority: 10,
      handler: async () => { order.push(10); },
    });
    const id3 = hookRegistry.register({
      type: "PreMemoryDelete",
      blocking: true,
      priority: 20,
      handler: async () => { order.push(20); },
    });

    await hookRegistry.runHooks("PreMemoryDelete", {
      memoryId: "m1",
      memory: {} as never,
      timestamp: Date.now(),
    });

    expect(order).toEqual([10, 20, 30]);

    hookRegistry.unregister(id1);
    hookRegistry.unregister(id2);
    hookRegistry.unregister(id3);
  });

  test("stats counts hooks by type", () => {
    const ids: string[] = [];
    ids.push(hookRegistry.register({ type: "PostEntityCreate", blocking: false, handler: async () => {} }));
    ids.push(hookRegistry.register({ type: "PostEntityCreate", blocking: true, handler: async () => {} }));

    const stats = hookRegistry.stats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.byType["PostEntityCreate"]).toBeGreaterThanOrEqual(2);

    for (const id of ids) hookRegistry.unregister(id);
  });

  test("agent-scoped hooks only fire for matching agent", async () => {
    const calls: string[] = [];
    const id = hookRegistry.register({
      type: "PostMemorySave",
      blocking: true,
      agentId: "agent-alice",
      handler: async () => { calls.push("alice-hook"); },
    });

    // This should fire (matching agent)
    await hookRegistry.runHooks("PostMemorySave", {
      memory: {} as never,
      wasUpdated: false,
      agentId: "agent-alice",
      timestamp: Date.now(),
    });

    // This should not fire (different agent)
    await hookRegistry.runHooks("PostMemorySave", {
      memory: {} as never,
      wasUpdated: false,
      agentId: "agent-bob",
      timestamp: Date.now(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("alice-hook");
    hookRegistry.unregister(id);
  });
});

// ============================================================================
// WebhookHooks DB layer
// ============================================================================

describe("WebhookHooks DB", () => {
  beforeEach(() => freshDb());

  test("create and retrieve webhook", () => {
    const wh = createWebhookHook({
      type: "PostMemorySave",
      handlerUrl: "https://example.com/hook",
      priority: 50,
    }, testDb);

    expect(wh.id).toBeDefined();
    expect(wh.type).toBe("PostMemorySave");
    expect(wh.handlerUrl).toBe("https://example.com/hook");
    expect(wh.enabled).toBe(true);
    expect(wh.invocationCount).toBe(0);
    expect(wh.failureCount).toBe(0);

    const fetched = getWebhookHook(wh.id, testDb);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(wh.id);
  });

  test("list webhooks with type filter", () => {
    createWebhookHook({ type: "PostMemorySave", handlerUrl: "https://a.com/1" }, testDb);
    createWebhookHook({ type: "PostMemorySave", handlerUrl: "https://a.com/2" }, testDb);
    createWebhookHook({ type: "OnSessionStart", handlerUrl: "https://b.com/1" }, testDb);

    const memoryHooks = listWebhookHooks({ type: "PostMemorySave" }, testDb);
    expect(memoryHooks).toHaveLength(2);

    const sessionHooks = listWebhookHooks({ type: "OnSessionStart" }, testDb);
    expect(sessionHooks).toHaveLength(1);
  });

  test("list webhooks with enabled filter", () => {
    const wh1 = createWebhookHook({ type: "PostMemorySave", handlerUrl: "https://a.com" }, testDb);
    const wh2 = createWebhookHook({ type: "PostMemorySave", handlerUrl: "https://b.com" }, testDb);
    updateWebhookHook(wh2.id, { enabled: false }, testDb);

    const enabled = listWebhookHooks({ enabled: true }, testDb);
    expect(enabled.some((w) => w.id === wh1.id)).toBe(true);
    expect(enabled.some((w) => w.id === wh2.id)).toBe(false);

    const disabled = listWebhookHooks({ enabled: false }, testDb);
    expect(disabled.some((w) => w.id === wh2.id)).toBe(true);
  });

  test("update webhook fields", () => {
    const wh = createWebhookHook({ type: "OnSessionEnd", handlerUrl: "https://x.com" }, testDb);

    const updated = updateWebhookHook(wh.id, { enabled: false, priority: 10, description: "test hook" }, testDb);
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
    expect(updated!.priority).toBe(10);
    expect(updated!.description).toBe("test hook");
  });

  test("delete webhook", () => {
    const wh = createWebhookHook({ type: "PostEntityCreate", handlerUrl: "https://z.com" }, testDb);
    expect(getWebhookHook(wh.id, testDb)).not.toBeNull();

    const deleted = deleteWebhookHook(wh.id, testDb);
    expect(deleted).toBe(true);
    expect(getWebhookHook(wh.id, testDb)).toBeNull();
  });

  test("delete non-existent webhook returns false", () => {
    const deleted = deleteWebhookHook("no-such-id", testDb);
    expect(deleted).toBe(false);
  });

  test("recordWebhookInvocation increments counters", () => {
    const wh = createWebhookHook({ type: "PostRelationCreate", handlerUrl: "https://r.com" }, testDb);

    recordWebhookInvocation(wh.id, true, testDb);
    recordWebhookInvocation(wh.id, true, testDb);
    recordWebhookInvocation(wh.id, false, testDb); // failure

    const updated = getWebhookHook(wh.id, testDb)!;
    expect(updated.invocationCount).toBe(3);
    expect(updated.failureCount).toBe(1);
  });
});

// ============================================================================
// Integration: entity/relation hooks
// ============================================================================

describe("Entity/Relation hook integration", () => {
  beforeEach(() => freshDb());

  test("PostEntityCreate fires when entity is created", async () => {
    const calls: string[] = [];
    const id = hookRegistry.register({
      type: "PostEntityCreate",
      blocking: false,
      priority: 1,
      handler: async (ctx) => { calls.push(ctx.entityId); },
    });

    const entity = createEntity({ name: "Test Entity", type: "concept" }, testDb);

    // Fire-and-forget: wait a tick for the async hook to complete
    await new Promise((r) => setTimeout(r, 10));

    expect(calls).toContain(entity.id);
    hookRegistry.unregister(id);
  });

  test("PostRelationCreate fires when relation is created", async () => {
    const relCalls: string[] = [];
    const id = hookRegistry.register({
      type: "PostRelationCreate",
      blocking: false,
      priority: 1,
      handler: async (ctx) => { relCalls.push(ctx.relationId); },
    });

    const e1 = createEntity({ name: "Entity A", type: "concept" }, testDb);
    const e2 = createEntity({ name: "Entity B", type: "tool" }, testDb);
    const rel = createRelation({
      source_entity_id: e1.id,
      target_entity_id: e2.id,
      relation_type: "related_to",
    }, testDb);

    await new Promise((r) => setTimeout(r, 10));

    expect(relCalls).toContain(rel.id);
    hookRegistry.unregister(id);
  });
});

// ============================================================================
// Integration: session lifecycle hooks
// ============================================================================

describe("Session lifecycle hook integration", () => {
  beforeEach(() => freshDb());

  test("OnSessionStart fires when agent sets focus", async () => {
    const starts: string[] = [];
    const id = hookRegistry.register({
      type: "OnSessionStart",
      blocking: false,
      priority: 1,
      handler: async (ctx) => { starts.push(ctx.agentId); },
    });

    const agent = registerAgent("session-test-agent", undefined, undefined, undefined, undefined, testDb);
    const project = registerProject("session-test-proj", "/tmp/test", undefined, undefined, testDb);

    setFocus(agent.id, project.id);

    await new Promise((r) => setTimeout(r, 10));

    expect(starts).toContain(agent.id);

    // Cleanup
    unfocus(agent.id);
    hookRegistry.unregister(id);
  });

  test("OnSessionEnd fires when agent unfocuses", async () => {
    const ends: string[] = [];
    const id = hookRegistry.register({
      type: "OnSessionEnd",
      blocking: false,
      priority: 1,
      handler: async (ctx) => { ends.push(ctx.agentId); },
    });

    const agent = registerAgent("unfocus-test-agent", undefined, undefined, undefined, undefined, testDb);
    const project = registerProject("unfocus-test-proj", "/tmp/test2", undefined, undefined, testDb);

    setFocus(agent.id, project.id);
    unfocus(agent.id);

    await new Promise((r) => setTimeout(r, 10));

    expect(ends).toContain(agent.id);
    hookRegistry.unregister(id);
  });
});
