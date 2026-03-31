// Set in-memory DB before any imports
process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach } from "bun:test";
import { resetDatabase, getDatabase } from "./database.js";
import {
  createSessionJob,
  getSessionJob,
  listSessionJobs,
  updateSessionJob,
  getNextPendingJob,
} from "./session-jobs.js";

beforeEach(() => {
  resetDatabase();
  getDatabase(":memory:");
});

// ============================================================================
// getNextPendingJob — lines 201-208
// ============================================================================

describe("getNextPendingJob", () => {
  it("returns null when no pending jobs", () => {
    const result = getNextPendingJob();
    expect(result).toBeNull();
  });

  it("returns oldest pending job first", () => {
    const job1 = createSessionJob({ session_id: "s1", transcript: "first" });
    const job2 = createSessionJob({ session_id: "s2", transcript: "second" });

    const next = getNextPendingJob();
    expect(next).not.toBeNull();
    expect(next!.session_id).toBe("s1");
  });

  it("skips processing/completed/failed jobs", () => {
    const job1 = createSessionJob({ session_id: "s1", transcript: "done" });
    updateSessionJob(job1.id, { status: "completed" });

    const job2 = createSessionJob({ session_id: "s2", transcript: "processing" });
    updateSessionJob(job2.id, { status: "processing" });

    const job3 = createSessionJob({ session_id: "s3", transcript: "fresh" });

    const next = getNextPendingJob();
    expect(next).not.toBeNull();
    expect(next!.session_id).toBe("s3");
  });

  it("returns null when all jobs are non-pending", () => {
    const job = createSessionJob({ session_id: "s1", transcript: "done" });
    updateSessionJob(job.id, { status: "completed" });

    const next = getNextPendingJob();
    expect(next).toBeNull();
  });
});

// ============================================================================
// updateSessionJob edge cases — lines 138-139
// ============================================================================

describe("updateSessionJob - edge cases", () => {
  it("returns existing job when no updates provided", () => {
    const job = createSessionJob({ session_id: "s-edge", transcript: "test" });
    const updated = updateSessionJob(job.id, {});
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(job.id);
    expect(updated!.status).toBe("pending");
  });

  it("updates error field to null", () => {
    const job = createSessionJob({ session_id: "s-err", transcript: "test" });
    updateSessionJob(job.id, { status: "failed", error: "something went wrong" });

    // Now clear the error
    const cleared = updateSessionJob(job.id, { error: null });
    expect(cleared!.error).toBeNull();
  });

  it("updates started_at and completed_at timestamps", () => {
    const job = createSessionJob({ session_id: "s-ts", transcript: "test" });

    const started = "2025-03-01T10:00:00.000Z";
    const completed = "2025-03-01T10:05:00.000Z";

    const updated = updateSessionJob(job.id, {
      started_at: started,
      completed_at: completed,
    });

    expect(updated!.started_at).toBe(started);
    expect(updated!.completed_at).toBe(completed);
  });

  it("filters by session_id in listSessionJobs", () => {
    createSessionJob({ session_id: "sess-aaa", transcript: "t1" });
    createSessionJob({ session_id: "sess-bbb", transcript: "t2" });
    createSessionJob({ session_id: "sess-aaa", transcript: "t3" });

    const results = listSessionJobs({ session_id: "sess-aaa" });
    expect(results.length).toBe(2);
    expect(results.every((j) => j.session_id === "sess-aaa")).toBe(true);
  });

  it("respects offset in listSessionJobs", () => {
    for (let i = 0; i < 5; i++) {
      createSessionJob({ session_id: `s${i}`, transcript: `t${i}` });
    }

    const allJobs = listSessionJobs({ limit: 10 });
    const offsetJobs = listSessionJobs({ limit: 10, offset: 2 });

    expect(offsetJobs.length).toBe(3);
    expect(allJobs[2]!.id).toBe(offsetJobs[0]!.id);
  });
});
