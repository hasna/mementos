import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditArguments,
  assertDeterministicPacks,
  assertExactCliVersion,
  createInstallPackumentReader,
  createOriginPackumentReader,
  GITHUB_ACTIONS_OIDC_ISSUER,
  extractVerifiedAttestations,
  installArguments,
  NPM_INSTALL_ACCEPT,
  packagePurl,
  packumentListsVersion,
  parseRetryOptions,
  promoteArguments,
  promoteLatestMonotonically,
  promotionSnapshot,
  PROVENANCE_PREDICATE,
  PUBLISH_PREDICATE,
  publishArguments,
  releaseCertificateIdentityPolicy,
  releaseTag,
  repositorySlug,
  resolvePublicationState,
  type ReleaseCandidate,
  stagingDistTag,
  verifyAttestations,
  verifyCandidateArtifact,
  verifyDistTags,
  verifyDownloadedTarball,
  verifyDeterministicPack,
  verifyRegistryArtifactMetadata,
  verifyRegistryMetadata,
  verifyRegistryRelease,
  verifySigstoreBundleWithNode,
  waitForInstallVisibility,
} from "./release-provenance";
import { describe, expect, test } from "bun:test";

const bytes = Buffer.from("reviewed mementos release candidate");
const digestHex = createHash("sha512").update(bytes).digest("hex");

const candidate: ReleaseCandidate = {
  schema: "hasna.mementos.release-candidate/v1",
  name: "@hasna/mementos",
  version: "0.14.76",
  tag: "npm/mementos/v0.14.76",
  commit: "a".repeat(40),
  repository: "hasna/mementos",
  workflow: ".github/workflows/release.yml",
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  shasum: createHash("sha1").update(bytes).digest("hex"),
  filename: "hasna-mementos-0.14.76.tgz",
  size: bytes.length,
  fileCount: 12,
  unpackedBytes: 4096,
  artifactPath: "/tmp/release-candidate.tgz",
  stagingTag: "release-candidate-0.14.76",
  intendedTag: "latest",
};

function versionMetadata(
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = {
    name: candidate.name,
    version: candidate.version,
    gitHead: candidate.commit,
    dist: {
      integrity: candidate.integrity,
      shasum: candidate.shasum,
      fileCount: candidate.fileCount,
      unpackedSize: candidate.unpackedBytes,
      tarball:
        "https://registry.npmjs.org/@hasna/mementos/-/mementos-0.14.76.tgz",
      attestations: {
        url:
          "https://registry.npmjs.org/-/npm/v1/attestations/@hasna%2fmementos@0.14.76",
        provenance: { predicateType: PROVENANCE_PREDICATE },
      },
    },
  };
  return { ...base, ...changes };
}

function packageMetadata(
  phase: "staged" | "promoted",
  versions = ["0.14.75", candidate.version],
  latest = phase === "promoted" ? candidate.version : "0.14.75",
): Record<string, unknown> {
  return {
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        version === candidate.version
          ? versionMetadata()
          : { name: candidate.name, version },
      ]),
    ),
    "dist-tags": {
      latest,
      [candidate.stagingTag]: candidate.version,
    },
  };
}

function attestation(
  predicateType: string,
  statement: Record<string, unknown>,
): Record<string, unknown> {
  return {
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        tlogEntries: [{ logIndex: "1", integratedTime: "2" }],
      },
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        signatures: [{ sig: "reviewed-by-npm-audit" }],
      },
    },
  };
}

