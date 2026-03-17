#!/usr/bin/env bun
/**
 * Codex Session Stop Hook — auto-ingest Codex session transcript into mementos.
 *
 * Install in ~/.codex/config.toml:
 * [hooks]
 * session_end = "bun /path/to/codex-stop-hook.ts"
 *
 * Or install via: mementos session setup-hook --codex
 *
 * Environment variables:
 *   MEMENTOS_URL   — REST server URL (default: http://localhost:19428)
 *   MEMENTOS_AGENT — Agent name to tag memories with
 *   CODEX_SESSION_ID — Override session ID
 */

const MEMENTOS_URL = process.env["MEMENTOS_URL"] ?? "http://localhost:19428";
const MEMENTOS_AGENT = process.env["MEMENTOS_AGENT"];

async function main() {
  let stdinData = "";
  for await (const chunk of Bun.stdin.stream()) {
    stdinData += new TextDecoder().decode(chunk);
  }

  let hookContext: Record<string, unknown> = {};
  try {
    hookContext = JSON.parse(stdinData) as Record<string, unknown>;
  } catch {
    // Codex may pass the transcript as plain text
    hookContext = { transcript: stdinData };
  }

  const sessionId =
    process.env["CODEX_SESSION_ID"] ??
    (hookContext["session_id"] as string) ??
    `codex-${Date.now()}`;

  const workingDir = (hookContext["cwd"] as string) ?? process.cwd();
  const agentName = MEMENTOS_AGENT ?? (hookContext["agent"] as string);

  let transcript = (hookContext["transcript"] as string) ?? stdinData;

  // Codex may provide messages array
  const messages = hookContext["messages"] as Array<{ role: string; content: string }> | undefined;
  if (messages && Array.isArray(messages) && !transcript) {
    transcript = messages
      .map((m) => `[${m.role.toUpperCase()}]\n${m.content}`)
      .join("\n\n---\n\n");
  }

  if (!transcript || transcript.length < 50) {
    process.exit(0);
  }

  try {
    const res = await fetch(`${MEMENTOS_URL}/api/sessions/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        session_id: sessionId,
        source: "codex",
        agent_id: agentName,
        metadata: {
          workingDir,
          agentName,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (res.ok) {
      const data = await res.json() as { job_id: string };
      process.stderr.write(`[mementos] Codex session queued: ${data.job_id}\n`);
    }
  } catch {
    // Silently fail
  }

  process.exit(0);
}

main();
