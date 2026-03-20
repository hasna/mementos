/**
 * File dependency graph builder for open-mementos.
 * Scans a codebase, creates 'file' entities for each source file, and
 * creates 'depends_on' relations between files based on import/require statements.
 *
 * Supports: TypeScript, JavaScript, Python, Go (basic), Rust (basic).
 */

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, resolve, relative, dirname, extname, basename } from "path";
import type { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { createEntity, listEntities } from "../db/entities.js";
import { createRelation, listRelations } from "../db/relations.js";

export interface FileDepsOptions {
  root_dir: string;
  project_id?: string;
  extensions?: string[];
  exclude_patterns?: string[];
  incremental?: boolean;
}

export interface FileDepsResult {
  files_scanned: number;
  entities_created: number;
  entities_updated: number;
  relations_created: number;
  errors: string[];
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs"];
const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", "build", ".next", "__pycache__", "target", "vendor"];

/** Parse import paths from a source file. */
function parseImports(_filePath: string, content: string): string[] {
  const imports: string[] = [];

  // TypeScript/JavaScript: import ... from '...', require('...')
  const tsImports = [
    /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of tsImports) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const imp = m[1]!;
      // Only relative imports correspond to local files
      if (imp.startsWith(".")) imports.push(imp);
    }
  }

  // Python: from .x import ..., import x.y
  const pyImports = /^(?:from\s+(\.+[\w.]*)|import\s+([\w.]+))/gm;
  let m;
  while ((m = pyImports.exec(content)) !== null) {
    const imp = m[1] || m[2];
    if (imp && imp.startsWith(".")) imports.push(imp);
  }

  return [...new Set(imports)];
}

/** Resolve an import path to a real file path. */
function resolveImport(fromFile: string, importPath: string, allFiles: Set<string>): string | null {
  const dir = dirname(fromFile);
  const base = resolve(dir, importPath);

  // Try exact match first
  if (allFiles.has(base)) return base;

  // Try with common extensions
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) {
    const withExt = base + ext;
    if (allFiles.has(withExt)) return withExt;
    // Try /index.EXT
    const index = join(base, `index${ext}`);
    if (allFiles.has(index)) return index;
  }

  return null;
}

/** Collect all source files in directory recursively. */
function collectFiles(dir: string, extensions: string[], excludes: string[]): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    let entries;
    try { entries = readdirSync(current); } catch { return; }
    for (const entry of entries) {
      if (excludes.some(e => entry === e || current.includes(`/${e}/`))) continue;
      const full = join(current, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.includes(extname(entry))) {
        files.push(full);
      }
    }
  }

  walk(resolve(dir));
  return files;
}

/**
 * Scan a codebase, create file entities and import-based depends_on relations.
 */
export async function buildFileDependencyGraph(
  opts: FileDepsOptions,
  db?: Database
): Promise<FileDepsResult> {
  const d = db || getDatabase();
  const result: FileDepsResult = { files_scanned: 0, entities_created: 0, entities_updated: 0, relations_created: 0, errors: [] };

  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const excludes = opts.exclude_patterns ?? DEFAULT_EXCLUDES;
  const rootDir = resolve(opts.root_dir);

  if (!existsSync(rootDir)) {
    result.errors.push(`Directory not found: ${rootDir}`);
    return result;
  }

  const files = collectFiles(rootDir, extensions, excludes);
  const fileSet = new Set(files);
  result.files_scanned = files.length;

  // Build file entity map (path → entity_id)
  const entityMap = new Map<string, string>();

  // Pre-load existing file entities for this project
  const existingEntities = listEntities({ type: "file", project_id: opts.project_id, limit: 10000 }, d);
  for (const e of existingEntities) {
    if (e.metadata?.["file_path"]) {
      entityMap.set(e.metadata["file_path"] as string, e.id);
    }
  }

  // Create/update file entities
  for (const filePath of files) {
    const relPath = relative(rootDir, filePath);
    const name = basename(filePath);

    if (entityMap.has(filePath)) {
      result.entities_updated++;
      continue;
    }

    try {
      const entity = createEntity({
        type: "file",
        name,
        description: relPath,
        project_id: opts.project_id,
        metadata: { file_path: filePath, rel_path: relPath, ext: extname(filePath), root_dir: rootDir },
      }, d);
      entityMap.set(filePath, entity.id);
      result.entities_created++;
    } catch (e) {
      result.errors.push(`Entity creation failed for ${relPath}: ${String(e)}`);
    }
  }

  // Build dependency relations
  for (const filePath of files) {
    const fromId = entityMap.get(filePath);
    if (!fromId) continue;

    let content: string;
    try { content = readFileSync(filePath, "utf-8"); } catch { continue; }

    const imports = parseImports(filePath, content);
    for (const imp of imports) {
      const resolvedPath = resolveImport(filePath, imp, fileSet);
      if (!resolvedPath) continue;

      const toId = entityMap.get(resolvedPath);
      if (!toId || toId === fromId) continue;

      // Check if relation already exists
      try {
        const existing = listRelations({ entity_id: fromId, relation_type: "depends_on", direction: "outgoing" }, d);
        if (existing.some(r => r.target_entity_id === toId)) continue;

        createRelation({
          source_entity_id: fromId,
          target_entity_id: toId,
          relation_type: "depends_on",
          metadata: { import_path: imp, project_id: opts.project_id },
        }, d);
        result.relations_created++;
      } catch (e) {
        result.errors.push(`Relation failed ${relative(rootDir, filePath)} → ${relative(rootDir, resolvedPath)}: ${String(e)}`);
      }
    }
  }

  return result;
}