function attestations(options: {
  commit?: string;
  repository?: string;
  workflow?: string;
  tag?: string;
  subject?: string;
  publishName?: string;
} = {}): unknown[] {
  const subject = [
    {
      name:
        options.subject ?? packagePurl(candidate.name, candidate.version),
      digest: { sha512: digestHex },
    },
  ];
  return [
    attestation(PUBLISH_PREDICATE, {
      _type: "https://in-toto.io/Statement/v0.1",
      predicateType: PUBLISH_PREDICATE,
      subject,
      predicate: {
        name: options.publishName ?? candidate.name,
        version: candidate.version,
        registry: "https://registry.npmjs.org",
      },
    }),
    attestation(PROVENANCE_PREDICATE, {
      _type: "https://in-toto.io/Statement/v1",
      predicateType: PROVENANCE_PREDICATE,
      subject,
      predicate: {
        buildDefinition: {
          buildType:
            "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
          externalParameters: {
            workflow: {
              repository: `https://github.com/${
                options.repository ?? candidate.repository
              }`,
              path: options.workflow ?? candidate.workflow,
              ref: `refs/tags/${options.tag ?? candidate.tag}`,
            },
          },
          resolvedDependencies: [
            {
              uri: `git+https://github.com/${candidate.repository}@refs/tags/${candidate.tag}`,
              digest: {
                gitCommit: options.commit ?? candidate.commit,
              },
            },
          ],
        },
        runDetails: {
          builder: {
            id: "https://github.com/actions/runner/github-hosted",
          },
          metadata: {
            invocationId:
              "https://github.com/hasna/mementos/actions/runs/123/attempts/1",
          },
        },
      },
    }),
  ];
}

function auditResult(bundles = attestations()): Record<string, unknown> {
  return {
    invalid: [],
    missing: [],
    verified: [
      {
        name: candidate.name,
        version: candidate.version,
        location: `node_modules/${candidate.name}`,
        attestationBundles: bundles,
      },
    ],
  };
}

interface CertificatePolicy {
  certificateIssuer: string;
  certificateIdentityURI: string;
}

function certificateVerifier(
  certificateIdentity =
    "https://github.com/hasna/mementos/.github/workflows/release.yml@refs/tags/npm/mementos/v0.14.76",
  certificateIssuer = GITHUB_ACTIONS_OIDC_ISSUER,
) {
  const calls: CertificatePolicy[] = [];
  return {
    calls,
    verify: async (
      _bundle: unknown,
      policy: CertificatePolicy,
    ): Promise<void> => {
      calls.push(policy);
      if (certificateIssuer !== policy.certificateIssuer) {
        throw new Error("certificate issuer mismatch");
      }
      if (!new RegExp(policy.certificateIdentityURI).test(certificateIdentity)) {
        throw new Error("certificate identity mismatch");
      }
    },
  };
}

function pack(integrity = candidate.integrity) {
  return {
    name: candidate.name,
    version: candidate.version,
    filename: candidate.filename,
    integrity,
    shasum: candidate.shasum,
    size: candidate.size,
    files: [
      { path: "package.json", size: 100, mode: 0o644 },
      { path: "dist/cli/index.js", size: 300, mode: 0o755 },
    ],
  };
}

