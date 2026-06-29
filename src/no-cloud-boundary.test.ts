import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenPackages = ["@hasna/" + "cloud", "open-" + "cloud", "@hasna/" + "wallets"];

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "dashboard", ".git"].includes(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    files.push(fullPath);
  }
  return files;
}

describe("no private cloud package boundary", () => {
  test("package metadata, docs, and lockfiles do not depend on private cloud packages", () => {
    const offenders = ["package.json", "bun.lock", "README.md"]
      .map((file) => [file, readIfExists(join(repoRoot, file))] as const)
      .flatMap(([file, content]) =>
        forbiddenPackages.filter((pkg) => content.includes(pkg)).map((pkg) => `${file}:${pkg}`)
      );

    expect(offenders).toEqual([]);
  });

  test("runtime source does not import private cloud packages", () => {
    const offenders = sourceFiles(join(repoRoot, "src")).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return forbiddenPackages
        .filter((pkg) => content.includes(pkg))
        .map((pkg) => `${file.replace(`${repoRoot}/`, "")}:${pkg}`);
    });

    expect(offenders).toEqual([]);
  });
});
