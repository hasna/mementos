import { describe, it, expect } from "bun:test";
import { computeQualityScore } from "./quality.js";
import type { Memory } from "../types/index.js";

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: "mem-1",
    key: "test-key",
    value: "short",
    category: "knowledge",
    scope: "shared",
    summary: null,
    tags: [],
    importance: 5,
    source: "agent",
    status: "active",
    pinned: false,
    agent_id: null,
    project_id: null,
    session_id: null,
    metadata: {},
    access_count: 0,
    version: 1,
    expires_at: null,
    valid_from: null,
    valid_until: null,
    ingested_at: null,
    created_at: now,
    updated_at: now,
    accessed_at: null,
    ...overrides,
  };
}

describe("computeQualityScore", () => {
  it("scores short vague memories lower than detailed actionable ones", () => {
    const vague = computeQualityScore(makeMemory({ value: "ok" }));
    const detailed = computeQualityScore(
      makeMemory({
        value:
          "When deploying, run `bun test` first, then build, then deploy. Step 1: verify tests pass. Step 2: run build. Step 3: deploy to staging and check logs.",
        updated_at: new Date().toISOString(),
      })
    );

    expect(detailed.total).toBeGreaterThan(vague.total);
    expect(detailed.specificity).toBeGreaterThan(vague.specificity);
    expect(detailed.actionability).toBeGreaterThan(vague.actionability);
  });

  it("caps specificity at 1 for long values", () => {
    const longValue = "x".repeat(300);
    const score = computeQualityScore(makeMemory({ value: longValue }));
    expect(score.specificity).toBe(1);
  });

  it("detects step-like patterns for actionability", () => {
    const withSteps = computeQualityScore(
      makeMemory({ value: "1. Install deps\n2. Run tests\n3. Deploy" })
    );
    const withoutSteps = computeQualityScore(
      makeMemory({ value: "Install deps and deploy eventually" })
    );
    expect(withSteps.actionability).toBeGreaterThan(withoutSteps.actionability);
  });

  it("decays freshness for old memories", () => {
    const recent = computeQualityScore(
      makeMemory({ updated_at: new Date().toISOString() })
    );
    const stale = computeQualityScore(
      makeMemory({
        updated_at: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString(),
      })
    );

    expect(recent.freshness).toBeGreaterThan(stale.freshness);
    expect(stale.freshness).toBe(0);
  });

  it("returns rounded scores between 0 and 1", () => {
    const score = computeQualityScore(makeMemory());
    for (const key of ["total", "specificity", "actionability", "freshness"] as const) {
      expect(score[key]).toBeGreaterThanOrEqual(0);
      expect(score[key]).toBeLessThanOrEqual(1);
      expect(Number.isInteger(score[key] * 100)).toBe(true);
    }
  });
});
