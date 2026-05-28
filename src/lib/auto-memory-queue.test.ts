import { describe, it, expect, beforeEach } from "bun:test";
import { autoMemoryQueue, type ExtractionJob } from "./auto-memory-queue.js";

describe("autoMemoryQueue", () => {
  beforeEach(async () => {
    autoMemoryQueue.setHandler(async () => {});
    // Drain any leftover jobs from prior tests
    while (autoMemoryQueue.getStats().pending > 0) {
      await Bun.sleep(10);
    }
  });

  it("processes enqueued jobs via handler", async () => {
    const processed: ExtractionJob[] = [];

    autoMemoryQueue.setHandler(async (job) => {
      processed.push(job);
    });

    autoMemoryQueue.enqueue({
      turn: "User prefers TypeScript",
      timestamp: Date.now(),
      source: "turn",
      agentId: "agent-1",
    });

    await Bun.sleep(50);

    expect(processed).toHaveLength(1);
    expect(processed[0]!.turn).toBe("User prefers TypeScript");
    expect(autoMemoryQueue.getStats().processed).toBeGreaterThanOrEqual(1);
  });

  it("tracks failed jobs without throwing to caller", async () => {
    autoMemoryQueue.setHandler(async () => {
      throw new Error("extraction failed");
    });

    autoMemoryQueue.enqueue({ turn: "fail me", timestamp: Date.now() });
    await Bun.sleep(50);

    expect(autoMemoryQueue.getStats().failed).toBeGreaterThanOrEqual(1);
  });

  it("drops oldest job when queue overflows", async () => {
    let resolveBlock: (() => void) | null = null;
    const block = new Promise<void>((r) => {
      resolveBlock = r;
    });

    autoMemoryQueue.setHandler(async () => {
      await block;
    });

    for (let i = 0; i < 104; i++) {
      autoMemoryQueue.enqueue({ turn: `job-${i}`, timestamp: i });
    }

    await Bun.sleep(20);
    expect(autoMemoryQueue.getStats().dropped).toBeGreaterThanOrEqual(1);

    resolveBlock?.();
    await Bun.sleep(20);
  });
});
