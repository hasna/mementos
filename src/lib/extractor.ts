import { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { listAgents } from "../db/agents.js";
import { listProjects } from "../db/projects.js";
import type { EntityType, Memory } from "../types/index.js";

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  confidence: number; // 0-1
}

// Technology keywords mapped to 'tool' entity type
const TECH_KEYWORDS = new Set([
  "typescript", "javascript", "python", "rust", "go", "java", "ruby", "swift",
  "kotlin", "react", "vue", "angular", "svelte", "nextjs", "bun", "node",
  "deno", "sqlite", "postgres", "mysql", "redis", "docker", "kubernetes",
  "git", "npm", "yarn", "pnpm", "webpack", "vite", "tailwind", "prisma",
  "drizzle", "zod", "commander", "express", "fastify", "hono",
]);

// Regex patterns
const FILE_PATH_RE = /(?:^|\s)((?:\/|\.\/|~\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+)/g;
const URL_RE = /https?:\/\/[^\s)]+/g;
const NPM_PACKAGE_RE = /@[\w-]+\/[\w.-]+/g;
const PASCAL_CASE_RE = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;

function getSearchText(memory: Memory): string {
  const parts = [memory.key, memory.value];
  if (memory.summary) parts.push(memory.summary);
  return parts.join(" ");
}

export function extractEntities(memory: Memory, db?: Database): ExtractedEntity[] {
  const text = getSearchText(memory);
  const entityMap = new Map<string, ExtractedEntity>();

  function add(name: string, type: EntityType, confidence: number): void {
    const normalized = name.toLowerCase();
    if (normalized.length < 3) return;
    const existing = entityMap.get(normalized);
    if (!existing || existing.confidence < confidence) {
      entityMap.set(normalized, { name: normalized, type, confidence });
    }
  }

  // 1. File paths
  for (const match of text.matchAll(FILE_PATH_RE)) {
    add(match[1]!.trim(), "file", 0.9);
  }

  // 2. URLs
  for (const match of text.matchAll(URL_RE)) {
    add(match[0]!, "api", 0.8);
  }

  // 3. npm packages
  for (const match of text.matchAll(NPM_PACKAGE_RE)) {
    add(match[0]!, "tool", 0.85);
  }

  // 4. Known agents
  try {
    const d = db || getDatabase();
    const agents = listAgents(d);
    const textLower = text.toLowerCase();
    for (const agent of agents) {
      const nameLower = agent.name.toLowerCase();
      if (nameLower.length >= 3 && textLower.includes(nameLower)) {
        add(agent.name, "person", 0.95);
      }
    }
  } catch {
    // DB not available, skip agent matching
  }

  // 5. Known projects
  try {
    const d = db || getDatabase();
    const projects = listProjects(d);
    const textLower = text.toLowerCase();
    for (const project of projects) {
      const nameLower = project.name.toLowerCase();
      if (nameLower.length >= 3 && textLower.includes(nameLower)) {
        add(project.name, "project", 0.95);
      }
    }
  } catch {
    // DB not available, skip project matching
  }

  // 6. Technology keywords
  const textLower = text.toLowerCase();
  for (const keyword of TECH_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, "i");
    if (re.test(textLower)) {
      add(keyword, "tool", 0.7);
    }
  }

  // 7. PascalCase identifiers
  for (const match of text.matchAll(PASCAL_CASE_RE)) {
    add(match[1]!, "concept", 0.5);
  }

  // Sort by confidence descending
  return Array.from(entityMap.values()).sort((a, b) => b.confidence - a.confidence);
}
