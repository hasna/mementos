import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startSessionWatcher,
  stopSessionWatcher,
  getWatcherStatus,
  type SessionMessage,
} from "./session-watcher.js";

describe("session-watcher", () => {
  let fakeHome: string;
  let cwd: string;
  let sessionFile: string;
  const originalHome = process.env["HOME"];

  beforeEach(() => {
    stopSessionWatcher();
    fakeHome = join(tmpdir(), `mementos-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(fakeHome, "workspace", "my-project");
    const encodedCwd = cwd.replace(/\//g, "-");
    sessionFile = join(fakeHome, ".claude", "projects", encodedCwd, "session.jsonl");

    mkdirSync(join(sessionFile, ".."), { recursive: true });
    writeFileSync(sessionFile, "");
    process.env["HOME"] = fakeHome;
  });

  afterEach(() => {
    stopSessionWatcher();
    process.env["HOME"] = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns null session file when project dir is missing", () => {
    rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });

    const result = startSessionWatcher(cwd, () => {});
    expect(result.sessionFile).toBeNull();
    expect(getWatcherStatus().active).toBe(false);
  });

  it("delivers newly appended session messages", async () => {
    const received: SessionMessage[] = [];
    const result = startSessionWatcher(cwd, (msg) => received.push(msg));

    expect(result.sessionFile).toBe(sessionFile);
    expect(getWatcherStatus().active).toBe(true);

    appendFileSync(
      sessionFile,
      JSON.stringify({
        message: {
          role: "user",
          content: "Help me refactor the database layer",
        },
      }) + "\n"
    );

    await Bun.sleep(100);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.role).toBe("user");
    expect(received[0]!.content).toBe("Help me refactor the database layer");
  });

  it("extracts tool_use blocks from structured content", async () => {
    const received: SessionMessage[] = [];
    startSessionWatcher(cwd, (msg) => received.push(msg));

    appendFileSync(
      sessionFile,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running grep" },
            { type: "tool_use", name: "Grep", input: { pattern: "foo" } },
          ],
        },
      }) + "\n"
    );

    await Bun.sleep(100);

    expect(received.some((m) => m.tool_use?.[0]?.name === "Grep")).toBe(true);
  });

  it("stopSessionWatcher clears active state", () => {
    startSessionWatcher(cwd, () => {});
    stopSessionWatcher();

    const status = getWatcherStatus();
    expect(status.active).toBe(false);
    expect(status.watching_file).toBeNull();
    expect(status.last_offset).toBe(0);
  });
});
