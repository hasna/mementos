process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getActiveModel, setActiveModel, clearActiveModel, DEFAULT_MODEL } from "./model-config.js";

const CONFIG_DIR = join(homedir(), ".hasna", "mementos");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

let savedConfig: string | null = null;

beforeEach(() => {
  // Save the existing config so we can restore it after each test
  if (existsSync(CONFIG_PATH)) {
    savedConfig = readFileSync(CONFIG_PATH, "utf-8");
  } else {
    savedConfig = null;
  }
});

afterEach(() => {
  // Restore the original config
  if (savedConfig !== null) {
    writeFileSync(CONFIG_PATH, savedConfig, "utf-8");
  } else if (existsSync(CONFIG_PATH)) {
    unlinkSync(CONFIG_PATH);
  }
});

describe("DEFAULT_MODEL", () => {
  test("is gpt-4o-mini", () => {
    expect(DEFAULT_MODEL).toBe("gpt-4o-mini");
  });
});

describe("getActiveModel", () => {
  test("returns DEFAULT_MODEL when no config file exists", () => {
    // Remove config file if it exists
    if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    const model = getActiveModel();
    expect(model).toBe(DEFAULT_MODEL);
  });

  test("returns DEFAULT_MODEL when config has no activeModel", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ someOtherKey: "value" }, null, 2) + "\n", "utf-8");
    const model = getActiveModel();
    expect(model).toBe(DEFAULT_MODEL);
  });

  test("returns activeModel from config when set", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ activeModel: "ft:gpt-4o-mini:custom-123" }, null, 2) + "\n", "utf-8");
    const model = getActiveModel();
    expect(model).toBe("ft:gpt-4o-mini:custom-123");
  });

  test("returns DEFAULT_MODEL when config file is invalid JSON", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, "not valid json {{{", "utf-8");
    const model = getActiveModel();
    expect(model).toBe(DEFAULT_MODEL);
  });
});

describe("setActiveModel", () => {
  test("sets the active model in config", () => {
    setActiveModel("ft:gpt-4o-mini:my-model");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config.activeModel).toBe("ft:gpt-4o-mini:my-model");
  });

  test("preserves existing config keys", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ existingKey: "preserved" }, null, 2) + "\n", "utf-8");
    setActiveModel("ft:gpt-4o-mini:new");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config.activeModel).toBe("ft:gpt-4o-mini:new");
    expect(config.existingKey).toBe("preserved");
  });

  test("overwrites previous activeModel", () => {
    setActiveModel("model-a");
    setActiveModel("model-b");
    const model = getActiveModel();
    expect(model).toBe("model-b");
  });

  test("creates config directory if it does not exist", () => {
    // The config dir should exist already (from homedir), but setActiveModel
    // should handle the case where it doesn't via mkdirSync recursive
    setActiveModel("test-model");
    expect(existsSync(CONFIG_PATH)).toBe(true);
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config.activeModel).toBe("test-model");
  });

  test("writes pretty-printed JSON with trailing newline", () => {
    setActiveModel("my-model");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // Pretty-printed means it should contain newlines within the JSON
    expect(raw).toContain("\n  ");
  });
});

describe("clearActiveModel", () => {
  test("removes activeModel from config", () => {
    setActiveModel("some-model");
    expect(getActiveModel()).toBe("some-model");
    clearActiveModel();
    expect(getActiveModel()).toBe(DEFAULT_MODEL);
  });

  test("preserves other config keys when clearing", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ activeModel: "old", otherKey: 42 }, null, 2) + "\n", "utf-8");
    clearActiveModel();
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config.activeModel).toBeUndefined();
    expect(config.otherKey).toBe(42);
  });

  test("works when no activeModel was set", () => {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(CONFIG_PATH, JSON.stringify({ other: "data" }, null, 2) + "\n", "utf-8");
    clearActiveModel();
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw);
    expect(config.activeModel).toBeUndefined();
    expect(config.other).toBe("data");
  });

  test("works when config file does not exist", () => {
    if (existsSync(CONFIG_PATH)) {
      unlinkSync(CONFIG_PATH);
    }
    // Should not throw
    clearActiveModel();
    // After clearing, config file should exist (writeConfig creates it)
    expect(existsSync(CONFIG_PATH)).toBe(true);
    expect(getActiveModel()).toBe(DEFAULT_MODEL);
  });
});

describe("roundtrip", () => {
  test("set then get returns the same model", () => {
    const modelId = "ft:gpt-4o-mini:org:suffix:id-12345";
    setActiveModel(modelId);
    expect(getActiveModel()).toBe(modelId);
  });

  test("set, clear, get returns default", () => {
    setActiveModel("custom-model");
    clearActiveModel();
    expect(getActiveModel()).toBe(DEFAULT_MODEL);
  });

  test("multiple set calls, only last value persists", () => {
    setActiveModel("model-1");
    setActiveModel("model-2");
    setActiveModel("model-3");
    expect(getActiveModel()).toBe("model-3");
  });
});

describe("writeConfig - mkdirSync branch (line 30)", () => {
  // Covers the branch where CONFIG_DIR does not exist and mkdirSync is called
  const backupDir = join(homedir(), ".hasna", "mementos.test-backup");

  test("creates CONFIG_DIR via mkdirSync when it does not exist (line 30)", () => {
    // Rename CONFIG_DIR so it temporarily doesn't exist
    const dirExists = existsSync(CONFIG_DIR);
    if (dirExists) {
      renameSync(CONFIG_DIR, backupDir);
    }

    try {
      // Now CONFIG_DIR does not exist — writeConfig (called by setActiveModel)
      // will hit the mkdirSync branch at line 30
      setActiveModel("mkdirSync-coverage-model");

      // Verify the directory was created and config was written
      expect(existsSync(CONFIG_DIR)).toBe(true);
      expect(existsSync(CONFIG_PATH)).toBe(true);
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);
      expect(config.activeModel).toBe("mkdirSync-coverage-model");
    } finally {
      // Cleanup: remove the newly created dir
      if (existsSync(CONFIG_DIR)) {
        rmSync(CONFIG_DIR, { recursive: true, force: true });
      }
      // Restore the original dir if it existed
      if (dirExists && existsSync(backupDir)) {
        renameSync(backupDir, CONFIG_DIR);
      }
    }
  });
});
