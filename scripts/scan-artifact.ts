// Pack this repo the way `npm publish` would, then scan what actually shipped.
//
// It scans the TARBALL, never `src/`. Running the scanner against the working
// directory would report on files that may never be published and would miss
// built output that is — so a source-directory scan is a gate that cannot fail
// for the case it exists to catch. The CLI names the two modes `source_tree`
// and `packed_artifact` precisely because they disagree.
//
// Packing uses `--ignore-scripts`: without it, packing from inside `prepack`
// re-enters `prepack` forever.
//
// The scanner is the `contracts` binary from the pinned dependency, not
// `bunx`. An unpinned package runner resolves to whatever is newest at publish
// time, and a resolution failure silently becomes a non-run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${command.join(" ")} exited ${result.exitCode}\n${stdout}\n${stderr}`);
  }
  return stdout;
}

const repoRoot = join(import.meta.dir, "..");
const workspace = mkdtempSync(join(tmpdir(), "mementos-artifact-scan-"));

try {
  const packed = run(["bun", "pm", "pack", "--destination", workspace, "--ignore-scripts", "--quiet"], repoRoot);
  const archive = isAbsolute(packed) ? packed : join(workspace, packed);

  const scanner = join(repoRoot, "node_modules", ".bin", "contracts");
  const result = Bun.spawnSync([scanner, "artifact-scan", archive], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(
      "\nA published artifact must not carry a bulk asset inventory. See @hasna/contracts CONTRACT.md clause B."
    );
    process.exit(result.exitCode ?? 1);
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
