#!/usr/bin/env bun
/**
 * Mementos REST API server.
 * Usage: mementos-serve [--port 19428]
 */

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getActiveProfile, listProfiles, getDbPath } from "../lib/config.js";
import { getDatabase } from "../db/database.js";
import { loadWebhooksFromDb } from "../lib/built-in-hooks.js";
import { startSessionQueueWorker } from "../lib/session-queue.js";

import { routes, matchRoute } from "./router.js";
import { CORS_HEADERS, json, errorResponse, resolveDashboardDir, serveStaticFile } from "./helpers.js";

// Self-registering route modules — importing them causes addRoute() calls to execute
import "./routes/memories.js";
import "./routes/agents.js";
import "./routes/projects.js";
import "./routes/entities.js";
import "./routes/system.js";

// ============================================================================
// Config
// ============================================================================

const DEFAULT_PORT = 19428;

function hasFlag(...flags: string[]): boolean {
  return process.argv.some((arg) => flags.includes(arg));
}

function printHelp(): void {
  process.stdout.write(
    `Usage: mementos-serve [options]

Mementos REST API server.

Options:
  --port <number>  Port to bind (default: 19428)
  -h, --help       Show help
  -V, --version    Show version
`
  );
}

function parsePortNumber(raw: string, source: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${source} value "${raw}". Expected an integer between 1 and 65535.`);
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ${source} value "${raw}". Expected an integer between 1 and 65535.`);
  }

  return parsed;
}

function parsePort(): number {
  const envPort = process.env["PORT"];
  if (envPort) {
    return parsePortNumber(envPort, "PORT");
  }

  const portArg = process.argv.find(
    (a) => a === "--port" || a.startsWith("--port=")
  );
  if (portArg) {
    if (portArg.includes("=")) {
      const raw = portArg.split("=")[1] ?? "";
      if (!raw) throw new Error("Missing value for --port. Example: --port 19428");
      return parsePortNumber(raw, "--port");
    }

    const idx = process.argv.indexOf(portArg);
    const raw = process.argv[idx + 1];
    if (!raw || raw.startsWith("-")) {
      throw new Error("Missing value for --port. Example: --port 19428");
    }

    return parsePortNumber(raw, "--port");
  }

  return DEFAULT_PORT;
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port < start + 100; port++) {
    try {
      const server = Bun.serve({ port, fetch: () => new Response("") });
      server.stop(true);
      return port;
    } catch {
      // Port in use, try next
    }
  }
  return start;
}

export function startServer(port: number): void {
  // Load persisted webhooks into the in-memory hook registry
  loadWebhooksFromDb();
  // Start the session memory job background worker
  startSessionQueueWorker();

  const hostname = process.env["MEMENTOS_HOST"] ?? "127.0.0.1";
  Bun.serve({
    port,
    hostname,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // Health check
      if (pathname === "/api/health" || pathname === "/health") {
        const profile = getActiveProfile();
        const { createRequire } = await import("node:module");
        const req = createRequire(import.meta.url);
        const pkg = req("../../package.json") as { version: string };
        // Enrich with memory metrics for meaningful health assessment
        const db = getDatabase();
        const total = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active'").get() as { c: number }).c;
        const expired = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'expired' OR (expires_at IS NOT NULL AND expires_at < datetime('now'))").get() as { c: number }).c;
        const pinned = (db.query("SELECT COUNT(*) as c FROM memories WHERE status = 'active' AND pinned = 1").get() as { c: number }).c;
        const agents = (db.query("SELECT COUNT(*) as c FROM agents").get() as { c: number }).c;
        const projects = (db.query("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c;
        const status = expired > 50 ? "warn" : "ok";
        return json({ status, version: pkg.version, profile: profile ?? "default", db_path: getDbPath(), hostname, memories: { total, expired, pinned }, agents, projects });
      }

      // Profile info
      if (pathname === "/api/profile" && req.method === "GET") {
        const profile = getActiveProfile();
        return json({ active: profile ?? null, profiles: listProfiles(), db_path: getDbPath() });
      }

      // SSE stream for live memory updates
      if (pathname === "/api/memories/stream" && req.method === "GET") {
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            let lastSeen = new Date().toISOString();

            const send = (data: unknown) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };

            // Send initial ping
            send({ type: "connected", timestamp: lastSeen });

            const interval = setInterval(() => {
              try {
                const db = getDatabase();
                const rows = db
                  .query(
                    "SELECT * FROM memories WHERE updated_at > ? OR created_at > ? ORDER BY updated_at DESC LIMIT 50"
                  )
                  .all(lastSeen, lastSeen) as Record<string, unknown>[];

                if (rows.length > 0) {
                  lastSeen = new Date().toISOString();
                  send({ type: "memories", data: rows, count: rows.length });
                }
              } catch {
                // ignore polling errors
              }
            }, 1000);

            // Cleanup on close
            req.signal.addEventListener("abort", () => {
              clearInterval(interval);
              controller.close();
            });
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS_HEADERS,
          },
        });
      }

      // Route matching
      const matched = matchRoute(req.method, pathname);
      if (!matched) {
        // API routes always return JSON 404
        if (pathname.startsWith("/api/")) {
          return errorResponse("Not found", 404);
        }
        // Serve dashboard static files for non-API routes
        const dashDir = resolveDashboardDir();
        if (existsSync(dashDir) && (req.method === "GET" || req.method === "HEAD")) {
          if (pathname !== "/") {
            // Path traversal guard: resolved path must stay within dashDir
            const resolvedDash = resolve(dashDir) + sep;
            const requestedPath = resolve(join(dashDir, pathname));
            if (requestedPath.startsWith(resolvedDash)) {
              const staticRes = serveStaticFile(requestedPath);
              if (staticRes) return staticRes;
            }
          }
          // SPA fallback — serve index.html
          const indexRes = serveStaticFile(join(dashDir, "index.html"));
          if (indexRes) return indexRes;
        }
        return errorResponse("Not found", 404);
      }

      try {
        return await matched.handler(req, url, matched.params);
      } catch (e) {
        console.error(`[mementos-serve] ${req.method} ${pathname}:`, e);
        const message =
          e instanceof Error ? e.message : "Internal server error";
        return errorResponse(message, 500);
      }
    },
  });

  console.log(`Mementos server listening on http://${hostname}:${port}`);
}

async function main(): Promise<void> {
  if (hasFlag("--help", "-h")) {
    printHelp();
    return;
  }

  if (hasFlag("--version", "-V")) {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  const requestedPort = parsePort();
  const port = await findFreePort(requestedPort);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} in use, using ${port}`);
  }
  startServer(port);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mementos-serve] ${message}`);
  process.exit(1);
});
