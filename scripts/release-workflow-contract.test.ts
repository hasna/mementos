import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
};

type WorkflowJob = {
  if?: string;
  environment?: string;
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: {
    push?: {
      tags?: string[];
    };
  };
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
};

const workflowPath = new URL("../.github/workflows/release.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const publish = workflow.jobs?.publish;

function steps(): WorkflowStep[] {
  expect(publish).toBeDefined();
  expect(Array.isArray(publish?.steps)).toBe(true);
  return publish?.steps ?? [];
}

function namedStep(name: string): WorkflowStep {
  const step = steps().find((candidate) => candidate.name === name);
  expect(step, `missing workflow step: ${name}`).toBeDefined();
  return step ?? {};
}

function command(name: string): string {
  const run = namedStep(name).run;
  expect(typeof run).toBe("string");
  return run ?? "";
}

describe("npm release workflow contract", () => {
  test("is scoped to the canonical repository and package-specific tag", () => {
    expect(workflow.on?.push?.tags).toEqual(["npm/mementos/v*"]);
    expect(workflow.concurrency).toEqual({
      group: "hasna-mementos-npm-release",
      "cancel-in-progress": false,
    });
    expect(publish?.if).toBe("github.repository == 'hasna/mementos'");
  });

  test("uses OIDC only for publication and isolates the dist-tag credential", () => {
    expect(publish?.environment).toBe("npm-release");
    expect(publish?.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(publish?.env?.NPM_DIST_TAG_TOKEN_CONFIGURED).toBe(
      "${{ secrets.NPM_DIST_TAG_TOKEN != '' }}",
    );

    const staged = namedStep("Publish preserved candidate under version quarantine");
    expect(staged.env).toBeUndefined();
    expect(staged.run).toContain("release-provenance.ts publish-staged");
    expect(staged.run).not.toContain("NODE_AUTH_TOKEN");
    expect(staged.run).not.toContain("NPM_DIST_TAG_TOKEN");

    const promote = namedStep("Promote the verified version to latest");
    expect(Object.keys(promote.env ?? {})).toEqual(["NODE_AUTH_TOKEN"]);
    expect(promote.env?.NODE_AUTH_TOKEN).toMatch(
      /^\$\{\{\s*secrets\.NPM_DIST_TAG_TOKEN\s*\}\}$/,
    );
    expect(promote.run).toContain("release-provenance.ts promote");
  });

  test("pins the build toolchain and official actions", () => {
    const uses = steps()
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string");

    expect(uses).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
    ]);
  });

  test("binds one preserved tarball through quarantine, verification, and promotion", () => {
    const candidate = command("Bind and preserve the deterministic release candidate");
    const preflight = command("Reconcile an interrupted publication");
    const staged = command("Publish preserved candidate under version quarantine");
    const verifyStaged = command(
      "Verify quarantined registry bytes, provenance, signatures, and CLI",
    );
    const promote = command("Promote the verified version to latest");
    const verifyPromoted = command("Verify final dist-tag and artifact agreement");

    expect(candidate).toContain("release-provenance.ts candidate");
    expect(candidate).toContain("--artifact \"$RUNNER_TEMP/release-candidate.tgz\"");
    expect(candidate).toContain("--out \"$RUNNER_TEMP/release-candidate.json\"");
    expect(preflight).toContain("release-provenance.ts ensure-unpublished");
    expect(staged).toContain("release-provenance.ts publish-staged");
    expect(verifyStaged).toContain("release-provenance.ts verify-registry");
    expect(verifyStaged).toContain("--phase staged");
    expect(promote).toContain("release-provenance.ts promote");
    expect(verifyPromoted).toContain("release-provenance.ts verify-registry");
    expect(verifyPromoted).toContain("--phase promoted");

    const order = steps().map((step) => step.name);
    expect(order.indexOf("Bind and preserve the deterministic release candidate"))
      .toBeLessThan(order.indexOf("Reconcile an interrupted publication"));
    expect(order.indexOf("Reconcile an interrupted publication"))
      .toBeLessThan(order.indexOf("Publish preserved candidate under version quarantine"));
    expect(order.indexOf("Publish preserved candidate under version quarantine"))
      .toBeLessThan(
        order.indexOf(
          "Verify quarantined registry bytes, provenance, signatures, and CLI",
        ),
      );
    expect(
      order.indexOf(
        "Verify quarantined registry bytes, provenance, signatures, and CLI",
      ),
    ).toBeLessThan(order.indexOf("Promote the verified version to latest"));
    expect(order.indexOf("Promote the verified version to latest"))
      .toBeLessThan(order.indexOf("Verify final dist-tag and artifact agreement"));
  });

  test("contains no direct publish command or long-lived publication fallback", () => {
    expect(workflowSource).not.toMatch(/run:\s*npm publish/m);
    expect(workflowSource).not.toContain("bun publish");
    expect(workflowSource).not.toContain("secrets.NPM_TOKEN");
    expect(workflowSource).not.toContain("secrets.NODE_AUTH_TOKEN");
    expect(workflowSource).not.toContain("_authToken");
  });
});
