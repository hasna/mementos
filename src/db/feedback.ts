// ============================================================================
// Feedback domain. Transport-aware: API mode posts to the self-hosted HTTP API;
// local mode inserts into the SQLite `feedback` table.
// ============================================================================

import { SqliteAdapter as Database } from "../storage.js";
import { getDatabase } from "./database.js";
import { isApiMode, apiJson } from "./api-mode.js";

export interface FeedbackInput {
  message: string;
  email?: string | null;
  category?: string | null;
  version?: string | null;
}

export function saveFeedback(input: FeedbackInput, db?: Database): void {
  if (!db && isApiMode()) {
    apiJson("POST", "/feedback", {
      message: input.message,
      email: input.email ?? null,
      category: input.category ?? "general",
      version: input.version ?? null,
    });
    return;
  }
  const d = db || getDatabase();
  d.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
    input.message,
    input.email ?? null,
    input.category ?? "general",
    input.version ?? null,
  ]);
}
