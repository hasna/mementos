/**
 * Memory system benchmarking.
 * Measures save/search/recall latency and throughput.
 */

import { Database } from "bun:sqlite";
import { getDatabase } from "../db/database.js";
import { createMemory, getMemoryByKey, listMemories } from "../db/memories.js";
import { searchMemories } from "./search.js";

export interface BenchResult {
  save_latency_ms: number;
  recall_latency_ms: number;
  search_latency_ms: number;
  list_latency_ms: number;
  total_memories: number;
  operations_per_second: number;
}

/**
 * Run a simple benchmark against the local DB.
 */
export async function runBench(
  options: { count?: number } = {},
  db?: Database
): Promise<BenchResult> {
  const d = db || getDatabase();
  const count = options.count || 100;

  // Benchmark saves
  const saveStart = performance.now();
  for (let i = 0; i < count; i++) {
    createMemory(
      {
        key: `bench-${i}-${Date.now()}`,
        value: `Benchmark memory value #${i} with some content for realistic sizing`,
        category: "knowledge",
        scope: "private",
        importance: Math.ceil(Math.random() * 10),
        tags: ["benchmark"],
      },
      "create",
      d
    );
  }
  const saveEnd = performance.now();
  const saveLatency = (saveEnd - saveStart) / count;

  // Benchmark recall
  const recallStart = performance.now();
  for (let i = 0; i < Math.min(count, 50); i++) {
    getMemoryByKey(`bench-${i}-${Date.now() - 1000}`, undefined, undefined, undefined, undefined, d);
  }
  const recallEnd = performance.now();
  const recallLatency = (recallEnd - recallStart) / Math.min(count, 50);

  // Benchmark search
  const searchStart = performance.now();
  for (let i = 0; i < 10; i++) {
    searchMemories("benchmark memory content", { limit: 20 }, d);
  }
  const searchEnd = performance.now();
  const searchLatency = (searchEnd - searchStart) / 10;

  // Benchmark list
  const listStart = performance.now();
  for (let i = 0; i < 10; i++) {
    listMemories({ limit: 50 }, d);
  }
  const listEnd = performance.now();
  const listLatency = (listEnd - listStart) / 10;

  const totalOps = count + Math.min(count, 50) + 10 + 10;
  const totalTimeMs = (saveEnd - saveStart) + (recallEnd - recallStart) + (searchEnd - searchStart) + (listEnd - listStart);
  const opsPerSec = (totalOps / totalTimeMs) * 1000;

  // Cleanup benchmark data
  d.run("DELETE FROM memories WHERE key LIKE 'bench-%'");

  const totalMemories = (d.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;

  return {
    save_latency_ms: Math.round(saveLatency * 100) / 100,
    recall_latency_ms: Math.round(recallLatency * 100) / 100,
    search_latency_ms: Math.round(searchLatency * 100) / 100,
    list_latency_ms: Math.round(listLatency * 100) / 100,
    total_memories: totalMemories,
    operations_per_second: Math.round(opsPerSec),
  };
}
