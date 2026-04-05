import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CORS headers
// ============================================================================

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env["MEMENTOS_CORS_ORIGIN"] ?? "http://localhost:19428",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

// ============================================================================
// MIME types
// ============================================================================

export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ============================================================================
// Response helpers
// ============================================================================

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function errorResponse(
  message: string,
  status: number,
  details?: unknown
): Response {
  const body: Record<string, unknown> = { error: message };
  if (details !== undefined) body["details"] = details;
  return json(body, status);
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

// ============================================================================
// Authentication
// ============================================================================

export function getCorsHeaders(req?: Request): Record<string, string> {
  const allowedOrigin = process.env["MEMENTOS_CORS_ORIGIN"] ?? "http://localhost:19428";
  const origin = req?.headers.get("origin");
  // If origin matches, echo it; otherwise use the configured default
  const finalOrigin = origin === allowedOrigin ? origin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": finalOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export function authenticateRequest(req: Request): Response | null {
  const requiredKey = process.env["MEMENTOS_API_KEY"];
  if (!requiredKey) return null; // no key configured, allow all

  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized. Provide a Bearer token in the Authorization header." }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(req) },
    });
  }

  const provided = authHeader.slice("Bearer ".length);
  if (provided !== requiredKey) {
    return new Response(JSON.stringify({ error: "Forbidden. Invalid API key." }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...getCorsHeaders(req) },
    });
  }

  return null; // authenticated
}

export function getSearchParams(url: URL): Record<string, string> {
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

// ============================================================================
// Dashboard static file helpers
// ============================================================================

export function resolveDashboardDir(): string {
  const candidates: string[] = [];
  try {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(scriptDir, "..", "dashboard", "dist"));
    candidates.push(join(scriptDir, "..", "..", "dashboard", "dist"));
  } catch { /* ignore */ }
  if (process.argv[1]) {
    const mainDir = dirname(process.argv[1]);
    candidates.push(join(mainDir, "..", "dashboard", "dist"));
    candidates.push(join(mainDir, "..", "..", "dashboard", "dist"));
  }
  candidates.push(join(process.cwd(), "dashboard", "dist"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return join(process.cwd(), "dashboard", "dist");
}

export function serveStaticFile(filePath: string): Response | null {
  if (!existsSync(filePath)) return null;
  const ct = MIME_TYPES[extname(filePath)] || "application/octet-stream";
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": ct },
  });
}
