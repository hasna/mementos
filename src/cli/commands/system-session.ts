import type { Command } from "commander";
import chalk from "chalk";

export function registerSessionCommand(program: Command): void {
  // ============================================================================
  // session ingestion commands
  // ============================================================================

  const sessionCmd = program
    .command("session")
    .description("Session auto-memory — ingest session transcripts for memory extraction");

  sessionCmd
    .command("ingest <transcriptFile>")
    .description("Ingest a session transcript file for memory extraction")
    .option("--session-id <id>", "Session ID (default: auto-generated)")
    .option("--agent <id>", "Agent ID")
    .option("--project <id>", "Project ID")
    .option("--source <source>", "Source (claude-code, codex, manual, open-sessions)", "manual")
    .action(async (transcriptFile: string, opts: { sessionId?: string; agent?: string; project?: string; source: string }) => {
      const { readFileSync: _rfs } = await import("node:fs");
      const { createSessionJob } = await import("../../db/session-jobs.js");
      const { enqueueSessionJob } = await import("../../lib/session-queue.js");
      const transcript = _rfs(transcriptFile, "utf-8");
      const sessionId = opts.sessionId ?? `cli-${Date.now()}`;
      const job = createSessionJob({
        session_id: sessionId,
        transcript,
        source: opts.source as "claude-code" | "codex" | "manual" | "open-sessions",
        agent_id: opts.agent,
        project_id: opts.project,
      });
      enqueueSessionJob(job.id);
      console.log(chalk.green(`✓ Session queued: ${chalk.cyan(job.id)}`));
      console.log(`  Session: ${sessionId}`);
      console.log(`  Length:  ${transcript.length} chars`);
    });

  sessionCmd
    .command("status <jobId>")
    .description("Check status of a session extraction job")
    .action(async (jobId: string) => {
      const { getSessionJob } = await import("../../db/session-jobs.js");
      const job = getSessionJob(jobId);
      if (!job) {
        console.error(chalk.red(`Job not found: ${jobId}`));
        process.exit(1);
      }
      const statusColor = job.status === "completed" ? chalk.green : job.status === "failed" ? chalk.red : chalk.yellow;
      console.log(`${chalk.cyan(job.id)} [${statusColor(job.status)}]`);
      console.log(`  Session:   ${job.session_id}`);
      console.log(`  Chunks:    ${job.chunk_count}`);
      console.log(`  Extracted: ${job.memories_extracted} memories`);
      if (job.error) console.log(chalk.red(`  Error: ${job.error}`));
    });

  sessionCmd
    .command("list")
    .description("List session extraction jobs")
    .option("--agent <id>", "Filter by agent")
    .option("--project <id>", "Filter by project")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Max results", "20")
    .action(async (opts: { agent?: string; project?: string; status?: string; limit: string }) => {
      const { listSessionJobs } = await import("../../db/session-jobs.js");
      const jobs = listSessionJobs({
        agent_id: opts.agent,
        project_id: opts.project,
        status: opts.status as "pending" | "processing" | "completed" | "failed" | undefined,
        limit: parseInt(opts.limit),
      });
      if (jobs.length === 0) {
        console.log(chalk.gray("No session jobs found."));
        return;
      }
      for (const job of jobs) {
        const statusColor = job.status === "completed" ? chalk.green : job.status === "failed" ? chalk.red : chalk.yellow;
        console.log(`${chalk.cyan(job.id.slice(0, 8))} [${statusColor(job.status)}] ${job.memories_extracted} memories | ${job.created_at.slice(0, 10)}`);
      }
    });

  sessionCmd
    .command("setup-hook")
    .description("Install mementos session hook into Claude Code or Codex")
    .option("--claude", "Install Claude Code stop hook")
    .option("--codex", "Install Codex session hook")
    .option("--show", "Print hook script instead of installing")
    .action(async (opts: { claude?: boolean; codex?: boolean; show?: boolean }) => {
      const { resolve: _resolve } = await import("node:path");
      const hookPath = _resolve(import.meta.dirname, "../../scripts/hooks");

      if (opts.claude) {
        const script = `${hookPath}/claude-stop-hook.ts`;
        if (opts.show) {
          const { readFileSync: _rfs } = await import("node:fs");
          console.log(_rfs(script, "utf-8"));
          return;
        }
        console.log(chalk.bold("Claude Code stop hook installation:"));
        console.log("");
        console.log("Add to your .claude/settings.json:");
        console.log(chalk.cyan(JSON.stringify({
          hooks: {
            Stop: [{ matcher: "", hooks: [{ type: "command", command: `bun ${script}` }] }],
          },
        }, null, 2)));
        console.log("");
        console.log(`Or run: ${chalk.cyan(`claude hooks add Stop "bun ${script}"`)}`);
      } else if (opts.codex) {
        const script = `${hookPath}/codex-stop-hook.ts`;
        console.log(chalk.bold("Codex session hook installation:"));
        console.log("");
        console.log("Add to ~/.codex/config.toml:");
        console.log(chalk.cyan(`[hooks]\nsession_end = "bun ${script}"`));
      } else {
        console.log("Usage: mementos session setup-hook --claude | --codex");
      }
    });
}
