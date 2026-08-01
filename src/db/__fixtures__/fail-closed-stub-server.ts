// Stub cloud server for api-mode-fail-closed.test.ts.
//
// It MUST run in its own process: the api-mode transport is a blocking
// Bun.spawnSync(curl), so an in-process Bun.serve() can never answer — the
// event loop is held by the spawnSync for the whole request and every call
// times out.
//
// The behaviour is selected by the FIRST path segment, so a single long-lived
// process can serve every case by varying the client's base URL:
//   /not-found/v1/...    → 404 on everything
//   /empty-2xx/v1/...    → 201 with an empty body
//   /created/v1/...      → 201 with a stored row (200 for a GET by id)
//   /stale-patch/v1/...  → 200 on PATCH with the version UNCHANGED (version 1):
//                          a server that accepted the update and wrote nothing
//   /fresh-patch/v1/...  → 200 on PATCH with the version moved on (version 2):
//                          a server that actually performed the write
// It prints "READY <port>" on stdout once listening.

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const mode = url.pathname.split("/").filter(Boolean)[0] ?? "created";
    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (mode === "not-found") return json({ error: "Not found" }, 404);
    if (mode === "empty-2xx") return new Response("", { status: 201 });
    if (mode === "stale-patch" && req.method === "PATCH") {
      // The defect, reproduced exactly: 200 OK, a well-formed row, and the
      // version has not moved because nothing was written.
      return json({ id: "mem-1", key: "k", value: "ORIGINAL", version: 1 }, 200);
    }
    if (mode === "fresh-patch" && req.method === "PATCH") {
      return json({ id: "mem-1", key: "k", value: "REPLACEMENT", version: 2 }, 200);
    }
    if (req.method === "GET") return json({ id: "mem-1", key: "k", value: "v" }, 200);
    return json({ id: "mem-1", key: "k", value: "v" }, 201);
  },
});

console.log(`READY ${server.port}`);
