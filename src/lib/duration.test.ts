import { describe, expect, it } from "bun:test";
import { parseDuration, formatDuration } from "./duration.js";

describe("parseDuration", () => {
  // Individual units
  it("parses seconds", () => {
    expect(parseDuration("90s")).toBe(90_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
  });

  it("parses weeks", () => {
    expect(parseDuration("1w")).toBe(604_800_000);
  });

  // Combinations
  it("parses day+hour combo", () => {
    expect(parseDuration("1d12h")).toBe(86_400_000 + 43_200_000);
  });

  it("parses hour+minute combo", () => {
    expect(parseDuration("2h30m")).toBe(7_200_000 + 1_800_000);
  });

  it("parses week+day+hour combo", () => {
    expect(parseDuration("1w2d3h")).toBe(604_800_000 + 172_800_000 + 10_800_000);
  });

  // Backwards compat — plain numbers as milliseconds
  it("treats plain number string as milliseconds", () => {
    expect(parseDuration("86400000")).toBe(86_400_000);
  });

  it("treats numeric input as milliseconds", () => {
    expect(parseDuration(5000)).toBe(5000);
  });

  // Whitespace handling
  it("trims whitespace", () => {
    expect(parseDuration("  30m  ")).toBe(1_800_000);
  });

  // Invalid formats
  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow("empty string");
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration format");
  });

  it("throws on unknown unit", () => {
    expect(() => parseDuration("5x")).toThrow("Invalid duration format");
  });

  it("throws on mixed invalid", () => {
    expect(() => parseDuration("1d foo")).toThrow("Invalid duration format");
  });

  it("throws when duration resolves to 0ms (line 61)", () => {
    // "0s" matches the regex pattern but resolves to 0 * 1000 = 0ms → throws
    expect(() => parseDuration("0s")).toThrow("resolves to 0ms");
  });
});

describe("formatDuration", () => {
  it("formats days", () => {
    expect(formatDuration(86_400_000)).toBe("1d");
  });

  it("formats hours", () => {
    expect(formatDuration(7_200_000)).toBe("2h");
  });

  it("formats minutes", () => {
    expect(formatDuration(1_800_000)).toBe("30m");
  });

  it("formats seconds", () => {
    expect(formatDuration(5_000)).toBe("5s");
  });

  it("formats weeks", () => {
    expect(formatDuration(604_800_000)).toBe("1w");
  });

  it("formats day+hour combo", () => {
    expect(formatDuration(86_400_000 + 43_200_000)).toBe("1d12h");
  });

  it("formats hour+minute combo", () => {
    expect(formatDuration(9_000_000)).toBe("2h30m");
  });

  it("formats sub-second as ms", () => {
    expect(formatDuration(500)).toBe("500ms");
  });

  it("formats zero", () => {
    expect(formatDuration(0)).toBe("0s");
  });

  it("throws on negative", () => {
    expect(() => formatDuration(-1)).toThrow("negative");
  });

  // Round-trip tests
  it("round-trips 1d12h", () => {
    const ms = parseDuration("1d12h");
    expect(formatDuration(ms)).toBe("1d12h");
  });

  it("round-trips 2h30m", () => {
    const ms = parseDuration("2h30m");
    expect(formatDuration(ms)).toBe("2h30m");
  });

  it("round-trips 1w", () => {
    const ms = parseDuration("1w");
    expect(formatDuration(ms)).toBe("1w");
  });
});
