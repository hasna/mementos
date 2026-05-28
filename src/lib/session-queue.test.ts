process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { getDatabase, resetDatabase } from "../db/database.js";
import { createSessionJob } from "../db/session-jobs.js";
import { enqueueSessionJob, getSessionQueueStats } from "./session-queue.js";

describe("session-queue", () => {
  beforeEach(() => {
    resetDatabase();
  });

  it("reports job counts from database", () => {
    const db = getDatabase();
    createSessionJob({ session_id: "s1", transcript: "pending job" }, db);
    const completed = createSessionJob({ session_id: "s2", transcript: "done job" }, db);
    db.run("UPDATE session_memory_jobs SET status = 'completed' WHERE id = ?", [completed.id]);

    const stats = getSessionQueueStats();
    expect(stats.pending).toBeGreaterThanOrEqual(1);
    expect(stats.completed).toBeGreaterThanOrEqual(1);
  });

  it("accepts enqueue without throwing", () => {
    const job = createSessionJob({ session_id: "s3", transcript: "queued" });
    expect(() => enqueueSessionJob(job.id)).not.toThrow();
  });
});
