process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "./database.js";
import {
  createWebhookHook,
  getWebhookHook,
  listWebhookHooks,
  updateWebhookHook,
  deleteWebhookHook,
  recordWebhookInvocation,
} from "./webhook_hooks.js";

describe("webhook hooks", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("creates and retrieves a webhook hook", () => {
    const db = getDatabase();
    const hook = createWebhookHook(
      {
        type: "PostMemorySave",
        handlerUrl: "https://example.com/hook",
        priority: 10,
        blocking: true,
        description: "Test webhook",
      },
      db
    );

    expect(hook.id).toHaveLength(8);
    expect(hook.type).toBe("PostMemorySave");
    expect(hook.handlerUrl).toBe("https://example.com/hook");
    expect(hook.priority).toBe(10);
    expect(hook.blocking).toBe(true);
    expect(hook.enabled).toBe(true);
    expect(hook.invocationCount).toBe(0);
    expect(hook.failureCount).toBe(0);

    const fetched = getWebhookHook(hook.id, db);
    expect(fetched?.description).toBe("Test webhook");
  });

  it("lists hooks filtered by type and enabled state", () => {
    const db = getDatabase();
    createWebhookHook({ type: "PostMemorySave", handlerUrl: "https://a.test/h" }, db);
    const disabled = createWebhookHook(
      { type: "OnSessionStart", handlerUrl: "https://b.test/h" },
      db
    );
    updateWebhookHook(disabled.id, { enabled: false }, db);

    expect(listWebhookHooks({}, db)).toHaveLength(2);
    expect(listWebhookHooks({ type: "PostMemorySave" }, db)).toHaveLength(1);
    expect(listWebhookHooks({ enabled: true }, db)).toHaveLength(1);
  });

  it("updates and deletes webhook hooks", () => {
    const db = getDatabase();
    const hook = createWebhookHook(
      { type: "PostMemorySave", handlerUrl: "https://c.test/h" },
      db
    );

    const updated = updateWebhookHook(
      hook.id,
      { enabled: false, priority: 99, description: "Updated" },
      db
    );
    expect(updated?.enabled).toBe(false);
    expect(updated?.priority).toBe(99);
    expect(updated?.description).toBe("Updated");
    expect(updateWebhookHook("missing", { enabled: false }, db)).toBeNull();

    expect(deleteWebhookHook(hook.id, db)).toBe(true);
    expect(getWebhookHook(hook.id, db)).toBeNull();
    expect(deleteWebhookHook(hook.id, db)).toBe(false);
  });

  it("tracks invocation and failure counts", () => {
    const db = getDatabase();
    const hook = createWebhookHook(
      { type: "PostMemorySave", handlerUrl: "https://d.test/h" },
      db
    );

    recordWebhookInvocation(hook.id, true, db);
    recordWebhookInvocation(hook.id, false, db);

    const stats = getWebhookHook(hook.id, db)!;
    expect(stats.invocationCount).toBe(2);
    expect(stats.failureCount).toBe(1);
  });
});
