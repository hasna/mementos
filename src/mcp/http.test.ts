process.env["MEMENTOS_DB_PATH"] = ":memory:";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["OPENAI_API_KEY"];
delete process.env["CEREBRAS_API_KEY"];
delete process.env["XAI_API_KEY"];

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./index.js";
import {
  DEFAULT_MCP_HTTP_PORT,
  isHttpMode,
  resolveMcpHttpPort,
  startMcpHttpServer,
} from "./http.js";

const nativeFetch: typeof fetch = (input, init) => Bun.fetch(input, init);

describe("mcp http transport", () => {
  test("defaults port to 8867", () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8867);
    expect(resolveMcpHttpPort(["node"], {})).toBe(8867);
    expect(resolveMcpHttpPort(["node", "--port", "9001"], {})).toBe(9001);
    expect(resolveMcpHttpPort(["node"], { MCP_HTTP_PORT: "9002" })).toBe(9002);
  });

  test("isHttpMode detects flag and env", () => {
    expect(isHttpMode(["node"], {})).toBe(false);
    expect(isHttpMode(["node", "--http"], {})).toBe(true);
    expect(isHttpMode(["node"], { MCP_HTTP: "1" })).toBe(true);
  });
});

describe("mcp buildServer stdio registration", () => {
  test("registers tools over in-memory transport", async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "memory_stats")).toBe(true);

    await client.close();
    await server.close();
  });

  test("memory_list is compact by default and full on request", async () => {
    const server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);

    const tag = `mcp-compact-${Date.now()}`;
    const longValue = "MCP compact output should truncate this large value ".repeat(8) + "MCP_UNTRUNCATED_SENTINEL";
    for (let i = 0; i < 12; i++) {
      await client.callTool({
        name: "memory_save",
        arguments: {
          key: `${tag}-${i}`,
          value: longValue,
          tags: [tag],
          scope: "shared",
        },
      });
    }

    const compact = await client.callTool({
      name: "memory_list",
      arguments: { tags: [tag] },
    });
    const compactText = compact.content?.[0]?.type === "text" ? compact.content[0].text : "";
    expect(compactText).toContain("10+ memories");
    expect(compactText).toContain("Hint:");
    expect(compactText).not.toContain("MCP_UNTRUNCATED_SENTINEL");

    const full = await client.callTool({
      name: "memory_list",
      arguments: { tags: [tag], full: true, limit: 1 },
    });
    const fullText = full.content?.[0]?.type === "text" ? full.content[0].text : "";
    const parsed = JSON.parse(fullText);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].value).toContain("MCP_UNTRUNCATED_SENTINEL");

    await client.close();
    await server.close();
  });
});

describe("mcp streamable http server", () => {
  let handle: Awaited<ReturnType<typeof startMcpHttpServer>>;

  beforeAll(async () => {
    handle = await startMcpHttpServer(buildServer, { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
  });

  test("GET /health returns ok", async () => {
    const res = await nativeFetch(`http://${handle.host}:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", name: "mementos" });
  });

  test("initialize and call memory_stats over streamable HTTP", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${handle.host}:${handle.port}/mcp`),
      { fetch: nativeFetch },
    );
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === "memory_stats")).toBe(true);

    const result = await client.callTool({ name: "memory_stats", arguments: {} });
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);

    await client.close();
  });

  test("serves three concurrent clients from one process", async () => {
    const clients = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://${handle.host}:${handle.port}/mcp`),
          { fetch: nativeFetch },
        );
        const client = new Client({ name: "test", version: "0.0.0" });
        await client.connect(transport);
        const tools = await client.listTools();
        return { client, count: tools.tools.length };
      }),
    );

    expect(clients.every((entry) => entry.count > 0)).toBe(true);
    await Promise.all(clients.map((entry) => entry.client.close()));
  });
});
