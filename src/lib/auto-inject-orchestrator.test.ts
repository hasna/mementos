import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  startAutoInject,
  stopAutoInject,
  getAutoInjectConfig,
  updateAutoInjectConfig,
  getAutoInjectStatus,
} from "./auto-inject-orchestrator.js";

describe("auto-inject orchestrator", () => {
  const originalEnv = process.env["MEMENTOS_AUTO_INJECT"];

  beforeEach(() => {
    stopAutoInject();
    delete process.env["MEMENTOS_AUTO_INJECT"];
  });

  afterEach(() => {
    stopAutoInject();
    if (originalEnv === undefined) {
      delete process.env["MEMENTOS_AUTO_INJECT"];
    } else {
      process.env["MEMENTOS_AUTO_INJECT"] = originalEnv;
    }
  });

  it("does not start when env flag is disabled", async () => {
    const result = await startAutoInject({
      server: { notification: async () => {} },
      config: { enabled: false },
    });

    expect(result.started).toBe(false);
    expect(result.session_id).toBeNull();
    expect(getAutoInjectStatus().running).toBe(false);
  });

  it("exposes default config and accepts updates", () => {
    const config = getAutoInjectConfig();
    expect(config.throttle_ms).toBe(30_000);
    expect(config.debounce_ms).toBe(2_000);
    expect(config.max_pushes_per_5min).toBe(5);
    expect(config.session_briefing).toBe(true);

    const updated = updateAutoInjectConfig({
      throttle_ms: 10_000,
      max_pushes_per_5min: 2,
      session_briefing: false,
    });

    expect(updated.throttle_ms).toBe(10_000);
    expect(updated.max_pushes_per_5min).toBe(2);
    expect(updated.session_briefing).toBe(false);
    expect(getAutoInjectConfig().throttle_ms).toBe(10_000);
  });

  it("reports status snapshot when not running", () => {
    const status = getAutoInjectStatus();

    expect(status.running).toBe(false);
    expect(status.session_id).toBeNull();
    expect(status.watcher.active).toBe(false);
    expect(status.pushes.total).toBe(0);
    expect(Array.isArray(status.history)).toBe(true);
  });

  it("stopAutoInject is idempotent", () => {
    stopAutoInject();
    stopAutoInject();
    expect(getAutoInjectStatus().running).toBe(false);
  });
});
