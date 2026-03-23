/**
 * Session Watcher — watches the active Claude Code session JSONL file
 * for new messages. Enables proactive memory injection by detecting
 * what the agent is working on in real-time.
 */

import { watch, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import type { FSWatcher } from "node:fs";

export interface SessionMessage {
  role: "user" | "assistant" | "tool";
  content: string | { type: string; text?: string; name?: string; input?: Record<string, unknown> }[];
  tool_use?: { name: string; input: Record<string, unknown> }[];
  timestamp: string;
}

export type MessageCallback = (message: SessionMessage) => void;

// Encode CWD to match Claude Code's project directory naming
function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

// Find the Claude projects directory
function getProjectsDir(): string {
  const home = process.env["HOME"] || process.env["USERPROFILE"] || "~";
  return join(home, ".claude", "projects");
}

// Find the most recently modified .jsonl file in the project dir
function findActiveSession(projectDir: string): string | null {
  if (!existsSync(projectDir)) return null;

  const files = readdirSync(projectDir)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => ({
      name: f,
      path: join(projectDir, f),
      mtime: statSync(join(projectDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.path || null;
}

let _watcher: FSWatcher | null = null;
let _lastOffset = 0;
let _watchedFile: string | null = null;
let _callback: MessageCallback | null = null;
let _pollInterval: ReturnType<typeof setInterval> | null = null;

function processNewLines(filePath: string, callback: MessageCallback): void {
  try {
    const stat = statSync(filePath);
    if (stat.size <= _lastOffset) return;

    // Read new bytes from last offset
    const content = readFileSync(filePath, "utf-8");
    const newContent = content.slice(_lastOffset);
    _lastOffset = stat.size;

    // Parse each new line
    const lines = newContent.split("\n").filter(l => l.trim());
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message;
        if (!msg) continue;

        const sessionMsg: SessionMessage = {
          role: msg.role || "user",
          content: msg.content || "",
          timestamp: new Date().toISOString(),
        };

        // Extract tool_use from content array
        if (Array.isArray(msg.content)) {
          const toolUses = msg.content
            .filter((c: any) => c.type === "tool_use")
            .map((c: any) => ({ name: c.name, input: c.input }));
          if (toolUses.length > 0) {
            sessionMsg.tool_use = toolUses;
          }
        }

        callback(sessionMsg);
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // File read error — non-critical
  }
}

export function startSessionWatcher(cwd: string, callback: MessageCallback): { sessionFile: string | null } {
  stopSessionWatcher();

  const projectDir = join(getProjectsDir(), encodeCwd(cwd));
  const sessionFile = findActiveSession(projectDir);

  if (!sessionFile) {
    return { sessionFile: null };
  }

  _watchedFile = sessionFile;
  _callback = callback;
  _lastOffset = statSync(sessionFile).size; // Start from current end (don't replay history)

  // Use fs.watch for file change detection
  try {
    _watcher = watch(sessionFile, () => {
      if (_callback && _watchedFile) {
        processNewLines(_watchedFile, _callback);
      }
    });
  } catch {
    // fs.watch may not work on all platforms — fall back to polling
  }

  // Also poll every 2 seconds as backup (fs.watch can be unreliable)
  _pollInterval = setInterval(() => {
    if (_callback && _watchedFile) {
      processNewLines(_watchedFile, _callback);
    }
  }, 2000);

  return { sessionFile };
}

export function stopSessionWatcher(): void {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
  _watchedFile = null;
  _callback = null;
  _lastOffset = 0;
}

export function getWatcherStatus(): {
  active: boolean;
  watching_file: string | null;
  last_offset: number;
} {
  return {
    active: _watcher !== null || _pollInterval !== null,
    watching_file: _watchedFile,
    last_offset: _lastOffset,
  };
}
