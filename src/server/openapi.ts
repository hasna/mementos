/**
 * OpenAPI 3.1 document for mementos-serve, generated from the live route table.
 *
 * Served at `/v1/openapi.json` (and `/openapi.json`). This is the canonical
 * serve contract the SDK targets; because it is derived from the same
 * `routes[]` the router matches, it can never drift from what the server
 * actually exposes.
 */
import { routes } from "./router.js";

/** `/api/memories/:id` -> `/v1/memories/{id}` */
function toV1Path(path: string): string {
  return path.replace(/^\/api/, "/v1").replace(/:(\w+)/g, "{$1}");
}

export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  // Operational probes (registered inline in index.ts, not the route table).
  for (const p of ["/health", "/ready", "/version"]) {
    paths[p] = {
      get: {
        summary: `Service ${p.slice(1)} probe`,
        security: [],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    version: { type: "string" },
                    mode: { type: "string", enum: ["local", "cloud"] },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  for (const route of routes) {
    const p = toV1Path(route.path);
    const method = route.method.toLowerCase();
    const params = route.paramNames.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    paths[p] = paths[p] ?? {};
    (paths[p] as Record<string, unknown>)[method] = {
      summary: `${route.method} ${p}`,
      operationId: `${method}_${p.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      ...(params.length ? { parameters: params } : {}),
      responses: {
        "200": { description: "OK" },
        "401": { description: "Unauthorized" },
        "403": { description: "Forbidden" },
        "404": { description: "Not found" },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "@hasna/mementos serve API",
      version,
      description: "Universal memory system for AI agents — REST API (self_hosted).",
    },
    servers: [{ url: "/v1" }, { url: "/api" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        apiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths,
  };
}