describe("release candidate identity and command binding", () => {
  test("derives the canonical repository, tag, staging tag, and purl", () => {
    const manifest = {
      name: candidate.name,
      version: candidate.version,
      repository: { url: "git+https://github.com/hasna/mementos.git" },
    };
    expect(repositorySlug(manifest)).toBe(candidate.repository);
    expect(releaseTag(manifest)).toBe(candidate.tag);
    expect(stagingDistTag(candidate.version)).toBe(candidate.stagingTag);
    expect(packagePurl(candidate.name, candidate.version)).toBe(
      "pkg:npm/%40hasna/mementos@0.14.76",
    );
  });

  test("binds publication to the reviewed artifact and quarantine tag", () => {
    expect(publishArguments(candidate)).toEqual([
      "publish",
      candidate.artifactPath,
      "--ignore-scripts",
      "--provenance",
      "--access",
      "public",
      "--tag",
      candidate.stagingTag,
      "--registry",
      "https://registry.npmjs.org",
    ]);
    expect(promoteArguments(candidate, candidate.version)).toEqual([
      "dist-tag",
      "add",
      `${candidate.name}@${candidate.version}`,
      "latest",
      "--registry",
      "https://registry.npmjs.org",
    ]);
  });

  test("rejects changed deterministic metadata and changed preserved bytes", () => {
    expect(() =>
      assertDeterministicPacks(pack(), pack(), bytes, bytes),
    ).not.toThrow();
    expect(() =>
      assertDeterministicPacks(pack(), pack("sha512-wrong"), bytes, bytes),
    ).toThrow("different artifacts");
    expect(() =>
      assertDeterministicPacks(
        pack(),
        pack(),
        bytes,
        Buffer.from("changed candidate"),
      ),
    ).toThrow("different tarball bytes");
  });

  test("preserves lifecycle hooks in the tarball without executing them", () => {
    const root = mkdtempSync(join(tmpdir(), "mementos-release-fixture-"));
    const artifact = join(root, "candidate.tgz");
    const commit = "b".repeat(40);
    const manifest = {
      name: "@hasna/release-fixture",
      version: "1.2.3",
      repository: "https://github.com/hasna/release-fixture",
      files: ["dist", "optional-missing"],
      scripts: {
        build: 'node -e "process.exit(0)"',
        prepare: 'node -e "process.exit(37)"',
        prepack: 'node -e "process.exit(38)"',
        postinstall: 'node -e "process.exit(0)"',
      },
    };
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "index.js"), "export const ok = true;\n");
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    try {
      const packed = verifyDeterministicPack(root, artifact, commit);
      expect(packed.name).toBe(manifest.name);
      const packedManifest = spawnSync(
        "tar",
        ["-xOzf", artifact, "package/package.json"],
        { encoding: "utf8" },
      );
      expect(packedManifest.status).toBe(0);
      expect(JSON.parse(packedManifest.stdout)).toEqual({
        ...manifest,
        gitHead: commit,
      });
      const fixtureCandidate: ReleaseCandidate = {
        ...candidate,
        name: manifest.name,
        version: manifest.version,
        tag: "npm/release-fixture/v1.2.3",
        commit,
        repository: "hasna/release-fixture",
        integrity: packed.integrity,
        shasum: packed.shasum,
        filename: packed.filename,
        size: packed.size,
        fileCount: packed.files.length,
        unpackedBytes: packed.files.reduce((sum, file) => sum + file.size, 0),
        artifactPath: artifact,
        stagingTag: "release-candidate-1.2.3",
      };
      expect(verifyCandidateArtifact(fixtureCandidate).length).toBe(packed.size);
      expect(() =>
        verifyCandidateArtifact({
          ...fixtureCandidate,
          commit: "c".repeat(40),
        }),
      ).toThrow("gitHead");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("registry bytes and resumable publication", () => {
  test("requires exact registry source, integrity, size, and provenance metadata", () => {
    expect(() =>
      verifyRegistryMetadata(candidate, versionMetadata()),
    ).not.toThrow();
    expect(() =>
      verifyRegistryMetadata(candidate, versionMetadata({ gitHead: "f".repeat(40) })),
    ).toThrow("gitHead");
    expect(() =>
      verifyRegistryMetadata(candidate, {
        ...versionMetadata(),
        dist: {
          ...(versionMetadata().dist as Record<string, unknown>),
          integrity: "sha512-wrong",
        },
      }),
    ).toThrow("integrity");
    expect(() =>
      verifyRegistryMetadata(candidate, {
        ...versionMetadata(),
        dist: {
          ...(versionMetadata().dist as Record<string, unknown>),
          fileCount: candidate.fileCount + 1,
        },
      }),
    ).toThrow("fileCount");
    expect(() =>
      verifyRegistryMetadata(candidate, {
        ...versionMetadata(),
        dist: {
          ...(versionMetadata().dist as Record<string, unknown>),
          attestations: {
            url:
              "https://registry.npmjs.org/-/npm/v1/attestations/@hasna%2fother@0.14.76",
            provenance: { predicateType: PROVENANCE_PREDICATE },
          },
        },
      }),
    ).toThrow("attestations URL disagrees");
  });

  test("separates immutable artifact identity from later provenance visibility", () => {
    const dist = {
      ...(versionMetadata().dist as Record<string, unknown>),
    };
    delete dist.attestations;
    const artifactOnly = { ...versionMetadata(), dist };
    expect(() =>
      verifyRegistryArtifactMetadata(candidate, artifactOnly),
    ).not.toThrow();
    expect(() => verifyRegistryMetadata(candidate, artifactOnly)).toThrow(
      "registry attestations",
    );
  });

  test("redownloads and hashes the registry tarball locally", () => {
    expect(() => verifyDownloadedTarball(candidate, bytes)).not.toThrow();
    expect(() =>
      verifyDownloadedTarball(candidate, Buffer.from("foreign bytes")),
    ).toThrow("reviewed pack");
  });

  test("accepts only absent, exact staged, or exact promoted state", async () => {
    const absent = {
      readVersionMetadata: async () => {
        throw new Error("must not read");
      },
      readPackageMetadata: async () =>
        packageMetadata("staged", ["0.14.75"]),
      readTarball: async () => {
        throw new Error("must not read");
      },
    };
    expect(
      await resolvePublicationState(
        candidate,
        { status: 404, ok: false },
        absent,
      ),
    ).toBe("unpublished");

    const operations = (phase: "staged" | "promoted") => ({
      readVersionMetadata: async () => versionMetadata(),
      readPackageMetadata: async () => packageMetadata(phase),
      readTarball: async () => bytes,
    });
    expect(
      await resolvePublicationState(
        candidate,
        { status: 200, ok: true },
        operations("staged"),
      ),
    ).toBe("staged");
    expect(
      await resolvePublicationState(
        candidate,
        { status: 200, ok: true },
        operations("promoted"),
      ),
    ).toBe("promoted");

    await expect(
      resolvePublicationState(
        candidate,
        { status: 200, ok: true },
        {
          ...operations("staged"),
          readTarball: async () => Buffer.from("foreign bytes"),
        },
      ),
    ).rejects.toThrow("not this candidate");
  });

  test("keeps staging and intended tags separate until verified promotion", () => {
    expect(() =>
      verifyDistTags(candidate, packageMetadata("staged"), "staged"),
    ).not.toThrow();
    expect(() =>
      verifyDistTags(candidate, packageMetadata("promoted"), "promoted"),
    ).not.toThrow();
    expect(() =>
      verifyDistTags(candidate, packageMetadata("promoted"), "staged"),
    ).toThrow("promoted before");
    expect(() =>
      verifyDistTags(candidate, packageMetadata("staged"), "promoted"),
    ).toThrow("does not agree");
  });
});

describe("full and abbreviated packument gates", () => {
  test("uses the npm install accept header for the abbreviated packument", async () => {
    let accept = "";
    const reader = createInstallPackumentReader(
      candidate.name,
      async (_input, init) => {
        accept = new Headers(init?.headers).get("accept") ?? "";
        return new Response(
          JSON.stringify({ versions: { [candidate.version]: {} } }),
          { status: 200 },
        );
      },
    );
    expect(packumentListsVersion(await reader(), candidate.version)).toBe(true);
    expect(accept).toBe(NPM_INSTALL_ACCEPT);
  });

  test("nonce-busts full packument reads and refuses a reused nonce", async () => {
    const urls: string[] = [];
    let count = 0;
    const reader = createOriginPackumentReader(candidate.name, {
      nonce: () => `read-${++count}`,
      fetcher: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(packageMetadata("staged")), {
          status: 200,
        });
      },
    });
    await reader();
    await reader();
    expect(urls[0]).toContain("_hasna_origin_read=read-1");
    expect(urls[1]).toContain("_hasna_origin_read=read-2");

    const reused = createOriginPackumentReader(candidate.name, {
      nonce: () => "same",
      fetcher: async () =>
        new Response(JSON.stringify(packageMetadata("staged")), {
          status: 200,
        }),
    });
    await reused();
    await expect(reused()).rejects.toThrow("nonce was reused");
  });

  test("waits for install visibility and fails closed at the bound", async () => {
    const reads = [
      { versions: {} },
      { versions: { [candidate.version]: {} } },
    ];
    let now = 0;
    await expect(
      waitForInstallVisibility(
        candidate,
        {
          readInstallPackument: async () => reads.shift() ?? { versions: {} },
          sleep: async (ms) => {
            now += ms;
          },
          now: () => now,
        },
        10,
        5,
      ),
    ).resolves.toBeUndefined();

    now = 0;
    await expect(
      waitForInstallVisibility(
        candidate,
        {
          readInstallPackument: async () => ({ versions: {} }),
          sleep: async (ms) => {
            now += ms;
          },
          now: () => now,
        },
        10,
        5,
      ),
    ).rejects.toThrow("did not become visible");
  });
});

describe("cryptographic audit and provenance semantics", () => {
  test("requires the exact package bundles returned by npm signature audit", () => {
    expect(extractVerifiedAttestations(candidate, auditResult())).toHaveLength(2);
    expect(() =>
      extractVerifiedAttestations(candidate, {
        ...auditResult(),
        invalid: [{ name: candidate.name }],
      }),
    ).toThrow("invalid signatures");
    expect(() =>
      extractVerifiedAttestations(candidate, {
        ...auditResult(),
        missing: [{ name: candidate.name }],
      }),
    ).toThrow("missing signatures");
    expect(() =>
      extractVerifiedAttestations(candidate, {
        ...auditResult(),
        verified: [],
      }),
    ).toThrow("did not cryptographically verify");
  });

  test("pins the provenance bundle to the exact release certificate identity and issuer", async () => {
    const expectedPolicy = {
      certificateIssuer: "https://token.actions.githubusercontent.com",
      certificateIdentityURI:
        "^https://github\\.com/hasna/mementos/\\.github/workflows/release\\.yml@refs/tags/npm/mementos/v0\\.14\\.76$",
    };
    expect(releaseCertificateIdentityPolicy(candidate)).toEqual(expectedPolicy);

    const accepted = certificateVerifier();
    await expect(
      verifyAttestations(candidate, attestations(), accepted.verify),
    ).resolves.toBeUndefined();
    expect(accepted.calls).toEqual([expectedPolicy]);

    const wrongIdentity = certificateVerifier(
      "https://github.com/attacker/mementos/.github/workflows/release.yml@refs/tags/npm/mementos/v0.14.76",
    );
    await expect(
      verifyAttestations(candidate, attestations(), wrongIdentity.verify),
    ).rejects.toThrow("certificate identity mismatch");

    const wrongIssuer = certificateVerifier(
      "https://github.com/hasna/mementos/.github/workflows/release.yml@refs/tags/npm/mementos/v0.14.76",
      "https://issuer.example.invalid",
    );
    await expect(
      verifyAttestations(candidate, attestations(), wrongIssuer.verify),
    ).rejects.toThrow("certificate issuer mismatch");
  });

  test("actual Sigstore verification accepts the exact signer and rejects a foreign identity", async () => {
    // Immutable public npm fixture, narrowed to the provenance bundle from:
    // https://registry.npmjs.org/-/npm/v1/attestations/sigstore@5.0.0
    const bundle = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "fixtures/sigstore-5.0.0-provenance-bundle.json",
        ),
        "utf8",
      ),
    ) as unknown;
    const exactPolicy = {
      certificateIssuer: GITHUB_ACTIONS_OIDC_ISSUER,
      certificateIdentityURI:
        "^https://github\\.com/sigstore/sigstore-js/\\.github/workflows/release\\.yml@refs/heads/main$",
    };
    await expect(
      verifySigstoreBundleWithNode(bundle, exactPolicy),
    ).resolves.toBe("verified Sigstore certificate identity");
    await expect(
      verifySigstoreBundleWithNode(bundle, {
        ...exactPolicy,
        certificateIdentityURI:
          "^https://github\\.com/attacker/repo/\\.github/workflows/release\\.yml@refs/heads/main$",
      }),
    ).rejects.toThrow("certificate identity error");
  });

  test("binds audited attestations to package, digest, workflow, tag, and commit", async () => {
    const verify = certificateVerifier().verify;
    await expect(
      verifyAttestations(candidate, attestations(), verify),
    ).resolves.toBeUndefined();
    await expect(
      verifyAttestations(
        candidate,
        attestations({ commit: "f".repeat(40) }),
        verify,
      ),
    ).rejects.toThrow("release commit");
    await expect(
      verifyAttestations(
        candidate,
        attestations({ repository: "attacker/repo" }),
        verify,
      ),
    ).rejects.toThrow("workflow, repository, or tag");
    await expect(
      verifyAttestations(candidate, attestations({ workflow: "other.yml" }), verify),
    ).rejects.toThrow("workflow, repository, or tag");
    await expect(
      verifyAttestations(
        candidate,
        attestations({ tag: "npm/mementos/v9.9.9" }),
        verify,
      ),
    ).rejects.toThrow("workflow, repository, or tag");
    await expect(
      verifyAttestations(
        candidate,
        attestations({ subject: "pkg:npm/other@1.0.0" }),
        verify,
      ),
    ).rejects.toThrow("attestation subject");
    await expect(
      verifyAttestations(
        candidate,
        attestations({ publishName: "@hasna/other" }),
        verify,
      ),
    ).rejects.toThrow("publish attestation");
  });

  test("uses exact install and attestation-audit command shapes", () => {
    expect(installArguments(candidate)).toEqual([
      "install",
      "--ignore-scripts",
      "--audit=false",
      "--fund=false",
      "--save-exact",
      `${candidate.name}@${candidate.version}`,
      "--registry",
      "https://registry.npmjs.org",
    ]);
    expect(auditArguments()).toEqual([
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      "https://registry.npmjs.org",
    ]);
    expect(() => assertExactCliVersion(candidate, `${candidate.version}\n`))
      .not.toThrow();
    expect(() => assertExactCliVersion(candidate, "9.9.9\n")).toThrow(
      "mementos --version",
    );
  });

  test("production verify-registry orders every lane through the tested orchestrator", async () => {
    const order: string[] = [];
    await verifyRegistryRelease(candidate, "staged", 1, 0, {
      readVersionMetadata: async () => {
        order.push("version");
        return versionMetadata();
      },
      readPackageMetadata: async () => {
        order.push("full");
        return packageMetadata("staged");
      },
      readTarball: async () => {
        order.push("tarball");
        return bytes;
      },
      awaitInstallVisibility: async () => {
        order.push("install-packument");
      },
      verifyConsumer: () => {
        order.push("consumer-audit");
        return attestations();
      },
      verifyAttestationBundle: certificateVerifier().verify,
    });
    expect(order).toEqual([
      "version",
      "full",
      "tarball",
      "install-packument",
      "consumer-audit",
      "full",
    ]);

    await expect(
      verifyRegistryRelease(candidate, "staged", 1, 0, {
        readVersionMetadata: async () => versionMetadata(),
        readPackageMetadata: async () => packageMetadata("staged"),
        readTarball: async () => Buffer.from("foreign bytes"),
        awaitInstallVisibility: async () => {},
        verifyConsumer: () => attestations(),
        verifyAttestationBundle: certificateVerifier().verify,
      }),
    ).rejects.toThrow("reviewed pack");
    await expect(
      verifyRegistryRelease(candidate, "staged", 1, 0, {
        readVersionMetadata: async () => versionMetadata(),
        readPackageMetadata: async () => packageMetadata("staged"),
        readTarball: async () => bytes,
        awaitInstallVisibility: async () => {
          throw new Error("abbreviated packument absent");
        },
        verifyConsumer: () => attestations(),
        verifyAttestationBundle: certificateVerifier().verify,
      }),
    ).rejects.toThrow("abbreviated packument absent");

    await expect(
      verifyRegistryRelease(candidate, "staged", 1, 0, {
        readVersionMetadata: async () => versionMetadata(),
        readPackageMetadata: async () => packageMetadata("staged"),
        readTarball: async () => bytes,
        awaitInstallVisibility: async () => {},
        verifyConsumer: () => attestations(),
        verifyAttestationBundle: certificateVerifier(
          "https://github.com/attacker/mementos/.github/workflows/release.yml@refs/tags/npm/mementos/v0.14.76",
        ).verify,
      }),
    ).rejects.toThrow("certificate identity mismatch");

    let packumentRead = 0;
    await expect(
      verifyRegistryRelease(candidate, "staged", 1, 0, {
        readVersionMetadata: async () => versionMetadata(),
        readPackageMetadata: async () =>
          ++packumentRead === 1
            ? packageMetadata("staged")
            : packageMetadata("promoted"),
        readTarball: async () => bytes,
        awaitInstallVisibility: async () => {},
        verifyConsumer: () => attestations(),
        verifyAttestationBundle: certificateVerifier().verify,
      }),
    ).rejects.toThrow("promoted before registry verification completed");
  });
});

