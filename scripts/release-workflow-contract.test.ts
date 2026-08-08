import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");

function position(fragment: string): number {
  const index = workflow.indexOf(fragment);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("npm release workflow contract", () => {
  test("is scoped to the canonical repository and package-specific tag", () => {
    expect(workflow).toContain('tags:\n      - "npm/mementos/v*"');
    expect(workflow).not.toContain('tags: ["v*"]');
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("group: hasna-mementos-npm-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("if: github.repository == 'hasna/mementos'");
  });

  test("uses OIDC trusted publishing without a token-backed fallback", () => {
    expect(workflow).toContain("environment: npm-release");
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);

    for (const forbidden of [
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "secrets.",
      "_authToken",
      "bun publish",
    ]) {
      expect(workflow).not.toContain(forbidden);
    }
  });

  test("binds the tag, package name, version, ref, and protected main history", () => {
    expect(workflow).toContain('expected_name="@hasna/mementos"');
    expect(workflow).toContain('expected_prefix="npm/mementos/v"');
    expect(workflow).toContain('if [ "${pkg_name}" != "${expected_name}" ]');
    expect(workflow).toContain('if [ "${GITHUB_REF_TYPE}" != "tag" ]');
    expect(workflow).toContain('case "${GITHUB_REF_NAME}" in');
    expect(workflow).toContain('tag_version="${GITHUB_REF_NAME#npm/mementos/v}"');
    expect(workflow).toContain('if [ "${tag_version}" != "${pkg_version}" ]');
    expect(workflow).toContain('git rev-parse "${GITHUB_REF}^{commit}"');
    expect(workflow).toContain(
      "git fetch --no-tags origin main:refs/remotes/origin/main",
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "${GITHUB_SHA}" "refs/remotes/origin/main"',
    );
  });

  test("pins the build toolchain and requires npm trusted-publishing support", () => {
    const uses = [
      ...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm),
    ].map((match) => match[1]);

    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    ]);
    expect(workflow).toContain('node-version: "24.18.0"');
    expect(workflow).toContain('bun-version: "1.3.14"');
    expect(workflow).toContain('need="11.5.1"');
    expect(workflow).toContain("bun install --frozen-lockfile");
  });

  test("runs all release gates before a provenance-bearing publish", () => {
    const bind = position("- name: Bind the tag to the package version");
    const main = position("- name: Require the release commit on protected main");
    const unpublished = position("- name: Reject an already published version");
    const typecheck = position("- name: Typecheck");
    const testStep = position("- name: Test");
    const build = position("- name: Build");
    const publish = position("- name: Publish to npm via OIDC trusted publishing");
    const verify = position(
      "- name: Verify the published version and provenance from the registry",
    );

    expect(bind).toBeLessThan(main);
    expect(main).toBeLessThan(unpublished);
    expect(unpublished).toBeLessThan(typecheck);
    expect(typecheck).toBeLessThan(testStep);
    expect(testStep).toBeLessThan(build);
    expect(build).toBeLessThan(publish);
    expect(publish).toBeLessThan(verify);
    expect(workflow).toContain("run: npm publish --provenance --access public");
  });

  test("fails closed when the pre-publish registry check is not a real miss", () => {
    expect(workflow).toContain("if ! grep -Eq 'code E404|E404'");
    expect(workflow).toContain(
      "refusing to treat it as an unpublished version",
    );
  });

  test("uses a new npm cache for each post-publish registry retry", () => {
    expect(workflow).toContain('cache_dir="$(mktemp -d)"');
    expect(workflow).toContain(
      'npm_config_cache="${cache_dir}" npm view "${name}@${version}" version dist.attestations --json',
    );
    expect(workflow).toContain("https://slsa.dev/provenance/v1");
    expect(workflow).toContain("for attempt in 1 2 3 4 5");
    expect(workflow).toContain("sleep 10");
    expect(workflow).toContain('rm -rf "${cache_dir}"');
  });
});
