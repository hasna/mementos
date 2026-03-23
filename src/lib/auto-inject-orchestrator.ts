/**
 * Auto-Inject Orchestrator — ties session watcher, context extractor,
 * activation matcher, and channel pusher into a unified pipeline.
 *
 * Flow: session file change → extract context → match memories → push via channel
 *
 * Enable: MEMENTOS_AUTO_INJECT=true + --dangerously-load-development-channels
 */

import { startSessionWatcher, stopSessionWatcher, getWatcherStatus } from "./session-watcher.js";
import { extractContext, resetContext } from "./context-extractor.js";
import { findActivatedMemories, markAsPushed, resetRecentlyPushed, getRecentlyPushedCount } from "./activation-matcher.js";
import { setServerRef, pushMemoryNotification } from "./channel-pusher.js";
import { pushSessionBriefing } from "./session-start-briefing.js";
import { registerSession, heartbeatSession, unregisterSession, cleanStaleSessions } from "./session-registry.js";
import type { SessionMessage } from "./session-watcher.js";

// ============================================================================
// Config
// ============================================================================

export interface AutoInjectConfig {
  enabled: boolean;
  throttle_ms: number;       // Min time between pushes (default 30s)
  debounce_ms: number;       // Wait after last message before processing (default 2s)
  max_pushes_per_5min: number; // Rate limit (default 5)
  min_similarity: number;     // Minimum activation match threshold (default 0.4)
  session_briefing: boolean;  // Push briefing on start (default true)
}

const DEFAULT_CONFIG: AutoInjectConfig = {
  enabled: true,
  throttle_ms: 30_000,
  debounce_ms: 2_000,
  max_pushes_per_5min: 5,
  min_similarity: 0.4,
  session_briefing: true,
};

// ============================================================================
// State
// ============================================================================

let _config: AutoInjectConfig = { ...DEFAULT_CONFIG };
let _running = false;
let _sessionId: string | null = null;
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _lastPushTime = 0;
let _pushCount5min: { ts: number }[] = [];
let _pendingMessages: SessionMessage[] = [];

// Push history for status reporting
const _pushHistory: { timestamp: string; context: string; memory_count: number }[] = [];
const MAX_HISTORY = 20;

// ============================================================================
// Core Pipeline
// ============================================================================

async function processMessages(): Promise<void> {
  if (!_running || !_config.enabled) return;

  // Throttle check
  const now = Date.now();
  if (now - _lastPushTime < _config.throttle_ms) return;

  // Rate limit check
  _pushCount5min = _pushCount5min.filter(p => now - p.ts < 5 * 60 * 1000);
  if (_pushCount5min.length >= _config.max_pushes_per_5min) return;

  // Process all pending messages, find the most significant context
  let bestContext: { context_text: string; tools_mentioned: string[] } | null = null;

  for (const msg of _pendingMessages) {
    const extracted = extractContext(msg);
    if (extracted.is_significant && extracted.context_text.length > 10) {
      // Take the most recent significant context
      bestContext = { context_text: extracted.context_text, tools_mentioned: extracted.tools_mentioned };
    }
  }
  _pendingMessages = [];

  if (!bestContext) return;

  // Find activated memories
  try {
    const memories = await findActivatedMemories(bestContext.context_text, {
      min_similarity: _config.min_similarity,
      max_results: 5,
    });

    if (memories.length === 0) return;

    // Push via channel
    const pushed = await pushMemoryNotification(
      memories,
      bestContext.context_text
    );

    if (pushed) {
      markAsPushed(memories.map(m => m.id));
      _lastPushTime = Date.now();
      _pushCount5min.push({ ts: Date.now() });
      _pushHistory.unshift({
        timestamp: new Date().toISOString(),
        context: bestContext.context_text.slice(0, 200),
        memory_count: memories.length,
      });
      if (_pushHistory.length > MAX_HISTORY) _pushHistory.pop();
    }
  } catch {
    // Non-critical — don't crash the pipeline
  }
}

