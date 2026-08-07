import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Read the package version from source or either bundled output layout. */
export function getMementosPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "..", "package.json"),
    join(here, "..", "package.json"),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version;
    } catch {
      // Try the next supported source/bundle layout.
    }
  }
  return "0.0.0";
}
