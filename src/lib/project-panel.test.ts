process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemory, updateMemory } from "../db/memories.js";
import { closeDatabase, resetDatabase } from "../db/database.js";
import { registerProject } from "../db/projects.js";
import { createMementosProjectPanel } from "./project-panel.js";

beforeEach(() => {
  process.env["MEMENTOS_DB_PATH"] = ":memory:";
  resetDatabase();
});

function seedProjectMemories() {
  const project = registerProject("Swiss Bank Account", "/tmp/swiss-bank-account");
  const first = createMemory({
    key: "decision.bank-shortlist",
    value: `Use Mirabaud and UBS as primary candidates. ${"private context ".repeat(30)} SECRET_TAIL_DO_NOT_INCLUDE`,
    summary: null,
    category: "fact",
    scope: "shared",
    tags: ["decision", "bank"],
    importance: 9,
    source: "agent",
    project_id: project.id,
  });
  updateMemory(first.id, { version: first.version, pinned: true });
  createMemory({
    key: "assumption.paperwork",
    value: "Paperwork includes passports, proof of funds, tax residency, and source-of-funds narratives.",
    category: "knowledge",
    scope: "shared",
    tags: ["assumption", "documents"],
    importance: 6,
    source: "agent",
    project_id: project.id,
  });
  createMemory({
    key: "global.not-in-project",
    value: "This memory should not appear in the project panel.",
    category: "knowledge",
    scope: "global",
    importance: 10,
    source: "agent",
  });
  return project;
}

describe("createMementosProjectPanel", () => {
  test("emits a contract-valid project memory panel with bounded previews", () => {
    const project = seedProjectMemories();

    const panel = createMementosProjectPanel(project.id, { limit: 5 });

    expect(panel.schema).toBe("hasna.project_panel.v1");
    expect(panel.projectId).toBe("swiss-bank-account");
    expect(panel.provider.kind).toBe("mementos");
    expect(panel.kind).toBe("mementos");
    expect(panel.state).toBe("ready");
    expect(panel.items).toHaveLength(2);
    expect(panel.items[0].status).toBe("pinned");
    expect(panel.items[0].priority).toBe("critical");
    expect(panel.items[0].summary?.length).toBeLessThanOrEqual(180);
    expect(panel.items[0].summary).not.toContain("SECRET_TAIL_DO_NOT_INCLUDE");
    expect(panel.metrics.find((metric) => metric.id === "active_memories")?.value).toBe(2);
    expect(panel.metrics.find((metric) => metric.id === "decisions")?.value).toBe(1);
    expect(panel.metrics.find((metric) => metric.id === "assumptions")?.value).toBe(1);
    expect(panel.items.some((item) => item.title === "global.not-in-project")).toBe(false);
  });

  test("CLI prints project-panel contract JSON", () => {
    const dbPath = join(tmpdir(), `mementos-project-panel-${Date.now()}.db`);
    process.env["MEMENTOS_DB_PATH"] = dbPath;
    resetDatabase();
    const project = seedProjectMemories();
    closeDatabase();

    const result = spawnSync("bun", ["src/cli/index.tsx", "--json", "project-panel", "--project", project.id, "--contract"], {
      cwd: process.cwd(),
      env: { ...process.env, MEMENTOS_DB_PATH: dbPath },
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(result.status).toBe(0);
    const panel = JSON.parse(result.stdout.toString());
    expect(panel.schema).toBe("hasna.project_panel.v1");
    expect(panel.provider.kind).toBe("mementos");
    expect(panel.metrics.some((metric: { id: string; value: number }) => metric.id === "active_memories" && metric.value === 2)).toBe(true);
  });
});
