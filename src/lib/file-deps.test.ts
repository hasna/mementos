process.env["MEMENTOS_DB_PATH"] = ":memory:";

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDatabase, resetDatabase } from "../db/database.js";
import { buildFileDependencyGraph } from "./file-deps.js";
import { listEntities } from "../db/entities.js";
import { listRelations } from "../db/relations.js";

describe("buildFileDependencyGraph", () => {
  let rootDir: string;

  beforeEach(() => {
    resetDatabase();
    rootDir = join(tmpdir(), `mementos-file-deps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(rootDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("returns error for missing directory", async () => {
    const db = getDatabase();
    const result = await buildFileDependencyGraph(
      { root_dir: join(rootDir, "missing") },
      db
    );

    expect(result.files_scanned).toBe(0);
    expect(result.errors[0]).toContain("Directory not found");
  });

  it("creates file entities and depends_on relations from imports", async () => {
    const db = getDatabase();
    writeFileSync(join(rootDir, "util.ts"), "export const x = 1;\n");
    writeFileSync(join(rootDir, "main.ts"), "import { x } from './util';\nconsole.log(x);\n");

    const result = await buildFileDependencyGraph({ root_dir: rootDir }, db);

    expect(result.files_scanned).toBe(2);
    expect(result.entities_created).toBe(2);
    expect(result.relations_created).toBe(1);
    expect(result.errors).toHaveLength(0);

    const entities = listEntities({ type: "file" }, db);
    expect(entities).toHaveLength(2);
    expect(entities.some((e) => e.name === "main.ts")).toBe(true);
    expect(entities.some((e) => e.name === "util.ts")).toBe(true);

    const relations = listRelations({ relation_type: "depends_on" }, db);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.relation_type).toBe("depends_on");
  });

  it("skips re-creating entities on incremental scan", async () => {
    const db = getDatabase();
    writeFileSync(join(rootDir, "only.ts"), "export default 1;\n");

    const first = await buildFileDependencyGraph({ root_dir: rootDir }, db);
    const second = await buildFileDependencyGraph({ root_dir: rootDir, incremental: true }, db);

    expect(first.entities_created).toBe(1);
    expect(second.entities_created).toBe(0);
    expect(second.entities_updated).toBe(1);
  });

  it("excludes node_modules from scan", async () => {
    const db = getDatabase();
    mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(rootDir, "app.ts"), "export {};\n");
    writeFileSync(join(rootDir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");

    const result = await buildFileDependencyGraph({ root_dir: rootDir }, db);

    expect(result.files_scanned).toBe(1);
    expect(result.entities_created).toBe(1);
  });
});
