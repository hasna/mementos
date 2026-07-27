// Stub cloud server for clean-legacy-fallback.test.ts.
//
// It MUST run in its own process: the api-mode transport is a blocking
// Bun.spawnSync(curl), so an in-process Bun.serve() can never answer — the
// event loop is held by the spawnSync for the whole request and every call
// times out.
//
// The behaviour is selected by the FIRST path segment, so a single long-lived
// process can serve every case by varying the client's base URL:
//   /legacy/v1/...  → an old server image: 404 on /maintenance/cleanup,
//                     200 on the legacy /memories/clean
//   /full/v1/...    → a current server image: 200 on /maintenance/cleanup
//   /broken/v1/...  → 500 on /maintenance/cleanup (a real failure, not skew)
// It prints "READY <port>" on stdout once listening.

// Marks this file as a module so its top-level `server` is file-scoped rather
// than global — otherwise tsc reports it as a redeclaration of the identically
// named binding in the other fixture stub server.
export {};

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const mode = segments[0] ?? "full";
    const route = `/${segments.slice(2).join("/")}`; // strip /<mode>/v1
    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (route === "/maintenance/cleanup") {
      if (mode === "legacy") return json({ error: "Not found" }, 404);
      if (mode === "broken") return json({ error: "Internal error" }, 500);
      return json(
        { expired: 1, evicted: 2, archived: 3, unused_archived: 4, deprioritized: 5 },
        200
      );
    }
    if (route === "/memories/clean") return json({ cleaned: 7 }, 200);

    return json({ error: "Not found" }, 404);
  },
});

console.log(`READY ${server.port}`);
