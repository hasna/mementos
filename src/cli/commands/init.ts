import type { Command } from "commander";
import chalk from "chalk";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("One-command setup: register MCP, install stop hook, configure auto-start")
    .action(async () => {
      const { platform } = process;
      const home = homedir();
      const isMac = platform === "darwin";

      console.log("");
      console.log(chalk.bold("  mementos — setting up your memory layer"));
      console.log("");

      // -----------------------------------------------------------------------
      // Helper: run a command and capture stdout+stderr
      // -----------------------------------------------------------------------
      async function run(cmd: string[]): Promise<{ ok: boolean; output: string }> {
        try {
          const proc = Bun.spawn(cmd, {
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, err, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          return { ok: exitCode === 0, output: (out + err).trim() };
        } catch (e) {
          return { ok: false, output: e instanceof Error ? e.message : String(e) };
        }
      }

      // -----------------------------------------------------------------------
      // Step 1: Register MCP with Claude Code
      // -----------------------------------------------------------------------
      let mcpAlreadyInstalled = false;
      let mcpError: string | null = null;

      try {
        const list = await run(["claude", "mcp", "list"]);
        if (list.output.includes("mementos")) {
          mcpAlreadyInstalled = true;
        } else {
          const add = await run([
            "claude", "mcp", "add",
            "--transport", "stdio",
            "--scope", "user",
            "mementos", "--", "mementos-mcp",
          ]);
          if (!add.ok) {
            mcpError = add.output || "unknown error";
          }
        }
      } catch (e) {
        mcpError = e instanceof Error ? e.message : String(e);
      }

      if (mcpAlreadyInstalled) {
        console.log(chalk.dim("  · MCP already registered"));
      } else if (mcpError) {
        console.log(chalk.red(`  ✗ Failed to register MCP: ${mcpError}`));
        console.log(chalk.dim("    (Is Claude Code installed? Try: claude mcp add --transport stdio --scope user mementos -- mementos-mcp)"));
      } else {
        console.log(chalk.green("  ✓ MCP server registered with Claude Code"));
      }

      // -----------------------------------------------------------------------
      // Step 2: Install Stop hook
      // -----------------------------------------------------------------------
      const hooksDir = join(home, ".claude", "hooks");
      const hookDest = join(hooksDir, "mementos-stop-hook.ts");
      const settingsPath = join(home, ".claude", "settings.json");
      const hookCommand = `bun ${hookDest}`;

      let hookAlreadyInstalled = false;
      let hookError: string | null = null;

      try {
        // Check if already in settings.json
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          try {
            settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
          } catch {
            settings = {};
          }
        }

        const hooksObj = (settings["hooks"] || {}) as Record<string, unknown>;
        const stopHooks = (hooksObj["Stop"] || []) as Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string }> }>;
        const alreadyHasMementos = stopHooks.some((entry) =>
          entry.hooks?.some((h) => h.command && h.command.includes("mementos"))
        );

        if (alreadyHasMementos) {
          hookAlreadyInstalled = true;
        } else {
          // Copy the hook script if needed
          if (!existsSync(hooksDir)) {
            mkdirSync(hooksDir, { recursive: true });
          }

          if (!existsSync(hookDest)) {
            // Try to find the hook source from the installed package
            const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
            const candidatePaths = [
              join(packageDir, "scripts", "hooks", "claude-stop-hook.ts"),
              join(packageDir, "..", "scripts", "hooks", "claude-stop-hook.ts"),
              join(home, ".bun", "install", "global", "node_modules", "@hasna", "mementos", "scripts", "hooks", "claude-stop-hook.ts"),
            ];

            let hookSourceFound = false;
            for (const src of candidatePaths) {
              if (existsSync(src)) {
                copyFileSync(src, hookDest);
                hookSourceFound = true;
                break;
              }
            }

            if (!hookSourceFound) {
              // Embed the minimal hook inline
              const inlineHook = `#!/usr/bin/env bun
const MEMENTOS_URL = process.env["MEMENTOS_URL"] ?? "http://localhost:19428";
const MEMENTOS_AGENT = process.env["MEMENTOS_AGENT"];

async function main() {
  let stdinData = "";
  try {
    for await (const chunk of Bun.stdin.stream()) {
      stdinData += new TextDecoder().decode(chunk);
    }
  } catch { /* stdin may be closed */ }

  if (!stdinData.trim()) return;

  let payload: unknown;
  try { payload = JSON.parse(stdinData); } catch { return; }

  try {
    await fetch(\`\${MEMENTOS_URL}/api/sessions/ingest\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: payload,
        agent: MEMENTOS_AGENT,
        source: "claude-stop-hook",
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* server not running — silently skip */ }
}

main().catch(() => {});
`;
              writeFileSync(hookDest, inlineHook, "utf-8");
            }
          }

          // Patch settings.json
          const newStopEntry = {
            matcher: "",
            hooks: [{ type: "command", command: hookCommand }],
          };
          hooksObj["Stop"] = [...stopHooks, newStopEntry];
          settings["hooks"] = hooksObj;
          writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        }
      } catch (e) {
        hookError = e instanceof Error ? e.message : String(e);
      }

      if (hookAlreadyInstalled) {
        console.log(chalk.dim("  · Stop hook already installed"));
      } else if (hookError) {
        console.log(chalk.red(`  ✗ Failed to install stop hook: ${hookError}`));
      } else {
        console.log(chalk.green("  ✓ Stop hook installed (sessions → memories)"));
      }

      // -----------------------------------------------------------------------
      // Step 3: Install launchd auto-start (macOS only)
      // -----------------------------------------------------------------------
      let autoStartAlreadyInstalled = false;
      let autoStartError: string | null = null;

      if (!isMac) {
        console.log(chalk.dim(`  · Auto-start skipped (not macOS — platform: ${platform})`));
      } else {
        const plistPath = join(home, "Library", "LaunchAgents", "com.hasna.mementos.plist");
        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hasna.mementos</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>PATH="$HOME/.bun/bin:$PATH" mementos-serve</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/mementos.log</string>
  <key>StandardOutPath</key>
  <string>/tmp/mementos.log</string>
</dict>
</plist>
`;

        try {
          if (existsSync(plistPath)) {
            autoStartAlreadyInstalled = true;
          } else {
            const launchAgentsDir = join(home, "Library", "LaunchAgents");
            if (!existsSync(launchAgentsDir)) {
              mkdirSync(launchAgentsDir, { recursive: true });
            }
            writeFileSync(plistPath, plistContent, "utf-8");
          }
        } catch (e) {
          autoStartError = e instanceof Error ? e.message : String(e);
        }

        if (autoStartAlreadyInstalled) {
          console.log(chalk.dim("  · Auto-start already configured"));
        } else if (autoStartError) {
          console.log(chalk.red(`  ✗ Failed to configure auto-start: ${autoStartError}`));
        } else {
          console.log(chalk.green("  ✓ Auto-start configured (starts on login)"));
        }

        // Step 4: Load the plist
        if (!autoStartAlreadyInstalled && !autoStartError) {
          const plistPath2 = join(home, "Library", "LaunchAgents", "com.hasna.mementos.plist");
          const loadResult = await run(["launchctl", "load", plistPath2]);
          if (!loadResult.ok) {
            console.log(chalk.dim(`  · launchctl load: ${loadResult.output || "already loaded"}`));
          }
        }
      }

      // -----------------------------------------------------------------------
      // Step 5: Check if server is running
      // -----------------------------------------------------------------------
      let serverRunning = false;
      try {
        const res = await fetch("http://127.0.0.1:19428/api/health", {
          signal: AbortSignal.timeout(1500),
        });
        serverRunning = res.ok;
      } catch { /* not running */ }

      if (serverRunning) {
        console.log(chalk.green("  ✓ Server running on http://127.0.0.1:19428"));
      } else {
        console.log(chalk.dim("  · Server not yet running — it will start automatically on next login"));
        console.log(chalk.dim("    (Or start it now: mementos-serve)"));
      }

      // -----------------------------------------------------------------------
      // Summary
      // -----------------------------------------------------------------------
      console.log("");
      console.log(chalk.bold("  You're all set. Restart Claude Code to activate."));
      console.log("");
      console.log("  Quick start:");
      console.log(`    ${chalk.cyan('mementos save "my-preference" "I prefer bun over npm"')}`);
      console.log(`    ${chalk.cyan("mementos list")}`);
      console.log(`    ${chalk.cyan("mementos doctor")}`);
      console.log("");
    });
}
