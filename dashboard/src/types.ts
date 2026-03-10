export type MemoryScope = "global" | "shared" | "private";
export type MemoryCategory = "preference" | "fact" | "knowledge" | "history";
export type MemorySource = "user" | "agent" | "system" | "auto" | "imported";
export type MemoryStatus = "active" | "archived" | "expired";

export interface Memory {
  id: string;
  key: string;
  value: string;
  category: MemoryCategory;
  scope: MemoryScope;
  summary: string | null;
  tags: string[];
  importance: number;
  source: MemorySource;
  status: MemoryStatus;
  pinned: boolean;
  agent_id: string | null;
  project_id: string | null;
  session_id: string | null;
  metadata: Record<string, unknown>;
  access_count: number;
  version: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  accessed_at: string | null;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  role: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  last_seen_at: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  memory_prefix: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryStats {
  total: number;
  by_scope: Record<MemoryScope, number>;
  by_category: Record<MemoryCategory, number>;
  by_status: Record<MemoryStatus, number>;
  by_agent: Record<string, number>;
  pinned_count: number;
  expired_count: number;
}
