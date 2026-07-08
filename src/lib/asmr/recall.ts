// ============================================================================
// Transport-aware deep recall (ASMR). The ASMR orchestrator runs three
// SQL-backed search agents against a store, so it needs a live DB. In API mode
// the client has no DB, so deep recall runs on the self-hosted server via a
// dedicated endpoint; in local/server mode it runs against getDatabase().
// ============================================================================

import { asmrRecall } from "./orchestrator.js";
import type { AsmrOptions, AsmrResult } from "./types.js";
import { getDatabase } from "../../db/database.js";
import { isApiMode, apiJson } from "../../db/api-mode.js";

export async function deepRecall(
  query: string,
  opts: AsmrOptions = {},
): Promise<AsmrResult> {
  if (isApiMode()) {
    const { data } = apiJson<AsmrResult>("POST", "/memories/recall/deep", { query, ...opts });
    return (
      data ?? {
        memories: [],
        facts: [],
        timeline: [],
        reasoning: "",
        agents_used: [],
        duration_ms: 0,
      }
    );
  }
  return asmrRecall(getDatabase(), query, opts);
}
