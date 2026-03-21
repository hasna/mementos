/**
 * Example: OpenAI Agents SDK with mementos memory.
 *
 * Shows how to use mementos as a persistent memory layer for OpenAI agents.
 * Requires: OPENAI_API_KEY env var, mementos-mcp running locally.
 *
 * Usage: bun run examples/openai-agents/agent-with-memory.ts
 */

// This example uses the mementos REST API (mementos-serve must be running on port 19428)
const MEMENTOS_URL = "http://localhost:19428";

async function saveMemory(key: string, value: string, importance: number = 5) {
  const res = await fetch(`${MEMENTOS_URL}/api/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, scope: "shared", importance, source: "agent" }),
  });
  return res.json();
}

async function recallMemory(key: string) {
  const res = await fetch(`${MEMENTOS_URL}/api/memories?search=${encodeURIComponent(key)}&limit=1`);
  const data = await res.json() as { memories: Array<{ key: string; value: string }> };
  return data.memories[0] ?? null;
}

async function searchMemories(query: string) {
  const res = await fetch(`${MEMENTOS_URL}/api/memories/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit: 5 }),
  });
  return res.json();
}

// Example agent loop
async function main() {
  console.log("Saving a memory...");
  await saveMemory("preferred-language", "TypeScript with Bun runtime", 9);

  console.log("Recalling...");
  const mem = await recallMemory("preferred-language");
  console.log("Recalled:", mem);

  console.log("Searching...");
  const results = await searchMemories("TypeScript");
  console.log("Search results:", JSON.stringify(results, null, 2));
}

main().catch(console.error);
