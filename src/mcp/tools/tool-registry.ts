/**
 * Shared tool registry for MCP tools.
 * Each tool module exports its schemas here. Used by search_tools and describe_tools
 * for tool discovery and documentation.
 */

export interface ToolSchema {
  description: string;
  category: string;
  params: Record<string, {
    type: string;
    description: string;
    required?: boolean;
    enum?: string[];
    items?: { type: string; enum?: string[] };
  }>;
  example?: string;
}

export interface ToolEntry {
  name: string;
  description: string;
  category: string;
}

// Minimal registry - each tool module adds its entries
const registry = new Map<string, ToolSchema>();

export function registerToolSchemas(schemas: Record<string, ToolSchema>): void {
  for (const [name, schema] of Object.entries(schemas)) {
    registry.set(name, schema);
  }
}

export function getAllToolEntries(): ToolEntry[] {
  return Array.from(registry.entries()).map(([name, schema]) => ({
    name,
    description: schema.description,
    category: schema.category,
  }));
}

export function getToolSchema(name: string): ToolSchema | undefined {
  return registry.get(name);
}

export function searchToolEntries(query: string, category?: string): ToolEntry[] {
  const q = query.toLowerCase();
  return Array.from(registry.entries())
    .filter(([name, schema]) => {
      const matchesQuery = name.includes(q) || schema.description.toLowerCase().includes(q);
      const matchesCategory = !category || schema.category === category;
      return matchesQuery && matchesCategory;
    })
    .map(([name, schema]) => ({
      name,
      description: schema.description,
      category: schema.category,
    }));
}
