import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// ============================================================================
// Regression: `mementos clean` in API mode must keep its version-skew fallback.
//
// runCleanupViaApi() prefers the full retention sweep (POST
// /maintenance/cleanup) and falls back to the legacy expired-only endpoint
// (POST /memories/clean) when the server predates the full route and answers
// 404. Making apiJson() fail closed on 404 by default silently killed that
// fallback: the first call threw, so the `status !== 404` guard and the legacy
// call below it became unreachable and every scheduled `mementos clean` against
// a not-yet-redeployed server exited 1.
//
// The failing input is driven end-to-end: a stub that 404s /maintenance/cleanup
// and 200s /memories/clean — exactly a server image built before the full route
// landed. The current-server and hard-failure paths are asserted too, so the
// 404 pass-through cannot be widened into "swallow every error".
// ============================================================================

const CLI_PATH = new URL("./index.tsx", import.meta.url).pathname;

/** Behaviour is chosen per-test by pointing the client at a mode path segment. */
type Mode = "legacy" | "full" | "broken";

let stub: ReturnType<typeof Bun.spawn>;
let stubPort = 0;

/** Base URL that makes the stub answer with `mode`. */
function baseFor(mode: Mode): string {
  return `http://127.0.0.1:${stubPort}/${mode}`;
}

beforeAll(async () => {
  // Separate process on purpose — see the fixture header.
  stub = Bun.spawn(["bun", "run", `${import.meta.dir}/__fixtures__/clean-fallback-stub-server.ts`], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = stub.stdout.getReader();
  const deadline = Date.now() + 10_000;
  let buffered = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += new TextDecoder().decode(value);
    const match = buffered.match(/READY (\d+)/);
    if (match) {
      stubPort = Number(match[1]);
      break;
    }
  }
  reader.releaseLock();
  if (!stubPort) throw new Error(`stub server did not start: ${buffered}`);
});

afterAll(() => {
  stub?.kill();
});

async function runClean(
  mode: Mode
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // API mode engages only when no DSN is present on the client.
  for (const k of [
    "HASNA_MEMENTOS_DATABASE_URL",
    "MEMENTOS_DATABASE_URL",
    "HASNA_MEMENTOS_STORAGE_MODE",
    "MEMENTOS_STORAGE_MODE",
    "MEMENTOS_API_URL",
    "MEMENTOS_API_KEY",
  ]) {
    delete env[k];
  }
  env["HASNA_MEMENTOS_API_URL"] = baseFor(mode);
  env["HASNA_MEMENTOS_API_KEY"] = "stub-key-not-a-secret";

  const proc = Bun.spawn(["bun", "run", CLI_PATH, "clean", "--json"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("mementos clean: legacy-server fallback in API mode", () => {
  test("FAILING INPUT: a 404 on /maintenance/cleanup falls back to /memories/clean", async () => {
    const { stdout, exitCode } = await runClean("legacy");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as { expired: number; evicted: number };
    expect(result.expired).toBe(7);
    expect(result.evicted).toBe(0);
  });

  test("a current server still gets the full retention sweep", async () => {
    const { stdout, exitCode } = await runClean("full");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as Record<string, number>;
    expect(result["expired"]).toBe(1);
    expect(result["evicted"]).toBe(2);
    expect(result["archived"]).toBe(3);
    expect(result["unused_archived"]).toBe(4);
    expect(result["deprioritized"]).toBe(5);
  });

  test("a non-404 failure on /maintenance/cleanup still fails closed", async () => {
    const { stdout, exitCode } = await runClean("broken");
    expect(exitCode).toBe(1);
    const result = JSON.parse(stdout) as { error?: string };
    expect(result.error).toContain("500");
  });
});
