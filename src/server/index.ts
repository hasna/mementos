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

import { matchRoute } from "./router.js";
import { CORS_HEADERS, getCorsHeaders, json, errorResponse, resolveDashboardDir, serveStaticFile, authenticateRequest } from "./helpers.js";

async function findFreePort(start: number): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => {
      resolve(findFreePort(start + 1));
    });
    server.listen(start, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        server.close(() => resolve(address.port));
      } else {
        resolve(start);
      }
    });
  });
}

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


let _serverInitialized = false;

function initServer(): void {
  if (_serverInitialized) return;
  _serverInitialized = true;
  loadWebhooksFromDb();
  startSessionQueueWorker();
}

export function startServer(port: number, attempt = 0): void {
  const maxRetries = 100;
  initServer();

  const hostname = process.env["MEMENTOS_HOST"] ?? "127.0.0.1";
  try {
    Bun.serve({
      port,
      hostname,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;

      // CORS preflight — only allow configured origin
      if (req.method === "OPTIONS") {
        const origin = req.headers.get("origin");
        const allowedOrigin = process.env["MEMENTOS_CORS_ORIGIN"] ?? "http://localhost:19428";
        if (!origin || origin !== allowedOrigin) {
          return new Response(null, { status: 403 });
        }
        return new Response(null, { status: 204, headers: getCorsHeaders(req) });
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

      // Auth gate for all /api/* routes (except health)
      if (pathname.startsWith("/api/") && pathname !== "/api/health") {
        const authError = authenticateRequest(req);
        if (authError) return authError;
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
        return errorResponse("Internal server error", 500);
      }
    },
  });

  console.log(`Mementos server listening on http://${hostname}:${port}`);
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err.code === "EADDRINUSE" && attempt < maxRetries) {
      const nextPort = port + attempt + 1;
      console.log(`Port ${port} in use, trying ${nextPort}`);
      startServer(nextPort, attempt + 1);
    } else {
      throw e;
    }
  }
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
