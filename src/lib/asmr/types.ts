import type { Memory } from "../../types/index.js";

export interface AsmrOptions {
  max_results?: number;
  project_id?: string;
  agent_id?: string;
  include_reasoning?: boolean;
}

export interface AsmrResult {
  memories: AsmrMemoryResult[];
  facts: string[];
  timeline: string[];
  reasoning: string;
  agents_used: string[];
  duration_ms: number;
}

export interface AsmrMemoryResult {
  memory: Memory;
  score: number;
  source_agent: "facts" | "context" | "temporal";
  reasoning: string;
  verbatim_excerpt: string;
}

export interface SearchAgentResult {
  memories: AsmrMemoryResult[];
  reasoning: string;
}
