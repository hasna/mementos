import type { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  readFileSync,
  existsSync,
  accessSync,
  statSync,
  constants as fsConstants,
} from "node:fs";
import { getDatabase, getDbPath } from "../../db/database.js";
import { listMemories } from "../../db/memories.js";
import { listAgents } from "../../db/agents.js";
import { listProjects } from "../../db/projects.js";
import { loadConfig, getActiveProfile, listProfiles } from "../../lib/config.js";
import { outputJson, getPackageVersion, type GlobalOpts } from "../helpers.js";

async function runCommandWithTimeout(
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdoutPromise = new Response(proc.stdout).text().catch(() => "");
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  let timedOut = false;
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<null>((resolve) =>
      setTimeout(() => {
        timedOut = true;
        proc.kill();
        resolve(null);
      }, timeoutMs)
    ),
  ]);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return { stdout, stderr, exitCode, timedOut };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose common issues with the mementos installation")
    .action(async () => {
      const globalOpts = program.opts<GlobalOpts>();
      const checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[] = [];

      // 1. Version
      const version = getPackageVersion();
      checks.push({ name: "Version", status: "ok", detail: version });

      // 2. DB connectivity
      const dbPath = getDbPath();
      let db: ReturnType<typeof getDatabase> | null = null;
      if (dbPath !== ":memory:" && existsSync(dbPath)) {
        try {
          accessSync(dbPath, fsConstants.R_OK | fsConstants.W_OK);
          checks.push({ name: "Database file", status: "ok", detail: dbPath });
        } catch {
          checks.push({ name: "Database file", status: "fail", detail: `Not readable/writable: ${dbPath}` });
        }
      } else if (dbPath === ":memory:") {
        checks.push({ name: "Database file", status: "ok", detail: "in-memory database" });
      } else {
        checks.push({ name: "Database file", status: "warn", detail: `Not found: ${dbPath} (will be created on first use)` });
      }

      try {
        db = getDatabase();
        checks.push({ name: "Database connection", status: "ok", detail: "Connected" });
      } catch (e) {
        checks.push({ name: "Database connection", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 3. DB file size
      try {
        if (dbPath !== ":memory:" && existsSync(dbPath)) {
          const stats = statSync(dbPath);
          const sizeKb = (stats.size / 1024).toFixed(1);
          const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
          const label = stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${sizeKb} KB`;
          checks.push({ name: "DB file size", status: "ok", detail: label });
        } else if (dbPath === ":memory:") {
          checks.push({ name: "DB file size", status: "ok", detail: "in-memory database" });
        }
      } catch {
        checks.push({ name: "DB file size", status: "warn", detail: "Could not read file size" });
      }

      // 4. Config file
      try {
        loadConfig();
        checks.push({ name: "Config", status: "ok", detail: "valid" });
      } catch (e) {
        checks.push({ name: "Config", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      if (!db) {
        checks.push({ name: "Data checks", status: "fail", detail: "Skipped — database not available" });
        outputDoctorResults(globalOpts, checks);
        process.exitCode = 1;
        return;
      }

      // 5. Schema version
      try {
        const migRow = db.query("SELECT MAX(id) as max_id FROM _migrations").get() as { max_id: number | null } | null;
        const schemaVersion = migRow?.max_id ?? 0;
        checks.push({ name: "Schema version", status: schemaVersion > 0 ? "ok" : "warn", detail: `v${schemaVersion}` });
      } catch (e) {
        checks.push({ name: "Schema version", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 6. Memory counts with scope breakdown, expired, and stale
      try {
        const all = listMemories(undefined, db);
        const total = all.length;
        checks.push({ name: "Memories", status: "ok", detail: `${total} total` });

        const byScope: Record<string, number> = {};
        let expiredCount = 0;
        let staleCount = 0;
        const now = Date.now();
        const staleThreshold = 14 * 24 * 60 * 60 * 1000; // 14 days

        for (const m of all) {
          byScope[m.scope] = (byScope[m.scope] || 0) + 1;
          if (m.status === "expired") expiredCount++;
          const lastAccess = m.accessed_at
            ? new Date(m.accessed_at).getTime()
            : new Date(m.created_at).getTime();
          if (now - lastAccess > staleThreshold && m.status === "active") {
            staleCount++;
          }
        }

        const scopeParts = Object.entries(byScope)
          .map(([s, c]) => `${s}: ${c}`)
          .join(", ");
        if (scopeParts) {
          checks.push({ name: "  By scope", status: "ok", detail: scopeParts });
        }

        checks.push({
          name: "  Expired",
          status: expiredCount > 10 ? "warn" : "ok",
          detail: expiredCount > 10 ? `${expiredCount} (run 'mementos clean' to remove)` : String(expiredCount),
        });

        checks.push({
          name: "  Stale (14+ days)",
          status: staleCount > 10 ? "warn" : "ok",
          detail: String(staleCount),
        });
      } catch (e) {
        checks.push({ name: "Memories", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 7. Orphaned tags
      try {
        const orphanedTags = (db.query(
          "SELECT COUNT(*) as c FROM memory_tags WHERE memory_id NOT IN (SELECT id FROM memories)"
        ).get() as { c: number }).c;
        checks.push({
          name: "Orphaned tags",
          status: orphanedTags > 0 ? "warn" : "ok",
          detail: orphanedTags > 0 ? `${orphanedTags} orphaned tag(s)` : "None",
        });
      } catch (e) {
        checks.push({ name: "Orphaned tags", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 8. Agent count
      try {
        const agents = listAgents(db);
        checks.push({ name: "Agents", status: "ok", detail: String(agents.length) });
      } catch (e) {
        checks.push({ name: "Agents", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 9. Project count
      try {
        const projects = listProjects(db);
        checks.push({ name: "Projects", status: "ok", detail: String(projects.length) });
      } catch (e) {
        checks.push({ name: "Projects", status: "fail", detail: e instanceof Error ? e.message : String(e) });
      }

      // 10. Active profile
      try {
        const activeProfile = getActiveProfile();
        const profiles = listProfiles();
        if (activeProfile) {
          checks.push({ name: "Active profile", status: "ok", detail: `${activeProfile} (${profiles.length} total)` });
        } else {
          checks.push({ name: "Active profile", status: "ok", detail: `default (~/.hasna/mementos/mementos.db) — ${profiles.length} profile(s) available` });
        }
      } catch (e) {
        checks.push({ name: "Active profile", status: "warn", detail: e instanceof Error ? e.message : String(e) });
      }

      // 11. REST server reachability (live check)
      try {
        const mementosUrl = process.env["MEMENTOS_URL"] || `http://127.0.0.1:19428`;
        let serverStatus: "ok" | "warn" = "warn";
        let serverDetail = `${mementosUrl} — not reachable (run 'mementos-serve' to start)`;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 1000);
          const res = await fetch(`${mementosUrl}/api/health`, { signal: controller.signal });
          clearTimeout(timeout);
          if (res.ok) {
            const data = await res.json() as { version?: string; status?: string };
            serverStatus = "ok";
            serverDetail = `${mementosUrl} — running v${data.version || "?"} (${data.status || "ok"})`;
          }
        } catch { /* not running */ }
        checks.push({ name: "REST server", status: serverStatus, detail: serverDetail });
      } catch {
        checks.push({ name: "REST server", status: "warn", detail: "Could not check REST server" });
      }

      // 12. MCP registered with Claude Code
      try {
        const { stdout: mcpOut, exitCode: mcpExit, timedOut } = await runCommandWithTimeout(
          ["claude", "mcp", "list"],
          1500
        );
        if (timedOut) {
          checks.push({ name: "MCP server", status: "warn", detail: "health check timed out" });
        } else if (mcpExit === 0 && mcpOut.includes("mementos")) {
          checks.push({ name: "MCP server", status: "ok", detail: "registered with Claude Code" });
        } else if (mcpExit !== 0) {
          checks.push({ name: "MCP server", status: "warn", detail: "claude not installed or not accessible" });
        } else {
          checks.push({ name: "MCP server", status: "warn", detail: "not registered  →  run: mementos init" });
        }
      } catch {
        checks.push({ name: "MCP server", status: "warn", detail: "could not check (is claude CLI installed?)" });
      }

      // 13. Stop hook installed
      try {
        const settingsFilePath = join(homedir(), ".claude", "settings.json");
        if (existsSync(settingsFilePath)) {
          const settings = JSON.parse(readFileSync(settingsFilePath, "utf-8")) as Record<string, unknown>;
          const hooksObj = (settings["hooks"] || {}) as Record<string, unknown>;
          const stopHooks = (hooksObj["Stop"] || []) as Array<{ hooks?: Array<{ command?: string }> }>;
          const hasMementos = stopHooks.some((e) =>
            e.hooks?.some((h) => h.command && h.command.includes("mementos"))
          );
          checks.push({
            name: "Stop hook",
            status: hasMementos ? "ok" : "warn",
            detail: hasMementos ? "installed (sessions → memories)" : "not installed  →  run: mementos init",
          });
        } else {
          checks.push({ name: "Stop hook", status: "warn", detail: "~/.claude/settings.json not found  →  run: mementos init" });
        }
      } catch {
        checks.push({ name: "Stop hook", status: "warn", detail: "could not check stop hook" });
      }

      // 14. Auto-start configured (macOS launchd)
      if (process.platform === "darwin") {
        const plistFilePath = join(homedir(), "Library", "LaunchAgents", "com.hasna.mementos.plist");
        checks.push({
          name: "Auto-start",
          status: existsSync(plistFilePath) ? "ok" : "warn",
          detail: existsSync(plistFilePath)
            ? "configured (starts on login)"
            : "not configured  →  run: mementos init",
        });
      } else {
        checks.push({ name: "Auto-start", status: "ok", detail: `n/a on ${process.platform}` });
      }

      outputDoctorResults(globalOpts, checks);
    });
}

function outputDoctorResults(
  globalOpts: GlobalOpts,
  checks: { name: string; status: "ok" | "warn" | "fail"; detail: string }[],
): void {
  if (globalOpts.json) {
    outputJson({ checks, healthy: checks.every((c) => c.status === "ok") });
  } else {
    console.log(chalk.bold("\nmementos doctor\n"));
    for (const check of checks) {
      const icon =
        check.status === "ok"
          ? chalk.green("\u2713")
          : check.status === "warn"
            ? chalk.yellow("\u26A0")
            : chalk.red("\u2717");
      console.log(`  ${icon} ${chalk.bold(check.name)}: ${check.detail}`);
    }
    const healthy = checks.every((c) => c.status === "ok");
    const warnings = checks.filter((c) => c.status === "warn").length;
    const failures = checks.filter((c) => c.status === "fail").length;
    console.log("");
    if (healthy) {
      console.log(chalk.green("  All checks passed."));
    } else {
      if (failures > 0) console.log(chalk.red(`  ${failures} check(s) failed.`));
      if (warnings > 0) console.log(chalk.yellow(`  ${warnings} warning(s).`));
    }
    console.log("");
  }
}
