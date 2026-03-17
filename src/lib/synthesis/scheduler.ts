import { Database } from "bun:sqlite";
import { getDatabase } from "../../db/database.js";
import {
  createSynthesisRun,
  listSynthesisRuns,
  listSynthesisEvents,
  type SynthesisRun,
} from "../../db/synthesis.js";

// ============================================================================
// Types
// ============================================================================

export interface SchedulerConfig {
  enabled: boolean;
  minMemoriesForTrigger: number;
  minEventsSinceLastRun: number;
  maxRunIntervalHours: number;
  minRunIntervalHours: number;
}

export interface SchedulerState {
  lastRunAt: string | null;
  eventsSinceLastRun: number;
  shouldTrigger: boolean;
  reason: string;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  enabled: true,
  minMemoriesForTrigger: 50,
  minEventsSinceLastRun: 100,
  maxRunIntervalHours: 24,
  minRunIntervalHours: 1,
};

// ============================================================================
// Check trigger
// ============================================================================

export function checkShouldTrigger(
  projectId: string | null,
  config?: Partial<SchedulerConfig>,
  db?: Database
): SchedulerState {
  const d = db || getDatabase();
  const cfg: SchedulerConfig = { ...DEFAULT_SCHEDULER_CONFIG, ...config };

  if (!cfg.enabled) {
    return {
      lastRunAt: null,
      eventsSinceLastRun: 0,
      shouldTrigger: false,
      reason: "Scheduler is disabled",
    };
  }

  // Get the last completed or failed run
  const recentRuns = listSynthesisRuns(
    { project_id: projectId, limit: 1 },
    d
  );
  const lastRun = recentRuns[0] ?? null;
  const lastRunAt = lastRun?.started_at ?? null;

  const nowMs = Date.now();

  // Check minimum interval (at least 1h between runs)
  if (lastRunAt) {
    const lastRunMs = new Date(lastRunAt).getTime();
    const hoursSinceLast = (nowMs - lastRunMs) / (1000 * 60 * 60);

    if (hoursSinceLast < cfg.minRunIntervalHours) {
      return {
        lastRunAt,
        eventsSinceLastRun: 0,
        shouldTrigger: false,
        reason: `Last run was ${hoursSinceLast.toFixed(1)}h ago (minimum ${cfg.minRunIntervalHours}h between runs)`,
      };
    }
  }

  // Count events since last run
  const since = lastRunAt ?? new Date(0).toISOString();
  const eventsFilter: Parameters<typeof listSynthesisEvents>[0] = { since };
  if (projectId) eventsFilter.project_id = projectId;

  const recentEvents = listSynthesisEvents(eventsFilter, d);
  const eventsSinceLastRun = recentEvents.length;

  // Check if we've exceeded max run interval (force trigger)
  if (lastRunAt) {
    const lastRunMs = new Date(lastRunAt).getTime();
    const hoursSinceLast = (nowMs - lastRunMs) / (1000 * 60 * 60);

    if (hoursSinceLast >= cfg.maxRunIntervalHours) {
      return {
        lastRunAt,
        eventsSinceLastRun,
        shouldTrigger: true,
        reason: `Max run interval of ${cfg.maxRunIntervalHours}h exceeded (${hoursSinceLast.toFixed(1)}h since last run)`,
      };
    }
  }

  // Check if we have enough memories to make synthesis worthwhile
  const memoryCount = getMemoryCount(projectId, d);
  if (memoryCount < cfg.minMemoriesForTrigger) {
    return {
      lastRunAt,
      eventsSinceLastRun,
      shouldTrigger: false,
      reason: `Only ${memoryCount} memories (minimum ${cfg.minMemoriesForTrigger} required)`,
    };
  }

  // Check if enough events have accumulated since last run
  if (eventsSinceLastRun < cfg.minEventsSinceLastRun) {
    return {
      lastRunAt,
      eventsSinceLastRun,
      shouldTrigger: false,
      reason: `Only ${eventsSinceLastRun} events since last run (minimum ${cfg.minEventsSinceLastRun} required)`,
    };
  }

  return {
    lastRunAt,
    eventsSinceLastRun,
    shouldTrigger: true,
    reason: `${eventsSinceLastRun} events accumulated, ${memoryCount} memories in corpus`,
  };
}

// ============================================================================
// Trigger if ready
// ============================================================================

export async function triggerIfReady(
  projectId: string | null,
  agentId: string | null,
  config?: Partial<SchedulerConfig>,
  db?: Database
): Promise<SynthesisRun | null> {
  const d = db || getDatabase();
  const state = checkShouldTrigger(projectId, config, d);

  if (!state.shouldTrigger) {
    return null;
  }

  // Count current memories for corpus_size estimate
  const memoryCount = getMemoryCount(projectId, d);

  const run = createSynthesisRun(
    {
      triggered_by: "scheduler",
      project_id: projectId,
      agent_id: agentId,
      corpus_size: memoryCount,
    },
    d
  );

  return run;
}

// ============================================================================
// Helper
// ============================================================================

function getMemoryCount(projectId: string | null, d: Database): number {
  try {
    if (projectId !== null) {
      const row = d
        .query("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active' AND project_id = ?")
        .get(projectId) as { cnt: number } | null;
      return row?.cnt ?? 0;
    } else {
      const row = d
        .query("SELECT COUNT(*) as cnt FROM memories WHERE status = 'active'")
        .get() as { cnt: number } | null;
      return row?.cnt ?? 0;
    }
  } catch {
    return 0;
  }
}