function onNewMessage(message: SessionMessage): void {
  if (!_running || !_config.enabled) return;

  _pendingMessages.push(message);

  // Debounce — wait for messages to settle before processing
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    void processMessages();
  }, _config.debounce_ms);
}

// ============================================================================
// Lifecycle
// ============================================================================

export interface StartOptions {
  server: any; // McpServer instance
  project_id?: string;
  project_name?: string;
  agent_id?: string;
  agent_name?: string;
  cwd?: string;
  git_root?: string;
  config?: Partial<AutoInjectConfig>;
}

export async function startAutoInject(options: StartOptions): Promise<{
  started: boolean;
  session_id: string | null;
  watcher_file: string | null;
  briefing_pushed: boolean;
}> {
  // Check if enabled
  const envEnabled = process.env["MEMENTOS_AUTO_INJECT"] === "true";
  if (!envEnabled && !options.config?.enabled) {
    return { started: false, session_id: null, watcher_file: null, briefing_pushed: false };
  }

  // Merge config
  _config = { ...DEFAULT_CONFIG, ...options.config };
  if (envEnabled) _config.enabled = true;

  // Set server ref for channel pushing
  setServerRef(options.server);

  // Register in session registry
  const cwd = options.cwd || process.cwd();
  const session = registerSession({
    mcp_server: "mementos",
    agent_name: options.agent_name,
    project_name: options.project_name,
    cwd,
    git_root: options.git_root,
  });
  _sessionId = session.id;

  // Start heartbeat
  _heartbeatInterval = setInterval(() => {
    if (_sessionId) heartbeatSession(_sessionId);
    cleanStaleSessions();
  }, 15_000);

  // Push session-start briefing
  let briefingPushed = false;
  if (_config.session_briefing) {
    try {
      briefingPushed = await pushSessionBriefing({
        project_id: options.project_id,
        project_name: options.project_name,
        agent_id: options.agent_id,
      });
    } catch {
      // Non-critical
    }
  }

  // Start session watcher
  const { sessionFile } = startSessionWatcher(cwd, onNewMessage);

  _running = true;

  return {
    started: true,
    session_id: _sessionId,
    watcher_file: sessionFile,
    briefing_pushed: briefingPushed,
  };
}

export function stopAutoInject(): void {
  _running = false;

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }

  stopSessionWatcher();
  resetContext();
  resetRecentlyPushed();

  if (_sessionId) {
    try { unregisterSession(_sessionId); } catch { /* best effort */ }
    _sessionId = null;
  }

  _pendingMessages = [];
}

export function getAutoInjectConfig(): AutoInjectConfig {
  return { ..._config };
}

export function updateAutoInjectConfig(updates: Partial<AutoInjectConfig>): AutoInjectConfig {
  _config = { ..._config, ...updates };
  return { ..._config };
}

export function getAutoInjectStatus(): {
  running: boolean;
  config: AutoInjectConfig;
  session_id: string | null;
  watcher: { active: boolean; watching_file: string | null; last_offset: number };
  pushes: {
    total: number;
    last_5min: number;
    recently_pushed_memories: number;
    next_available_in_ms: number;
  };
  history: { timestamp: string; context: string; memory_count: number }[];
} {
  const now = Date.now();
  const recent5min = _pushCount5min.filter(p => now - p.ts < 5 * 60 * 1000);
  const nextAvailable = Math.max(0, _config.throttle_ms - (now - _lastPushTime));

  return {
    running: _running,
    config: { ..._config },
    session_id: _sessionId,
    watcher: getWatcherStatus(),
    pushes: {
      total: _pushHistory.length,
      last_5min: recent5min.length,
      recently_pushed_memories: getRecentlyPushedCount(),
      next_available_in_ms: nextAvailable,
    },
    history: [..._pushHistory],
  };
}
