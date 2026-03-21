import { describe, test, expect } from "bun:test";
import { timeDecay, accessBoost, computeDecayScore } from "./decay.js";

// ============================================================================
// timeDecay
// ============================================================================

describe("timeDecay", () => {
  test("returns 1.0 for 0 days", () => {
    expect(timeDecay(0)).toBe(1.0);
  });

  test("returns 1.0 for negative days (clamps)", () => {
    expect(timeDecay(-5)).toBe(1.0);
  });

  test("returns ~0.9 for 10 days (default lambda=0.01)", () => {
    const result = timeDecay(10);
    // exp(-0.01 * 10) = exp(-0.1) ≈ 0.9048
    expect(result).toBeCloseTo(Math.exp(-0.1), 4);
    expect(result).toBeGreaterThan(0.89);
    expect(result).toBeLessThan(0.92);
  });

  test("returns ~0.74 for 30 days", () => {
    const result = timeDecay(30);
    // exp(-0.01 * 30) = exp(-0.3) ≈ 0.7408
    expect(result).toBeCloseTo(Math.exp(-0.3), 4);
  });

  test("returns ~0.37 for 100 days", () => {
    const result = timeDecay(100);
    // exp(-0.01 * 100) = exp(-1) ≈ 0.3679
    expect(result).toBeCloseTo(Math.exp(-1), 4);
  });

  test("approaches 0 for very large values", () => {
    expect(timeDecay(1000)).toBeLessThan(0.001);
  });

  test("respects custom lambda", () => {
    // lambda=0.1 → much faster decay
    const fast = timeDecay(10, 0.1);
    // exp(-0.1 * 10) = exp(-1) ≈ 0.3679
    expect(fast).toBeCloseTo(Math.exp(-1), 4);

    const slow = timeDecay(10, 0.001);
    // exp(-0.001 * 10) = exp(-0.01) ≈ 0.99
    expect(slow).toBeGreaterThan(0.98);
  });
});

// ============================================================================
// accessBoost
// ============================================================================

describe("accessBoost", () => {
  test("returns 1.0 for 0 accesses", () => {
    expect(accessBoost(0)).toBe(1.0);
  });

  test("returns 1.0 for negative accesses (clamps)", () => {
    expect(accessBoost(-3)).toBe(1.0);
  });

  test("increases with more accesses", () => {
    const b1 = accessBoost(1);
    const b5 = accessBoost(5);
    const b10 = accessBoost(10);
    const b50 = accessBoost(50);

    expect(b1).toBeGreaterThan(1.0);
    expect(b5).toBeGreaterThan(b1);
    expect(b10).toBeGreaterThan(b5);
    expect(b50).toBeGreaterThan(b10);
  });

  test("returns ~1.07 for 1 access", () => {
    const result = accessBoost(1);
    // 1 + log(2) * 0.1 ≈ 1.0693
    expect(result).toBeCloseTo(1 + Math.log(2) * 0.1, 4);
  });

  test("returns ~1.11 for 2 accesses", () => {
    const result = accessBoost(2);
    // 1 + log(3) * 0.1 ≈ 1.1099
    expect(result).toBeCloseTo(1 + Math.log(3) * 0.1, 4);
  });

  test("returns ~1.24 for 10 accesses", () => {
    const result = accessBoost(10);
    // 1 + log(11) * 0.1 ≈ 1.2398
    expect(result).toBeCloseTo(1 + Math.log(11) * 0.1, 4);
  });

  test("grows logarithmically (diminishing returns)", () => {
    const diff1to10 = accessBoost(10) - accessBoost(1);
    const diff10to100 = accessBoost(100) - accessBoost(10);
    // Growth from 10→100 should be less than from 1→10 in relative terms
    expect(diff10to100).toBeLessThan(diff1to10 * 2);
  });
});

// ============================================================================
// computeDecayScore
// ============================================================================

describe("computeDecayScore", () => {
  test("returns raw importance for pinned memories", () => {
    const score = computeDecayScore({
      importance: 8,
      access_count: 0,
      accessed_at: null,
      created_at: "2020-01-01T00:00:00Z", // very old
      pinned: true,
    });
    expect(score).toBe(8);
  });

  test("returns raw importance for pinned memories regardless of access count", () => {
    const score = computeDecayScore({
      importance: 10,
      access_count: 100,
      accessed_at: "2020-01-01T00:00:00Z",
      created_at: "2019-01-01T00:00:00Z",
      pinned: true,
    });
    expect(score).toBe(10);
  });

  test("decays for old unaccessed memories", () => {
    const now = new Date();
    const hundredDaysAgo = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

    const score = computeDecayScore({
      importance: 10,
      access_count: 0,
      accessed_at: null,
      created_at: hundredDaysAgo.toISOString(),
      pinned: false,
    });

    // Should be roughly 10 * exp(-1) * 1.0 ≈ 3.68
    expect(score).toBeLessThan(10);
    expect(score).toBeCloseTo(10 * Math.exp(-1), 0);
  });

  test("boosts frequently accessed memories", () => {
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);

    const lowAccess = computeDecayScore({
      importance: 5,
      access_count: 0,
      accessed_at: tenDaysAgo.toISOString(),
      created_at: tenDaysAgo.toISOString(),
      pinned: false,
    });

    const highAccess = computeDecayScore({
      importance: 5,
      access_count: 20,
      accessed_at: tenDaysAgo.toISOString(),
      created_at: tenDaysAgo.toISOString(),
      pinned: false,
    });

    expect(highAccess).toBeGreaterThan(lowAccess);
  });

  test("uses created_at when accessed_at is null", () => {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const score = computeDecayScore({
      importance: 10,
      access_count: 0,
      accessed_at: null,
      created_at: thirtyDaysAgo.toISOString(),
      pinned: false,
    });

    // exp(-0.01 * 30) ≈ 0.7408 → 10 * 0.7408 ≈ 7.408
    expect(score).toBeCloseTo(10 * Math.exp(-0.3), 0);
    expect(score).toBeGreaterThan(6);
    expect(score).toBeLessThan(8);
  });

  test("recently accessed memories barely decay", () => {
    const now = new Date();

    const score = computeDecayScore({
      importance: 7,
      access_count: 3,
      accessed_at: now.toISOString(),
      created_at: "2020-01-01T00:00:00Z",
      pinned: false,
    });

    // Decay factor ≈ 1.0, boost = 1 + log(4) * 0.1 ≈ 1.139
    // Score ≈ 7 * 1.0 * 1.139 ≈ 7.97
    expect(score).toBeGreaterThan(7);
  });

  test("higher importance yields higher decay score at same age", () => {
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    const low = computeDecayScore({
      importance: 3,
      access_count: 0,
      accessed_at: fiveDaysAgo.toISOString(),
      created_at: fiveDaysAgo.toISOString(),
      pinned: false,
    });

    const high = computeDecayScore({
      importance: 9,
      access_count: 0,
      accessed_at: fiveDaysAgo.toISOString(),
      created_at: fiveDaysAgo.toISOString(),
      pinned: false,
    });

    expect(high).toBeGreaterThan(low);
    // Ratio should be proportional to importance ratio
    expect(high / low).toBeCloseTo(9 / 3, 1);
  });
});
