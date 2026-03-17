/**
 * Open-sessions connector — bridge between open-sessions REST API and mementos.
 *
 * When open-sessions ingests a new session, this connector fetches the session
 * transcript and submits it to mementos for memory extraction.
 *
 * Usage:
 *   const connector = new OpenSessionsConnector({ openSessionsUrl, mementosUrl });
 *   await connector.ingestSession(sessionId, { agentId, projectId });
 *   await connector.syncRecentSessions({ since: "2026-03-17", limit: 10 });
 */

export interface OpenSessionsConnectorConfig {
  /** open-sessions REST API base URL */
  openSessionsUrl: string;
  /** mementos REST API base URL */
  mementosUrl: string;
  /** Optional auth token for open-sessions */
  openSessionsToken?: string;
  /** Default agent ID for extracted memories */
  defaultAgentId?: string;
  /** Default project ID for extracted memories */
  defaultProjectId?: string;
}

export interface IngestResult {
  sessionId: string;
  jobId: string;
  status: "queued" | "skipped" | "error";
  message: string;
}

export class OpenSessionsConnector {
  private config: OpenSessionsConnectorConfig;

  constructor(config: OpenSessionsConnectorConfig) {
    this.config = config;
  }

  /**
   * Fetch a session transcript from open-sessions and ingest into mementos.
   */
  async ingestSession(
    sessionId: string,
    options: { agentId?: string; projectId?: string } = {}
  ): Promise<IngestResult> {
    try {
      // Fetch session from open-sessions
      const transcript = await this.fetchSessionTranscript(sessionId);
      if (!transcript || transcript.length < 50) {
        return { sessionId, jobId: "", status: "skipped", message: "Transcript too short" };
      }

      // Post to mementos ingest endpoint
      const res = await fetch(`${this.config.mementosUrl}/api/sessions/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcript,
          session_id: sessionId,
          source: "open-sessions",
          agent_id: options.agentId ?? this.config.defaultAgentId,
          project_id: options.projectId ?? this.config.defaultProjectId,
          metadata: { openSessionsUrl: this.config.openSessionsUrl },
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "unknown error");
        return { sessionId, jobId: "", status: "error", message: err };
      }

      const data = await res.json() as { job_id: string; message: string };
      return { sessionId, jobId: data.job_id, status: "queued", message: data.message };
    } catch (err) {
      return {
        sessionId,
        jobId: "",
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Fetch and ingest multiple recent sessions.
   */
  async syncRecentSessions(options: {
    since?: string;
    limit?: number;
    agentId?: string;
    projectId?: string;
  } = {}): Promise<IngestResult[]> {
    const sessionIds = await this.listRecentSessionIds(options.since, options.limit ?? 20);
    const results: IngestResult[] = [];

    for (const sessionId of sessionIds) {
      const result = await this.ingestSession(sessionId, {
        agentId: options.agentId,
        projectId: options.projectId,
      });
      results.push(result);
    }

    return results;
  }

  private async fetchSessionTranscript(sessionId: string): Promise<string | null> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.openSessionsToken) {
      headers["Authorization"] = `Bearer ${this.config.openSessionsToken}`;
    }

    const res = await fetch(
      `${this.config.openSessionsUrl}/api/sessions/${sessionId}/transcript`,
      { headers, signal: AbortSignal.timeout(15_000) }
    );

    if (!res.ok) return null;

    const data = await res.json() as { transcript?: string; content?: string; text?: string };
    return data.transcript ?? data.content ?? data.text ?? null;
  }

  private async listRecentSessionIds(since?: string, limit = 20): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.config.openSessionsToken) {
      headers["Authorization"] = `Bearer ${this.config.openSessionsToken}`;
    }

    const params = new URLSearchParams({ limit: String(limit) });
    if (since) params.set("since", since);

    const res = await fetch(
      `${this.config.openSessionsUrl}/api/sessions?${params.toString()}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    );

    if (!res.ok) return [];

    const data = await res.json() as { sessions?: Array<{ id: string }> | string[] };
    const sessions = data.sessions ?? [];

    return sessions.map((s) => (typeof s === "string" ? s : s.id));
  }
}

/**
 * Create a connector from environment variables.
 *
 * OPEN_SESSIONS_URL — open-sessions server URL
 * OPEN_SESSIONS_TOKEN — optional auth token
 * MEMENTOS_URL — mementos server URL (default: http://localhost:19428)
 */
export function connectorFromEnv(): OpenSessionsConnector {
  const openSessionsUrl = process.env["OPEN_SESSIONS_URL"];
  if (!openSessionsUrl) {
    throw new Error("OPEN_SESSIONS_URL environment variable is required");
  }
  return new OpenSessionsConnector({
    openSessionsUrl,
    mementosUrl: process.env["MEMENTOS_URL"] ?? "http://localhost:19428",
    openSessionsToken: process.env["OPEN_SESSIONS_TOKEN"],
    defaultAgentId: process.env["MEMENTOS_AGENT"],
  });
}
