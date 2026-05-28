import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { generateWhenToUse } from "./when-to-use-generator.js";

describe("generateWhenToUse", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["MEMENTOS_AUTO_WHEN_TO_USE"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when feature is disabled", async () => {
    const result = await generateWhenToUse("key", "value", "knowledge", []);
    expect(result).toBeNull();
  });

  it("returns null when enabled but API key is missing", async () => {
    process.env["MEMENTOS_AUTO_WHEN_TO_USE"] = "true";
    const result = await generateWhenToUse("preferred-language", "Use TypeScript", "preference", [
      "typescript",
    ]);
    expect(result).toBeNull();
  });
});