describe("monotonic promotion and bounded retries", () => {
  test("promotes only the highest stable version and is idempotent", async () => {
    let state = packageMetadata("staged");
    const writes: string[] = [];
    expect(
      await promoteLatestMonotonically(candidate, {
        readPackage: async () => state,
        setLatest: (version) => {
          writes.push(version);
          state = packageMetadata("promoted");
        },
      }),
    ).toBe("promoted");
    expect(writes).toEqual([candidate.version]);

    expect(
      await promoteLatestMonotonically(candidate, {
        readPackage: async () => packageMetadata("promoted"),
        setLatest: () => {
          throw new Error("must not mutate");
        },
      }),
    ).toBe("idempotent");
  });

  test("rejects downgrades and restores a newer version that wins a race", async () => {
    const newer = "0.15.0";
    await expect(
      promoteLatestMonotonically(candidate, {
        readPackage: async () =>
          packageMetadata("staged", [candidate.version, newer], newer),
        setLatest: () => {
          throw new Error("must not mutate");
        },
      }),
    ).rejects.toThrow("highest stable");

    const states = [
      packageMetadata("staged"),
      packageMetadata("staged"),
      packageMetadata(
        "staged",
        ["0.14.75", candidate.version, newer],
        candidate.version,
      ),
      packageMetadata(
        "staged",
        ["0.14.75", candidate.version, newer],
        newer,
      ),
    ];
    const writes: string[] = [];
    await expect(
      promoteLatestMonotonically(candidate, {
        readPackage: async () => states.shift()!,
        setLatest: (version) => {
          writes.push(version);
        },
      }),
    ).rejects.toThrow("registry latest was restored");
    expect(writes).toEqual([candidate.version, newer]);
  });

  test("extracts a complete promotion snapshot and bounds retry inputs", () => {
    expect(promotionSnapshot(candidate, packageMetadata("staged"))).toEqual({
      latest: "0.14.75",
      staging: candidate.version,
      highestStable: candidate.version,
    });
    expect(parseRetryOptions("4", "5000")).toEqual({
      attempts: 4,
      delayMs: 5000,
    });
    expect(() => parseRetryOptions("0", "5000")).toThrow("attempts");
    expect(() => parseRetryOptions("6", "20000")).toThrow("delay");
  });
});
