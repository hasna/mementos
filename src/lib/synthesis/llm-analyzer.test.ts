import { describe, test, expect } from "bun:test";

describe("llm-analyzer", () => {
  test("module imports without error", async () => {
    const mod = await import("./llm-analyzer.js");
    expect(typeof mod.analyzeCorpus).toBe("function");
  });
});
