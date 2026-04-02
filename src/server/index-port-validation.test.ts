import { describe, test, expect } from "bun:test";

const CWD = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

async function runServe(
  args: string[],
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/server/index.ts", ...args], {
    cwd: CWD,
    env: { ...process.env, MEMENTOS_DB_PATH: ":memory:", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await Promise.race([
    proc.exited,
    Bun.sleep(3000).then(() => {
      proc.kill();
      return -999;
    }),
  ]);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode };
}

describe("mementos-serve port validation", () => {
  test("fails fast on non-numeric --port value", async () => {
    const { exitCode, stderr } = await runServe(["--port", "abc"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --port value \"abc\"");
  });

  test("fails fast on out-of-range --port value", async () => {
    const { exitCode, stderr } = await runServe(["--port", "70000"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --port value \"70000\"");
  });

  test("fails fast when --port value is missing", async () => {
    const { exitCode, stderr } = await runServe(["--port"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Missing value for --port");
  });

  test("fails fast on invalid PORT env var", async () => {
    const { exitCode, stderr } = await runServe([], { PORT: "nan" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid PORT value \"nan\"");
  });
});
