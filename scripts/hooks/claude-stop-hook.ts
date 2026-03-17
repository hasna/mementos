#!/usr/bin/env bun
/**
 * Claude Code Stop Hook — auto-ingest session transcript into mementos.
 *
 * Install in your project's .claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/claude-stop-hook.ts" }] }]
 *   }
 * }
 *
 * Or install globally via: mementos session setup-hook --claude
 *
 * The hook reads the Claude Code conversation from stdin (JSON) and posts
 * the transcript to the mementos REST server for async memory extraction.
 *
 * Environment variables:
 *   MEMENTOS_URL   — REST server URL (default: http://localhost:19428)
 *   MEMENTOS_AGENT — Agent name to tag memories with
 */

const MEMENTOS_URL = process.env["MEMENTOS_URL"] ?? "http://localhost:19428";
const MEMENTOS_AGENT = process.env["MEMENTOS_AGENT"];

async function main() {
  // Claude Code Stop hooks receive context via stdin as JSON
  let stdinData = "";
  for await (const chunk of Bun.stdin.stream()) {
    stdinData += new TextDecoder().decode(chunk);
  }

  let hookContext: Record<string, unknown> = {};
  try {
    hookContext = JSON.parse(stdinData) as Record<string, unknown>;
  } catch {
    // stdin may not be JSON in all invocation modes — that's OK
  }

  // Extract session info from Claude Code hook context
  const sessionId = (hookContext["session_id"] as string) ?? `claude-${Date.now()}`;
  const workingDir = (hookContext["cwd"] as string) ?? process.cwd();
  const agentName = MEMENTOS_AGENT ?? (hookContext["agent_name"] as string);

  // Build transcript from the conversation in hookContext
  // Claude Code provides transcript in hook context
  let transcript = "";
  const messages = hookContext["messages"] as Array<{ role: string; content: string }> | undefined;
  if (messages && Array.isArray(messages)) {
    transcript = messages
      .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
      .join("\n\n---\n\n");
  } else if (hookContext["transcript"]) {
    transcript = hookContext["transcript"] as string;
  } else {
    // Fallback: use the raw stdin as transcript
    transcript = stdinData || `Session ended at ${new Date().toISOString()}`;
  }

  if (!transcript || transcript.length < 50) {
    // Too short to extract anything useful
    process.exit(0);
  }

  try {
    const res = await fetch(`${MEMENTOS_URL}/api/sessions/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        session_id: sessionId,
        source: "claude-code",
        agent_id: agentName,
        metadata: {
          workingDir,
          agentName,
          hookContext: Object.keys(hookContext),
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (res.ok) {
      const data = await res.json() as { job_id: string };
      // Write to stderr so it doesn't interfere with Claude Code output
      process.stderr.write(`[mementos] Session queued for memory extraction: ${data.job_id}\n`);
    }
  } catch {
    // Silently fail — never block the Claude Code session from ending
  }

  process.exit(0);
}

main();
