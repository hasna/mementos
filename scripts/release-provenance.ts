import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

export const RELEASE_WORKFLOW = ".github/workflows/release.yml";
export const PUBLISH_PREDICATE =
  "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
export const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
export const NPM_INSTALL_ACCEPT = "application/vnd.npm.install-v1+json";
export const RELEASE_NODE_VERSION = "24.18.0";
export const RELEASE_NPM_VERSION = "11.16.0";
export const RELEASE_BUN_VERSION = "1.3.14";

const CANDIDATE_SCHEMA = "hasna.mementos.release-candidate/v1";
const REGISTRY = "https://registry.npmjs.org";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 180_000;
const FETCH_TIMEOUT_MS = 15_000;
const INSTALL_VISIBILITY_TIMEOUT_MS = 120_000;
const INSTALL_VISIBILITY_POLL_MS = 2_000;
const DSSE_IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const IN_TOTO_STATEMENT_V01 = "https://in-toto.io/Statement/v0.1";
const GITHUB_ACTIONS_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_ACTIONS_BUILDER = "https://github.com/actions/runner/github-hosted";
const PACK_RESTORE_SCRIPT = ".mementos-pack-restore.cjs";
const PACK_MANIFEST_ENV = "MEMENTOS_RELEASE_PACK_MANIFEST";
const REQUIRED_STATEMENT_TYPE = new Map<string, string>([
  [PUBLISH_PREDICATE, IN_TOTO_STATEMENT_V01],
  [PROVENANCE_PREDICATE, IN_TOTO_STATEMENT_V1],
]);

type RecordValue = Record<string, unknown>;
type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface Manifest {
  name: string;
  version: string;
  repository: string | { url: string };
  publishConfig?: {
    registry?: string;
    access?: string;
    tag?: string;
  };
}

export interface PackResult {
  name: string;
  version: string;
  filename: string;
  shasum: string;
  integrity: string;
  size: number;
  files: Array<{
    path: string;
    size: number;
    mode: number;
  }>;
}

export interface ReleaseCandidate {
  schema: typeof CANDIDATE_SCHEMA;
  name: string;
  version: string;
  tag: string;
  commit: string;
  repository: string;
  workflow: typeof RELEASE_WORKFLOW;
  integrity: string;
  shasum: string;
  filename: string;
  size: number;
  fileCount: number;
  unpackedBytes: number;
  artifactPath: string;
  stagingTag: string;
  intendedTag: string;
}

export type RegistryPhase = "staged" | "promoted";
export type PublicationState = "unpublished" | RegistryPhase;

interface RunOptions {
  inherit?: boolean;
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface PublicationStateOperations {
  readVersionMetadata: () => Promise<unknown>;
  readPackageMetadata: () => Promise<unknown>;
  readTarball: (url: URL) => Promise<Uint8Array>;
}

export interface InstallVisibilityOperations {
  readInstallPackument: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface RegistryReleaseAttemptOperations {
  readVersionMetadata: () => Promise<unknown>;
  readPackageMetadata: () => Promise<unknown>;
  readTarball: (url: URL) => Promise<Uint8Array>;
  awaitInstallVisibility: () => Promise<void>;
  verifyConsumer: () => unknown[];
}

export interface PromotionSnapshot {
  latest?: string;
  staging?: string;
  highestStable: string;
}

export interface PromotionOperations {
  readPackage: () => Promise<unknown>;
  setLatest: (version: string) => void;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown, label: string): RecordValue {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value as RecordValue;
}

function text(value: unknown, label: string): string {
  check(
    typeof value === "string" && value.length > 0,
    `${label} must be a non-empty string`,
  );
  return value;
}

function integer(value: unknown, label: string): number {
  check(
    Number.isInteger(value) && (value as number) >= 0,
    `${label} must be a non-negative integer`,
  );
  return value as number;
}

function exactCommit(value: string, label: string): string {
  check(
    /^[0-9a-f]{40}$/.test(value),
    `${label} must be an exact 40-character lowercase git SHA`,
  );
  return value;
}

function runResult(
  executable: string,
  args: string[],
  cwd: string,
  options: RunOptions = {},
) {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    stdio: options.inherit ? "inherit" : "pipe",
    env: {
      ...process.env,
      ...options.env,
      NO_UPDATE_NOTIFIER: "1",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_FUND: "false",
    },
    input: options.input,
  };
  return spawnSync(executable, args, spawnOptions);
}

function run(
  executable: string,
  args: string[],
  cwd: string,
  options: RunOptions = {},
): string {
  const result = runResult(executable, args, cwd, options);
  check(!result.error, `could not run ${executable}: ${result.error?.message}`);
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  check(
    result.status === 0,
    `${executable} ${args.join(" ")} failed with exit ${result.status}${
      detail ? `:\n${detail}` : ""
    }`,
  );
  return result.stdout ?? "";
}

function loadManifest(root: string): Manifest {
  const value = record(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    "package.json",
  );
  const repository = value.repository;
  check(
    typeof repository === "string" ||
      (repository &&
        typeof repository === "object" &&
        !Array.isArray(repository) &&
        typeof (repository as RecordValue).url === "string"),
    "package.json repository must contain a URL",
  );
  return {
    name: text(value.name, "package name"),
    version: text(value.version, "package version"),
    repository: repository as Manifest["repository"],
    publishConfig: value.publishConfig as Manifest["publishConfig"],
  };
}

export function repositorySlug(manifest: Manifest): string {
  const url =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository.url;
  const match = url.match(
    /^(?:git\+)?(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#]+?)(?:\.git)?$/,
  );
  check(match?.[1], `repository is not canonical GitHub metadata: ${url}`);
  return match[1];
}

export function releaseTag(
  manifest: Pick<Manifest, "name" | "version">,
): string {
  const slug = manifest.name.split("/").at(-1);
  check(
    slug?.match(/^[a-z0-9][a-z0-9._-]*$/),
    `invalid package name: ${manifest.name}`,
  );
  check(
    manifest.version.match(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    ),
    `invalid package version: ${manifest.version}`,
  );
  return `npm/${slug}/v${manifest.version}`;
}

function assertDistTag(value: string, label: string): string {
  check(
    /^[a-z][a-z0-9._-]{0,127}$/.test(value) &&
      !/^v?\d+(?:\.\d+){1,2}(?:[-+].*)?$/.test(value),
    `${label} is not a safe npm dist-tag: ${value}`,
  );
  return value;
}

export function stagingDistTag(version: string): string {
  return assertDistTag(
    `release-candidate-${version
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")}`,
    "staging tag",
  );
}

function intendedDistTag(manifest: Manifest): string {
  const tag = assertDistTag(manifest.publishConfig?.tag ?? "latest", "intended tag");
  check(tag === "latest", "Mementos releases must promote only the latest dist-tag");
  return tag;
}

export function packagePurl(name: string, version: string): string {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`;
  const [scope, packageName, extra] = name.split("/");
  check(scope && packageName && !extra, `invalid scoped package name: ${name}`);
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`;
}

function parsePack(stdout: string): PackResult {
  const start = stdout.indexOf("[");
  check(start !== -1, "npm pack did not produce JSON");
  const values = JSON.parse(stdout.slice(start)) as unknown;
  check(
    Array.isArray(values) && values.length === 1,
    "npm pack must describe one package",
  );
  const value = record(values[0], "npm pack result");
  check(
    Array.isArray(value.files) && value.files.length > 0,
    "npm pack reported no files",
  );
  return {
    name: text(value.name, "pack name"),
    version: text(value.version, "pack version"),
    filename: text(value.filename, "pack filename"),
    shasum: text(value.shasum, "pack shasum"),
    integrity: text(value.integrity, "pack integrity"),
    size: integer(value.size, "pack size"),
    files: value.files.map((entry, index) => {
      const file = record(entry, `pack file ${index}`);
      return {
        path: text(file.path, `pack file ${index} path`),
        size: integer(file.size, `pack file ${index} size`),
        mode: integer(file.mode, `pack file ${index} mode`),
      };
    }),
  };
}

function safePackPath(
  root: string,
  path: string,
): { source: string; relativePath: string } {
  check(
    !isAbsolute(path) &&
      !path.includes("\\") &&
      !path.match(/(?:^|\/)\.{1,2}(?:\/|$)/) &&
      posix.normalize(path) === path,
    `npm pack returned an unsafe file path: ${path}`,
  );
  const source = resolve(root, ...path.split("/"));
  const relativePath = relative(root, source);
  check(
    relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`),
    `npm pack file escapes the package root: ${path}`,
  );
  return { source, relativePath };
}

function copyPackInput(source: string, destination: string, label: string): void {
  const stat = lstatSync(source);
  check(!stat.isSymbolicLink(), `pack input must not be a symlink: ${label}`);
  if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode & 0o777);
    return;
  }
  check(stat.isDirectory(), `pack input must be a file or directory: ${label}`);
  mkdirSync(destination, { recursive: true });
  chmodSync(destination, stat.mode & 0o777);
  for (const entry of readdirSync(source).sort()) {
    copyPackInput(
      join(source, entry),
      join(destination, entry),
      `${label}/${entry}`,
    );
  }
}

function packPreview(root: string, manifest: RecordValue): PackResult {
  check(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "package.json files must be a nonempty explicit allowlist",
  );
  const inputs = new Set<string>();
  for (const [index, value] of manifest.files.entries()) {
    const path = text(value, `package files entry ${index}`);
    check(
      !/[*?[\]{}!]/.test(path),
      `package files entry must be a literal path: ${path}`,
    );
    safePackPath(root, path);
    inputs.add(path);
  }
  for (const entry of readdirSync(root)) {
    if (
      /^(?:readme|licen[cs]e|notice|changelog)(?:\..*)?$/i.test(entry) &&
      lstatSync(join(root, entry)).isFile()
    ) {
      inputs.add(entry);
    }
  }
  for (const control of [".npmignore", ".gitignore"]) {
    if (existsSync(join(root, control))) inputs.add(control);
  }

  const previewRoot = mkdtempSync(join(tmpdir(), "mementos-pack-preview-"));
  try {
    for (const path of [...inputs].sort()) {
      const { source, relativePath } = safePackPath(root, path);
      if (!existsSync(source)) continue;
      copyPackInput(source, join(previewRoot, relativePath), path);
    }
    const scripts =
      manifest.scripts === undefined
        ? {}
        : { ...record(manifest.scripts, "package scripts") };
    delete scripts.prepack;
    delete scripts.prepare;
    delete scripts.postpack;
    writeFileSync(
      join(previewRoot, "package.json"),
      `${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
    return parsePack(
      run("npm", ["pack", "--json", "--dry-run"], previewRoot),
    );
  } finally {
    rmSync(previewRoot, { recursive: true, force: true });
  }
}

function stagePackSource(root: string, expectedCommit: string): {
  root: string;
  preview: PackResult;
  manifest: RecordValue;
  manifestText: string;
} {
  const sourceManifest = record(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    "source package.json",
  );
  const preview = packPreview(root, sourceManifest);
  const staged = mkdtempSync(join(tmpdir(), "mementos-pack-source-"));
  for (const file of preview.files) {
    const { source, relativePath } = safePackPath(root, file.path);
    const stat = lstatSync(source);
    check(
      stat.isFile() && !stat.isSymbolicLink(),
      `npm pack source must be a regular non-symlink file: ${file.path}`,
    );
    const destination = join(staged, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, file.mode);
  }
  const manifestPath = join(staged, "package.json");
  const manifest = record(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    "staged package.json",
  );
  check(
    manifest.gitHead === undefined,
    "source package.json must not contain generated gitHead metadata",
  );
  manifest.gitHead = exactCommit(expectedCommit, "release commit");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const scripts =
    manifest.scripts === undefined
      ? {}
      : { ...record(manifest.scripts, "staged package scripts") };
  delete scripts.prepack;
  delete scripts.postpack;
  scripts.prepare = `node ./${PACK_RESTORE_SCRIPT}`;
  const bridgeManifest = { ...manifest, scripts };
  writeFileSync(
    join(staged, PACK_RESTORE_SCRIPT),
    [
      '"use strict";',
      'const { rmSync, writeFileSync } = require("node:fs");',
      `const manifest = process.env.${PACK_MANIFEST_ENV};`,
      'if (!manifest) throw new Error("missing preserved release manifest");',
      'writeFileSync("package.json", manifest, { encoding: "utf8", flag: "w", mode: 0o644 });',
      "rmSync(__filename, { force: true });",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  writeFileSync(manifestPath, `${JSON.stringify(bridgeManifest, null, 2)}\n`, {
    flag: "w",
    mode: 0o644,
  });
  return { root: staged, preview, manifest, manifestText };
}

function verifyStagedPackFileSet(
  preview: PackResult,
  packed: PackResult,
): void {
  check(
    preview.name === packed.name && preview.version === packed.version,
    "staged pack identity changed after gitHead injection",
  );
  const shape = (pack: PackResult) =>
    pack.files
      .map(({ path, size, mode }) => ({
        path,
        size: path === "package.json" ? "<generated-gitHead>" : size,
        mode,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  check(
    JSON.stringify(shape(preview)) === JSON.stringify(shape(packed)),
    "staged pack file set changed after gitHead injection",
  );
}

function readPackedManifest(artifactPath: string): RecordValue {
  const stdout = run(
    "tar",
    ["-xOzf", artifactPath, "package/package.json"],
    dirname(artifactPath),
  );
  check(
    Buffer.byteLength(stdout) <= 1024 * 1024,
    "packed package.json exceeds one MiB",
  );
  return record(JSON.parse(stdout), "packed package.json");
}

function verifyPackedManifestExact(
  artifactPath: string,
  expected: RecordValue,
): void {
  const manifest = readPackedManifest(artifactPath);
  check(
    isDeepStrictEqual(manifest, expected),
    "packed package.json differs from the preserved release manifest",
  );
}

function verifyPackedManifestIdentity(
  artifactPath: string,
  expected: Pick<ReleaseCandidate, "name" | "version" | "commit">,
): void {
  const manifest = readPackedManifest(artifactPath);
  check(
    manifest.name === expected.name && manifest.version === expected.version,
    "packed package.json identity disagrees with the release candidate",
  );
  check(
    manifest.gitHead === exactCommit(expected.commit, "expected gitHead"),
    "packed package.json gitHead disagrees with the release commit",
  );
}

function verifyArtifactBytes(
  pack: PackResult,
  bytes: Buffer,
  expectedCommit: string,
  artifactPath: string,
  expectedManifest: RecordValue,
): void {
  check(bytes.length === pack.size, "npm pack size does not match the tarball bytes");
  check(
    bytes.length > 0 && bytes.length <= MAX_TARBALL_BYTES,
    `tarball must be nonempty and no larger than ${MAX_TARBALL_BYTES} bytes`,
  );
  check(
    createHash("sha1").update(bytes).digest("hex") === pack.shasum &&
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` ===
        pack.integrity,
    "npm pack metadata does not match the tarball bytes",
  );
  check(
    expectedManifest.gitHead === exactCommit(expectedCommit, "expected gitHead"),
    "preserved release manifest gitHead disagrees with the release commit",
  );
  verifyPackedManifestExact(artifactPath, expectedManifest);
}

export function assertDeterministicPacks(
  first: PackResult,
  second: PackResult,
  firstBytes?: Uint8Array,
  secondBytes?: Uint8Array,
): void {
  check(
    JSON.stringify(first) === JSON.stringify(second),
    "two clean build-and-pack runs produced different artifacts; refusing release",
  );
  if (firstBytes || secondBytes) {
    check(firstBytes && secondBytes, "both packed byte streams are required");
    check(
      Buffer.from(firstBytes).equals(Buffer.from(secondBytes)),
      "two clean build-and-pack runs produced different tarball bytes; refusing release",
    );
  }
}

function buildAndPack(
  root: string,
  expectedCommit: string,
): { result: PackResult; bytes: Buffer } {
  run("bun", ["run", "build"], root, {
    inherit: true,
    timeoutMs: 300_000,
  });
  const staged = stagePackSource(root, expectedCommit);
  const destination = mkdtempSync(join(tmpdir(), "mementos-pack-"));
  try {
    const pack = parsePack(
      run(
        "npm",
        [
          "pack",
          "--json",
          "--pack-destination",
          destination,
        ],
        staged.root,
        {
          env: {
            [PACK_MANIFEST_ENV]: staged.manifestText,
          },
        },
      ),
    );
    check(
      readFileSync(join(staged.root, "package.json"), "utf8") ===
        staged.manifestText,
      "pack lifecycle bridge did not restore the preserved release manifest",
    );
    check(
      !existsSync(join(staged.root, PACK_RESTORE_SCRIPT)),
      "pack lifecycle bridge did not remove its temporary restore script",
    );
    verifyStagedPackFileSet(staged.preview, pack);
    check(
      basename(pack.filename) === pack.filename,
      "npm pack returned an unsafe filename",
    );
    const artifactPath = join(destination, pack.filename);
    const bytes = readFileSync(artifactPath);
    verifyArtifactBytes(
      pack,
      bytes,
      expectedCommit,
      artifactPath,
      staged.manifest,
    );
    return { result: pack, bytes };
  } finally {
    rmSync(staged.root, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
}

export function verifyDeterministicPack(
  root: string,
  artifactPath?: string,
  expectedCommit = run("git", ["rev-parse", "HEAD"], root).trim(),
): PackResult {
  exactCommit(expectedCommit, "release commit");
  const first = buildAndPack(root, expectedCommit);
  const second = buildAndPack(root, expectedCommit);
  assertDeterministicPacks(first.result, second.result, first.bytes, second.bytes);
  if (artifactPath) {
    writeFileSync(resolve(artifactPath), second.bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
  console.log(
    `verified deterministic package ${second.result.name}@${second.result.version}: ` +
      `${second.result.files.length} files, ${second.result.size} bytes, ` +
      `${second.result.integrity}`,
  );
  return second.result;
}

function candidateFrom(
  manifest: Manifest,
  pack: PackResult,
  commit: string,
  artifactPath: string,
): ReleaseCandidate {
  check(
    pack.name === manifest.name && pack.version === manifest.version,
    "pack metadata disagrees with package.json",
  );
  const unpackedBytes = pack.files.reduce((sum, file) => sum + file.size, 0);
  check(
    Number.isSafeInteger(unpackedBytes) && unpackedBytes > 0,
    "pack unpacked size is invalid",
  );
  return {
    schema: CANDIDATE_SCHEMA,
    name: manifest.name,
    version: manifest.version,
    tag: releaseTag(manifest),
    commit,
    repository: repositorySlug(manifest),
    workflow: RELEASE_WORKFLOW,
    integrity: pack.integrity,
    shasum: pack.shasum,
    filename: pack.filename,
    size: pack.size,
    fileCount: pack.files.length,
    unpackedBytes,
    artifactPath,
    stagingTag: stagingDistTag(manifest.version),
    intendedTag: intendedDistTag(manifest),
  };
}

export function loadCandidate(path: string): ReleaseCandidate {
  const value = record(
    JSON.parse(readFileSync(path, "utf8")),
    "release candidate",
  );
  check(value.schema === CANDIDATE_SCHEMA, "unsupported candidate schema");
  const artifactPath = text(value.artifactPath, "candidate artifact path");
  check(isAbsolute(artifactPath), "candidate artifact path must be absolute");
  const result: ReleaseCandidate = {
    schema: CANDIDATE_SCHEMA,
    name: text(value.name, "candidate name"),
    version: text(value.version, "candidate version"),
    tag: text(value.tag, "candidate tag"),
    commit: exactCommit(text(value.commit, "candidate commit"), "candidate commit"),
    repository: text(value.repository, "candidate repository"),
    workflow: RELEASE_WORKFLOW,
    integrity: text(value.integrity, "candidate integrity"),
    shasum: text(value.shasum, "candidate shasum"),
    filename: text(value.filename, "candidate filename"),
    size: integer(value.size, "candidate size"),
    fileCount: integer(value.fileCount, "candidate file count"),
    unpackedBytes: integer(value.unpackedBytes, "candidate unpacked bytes"),
    artifactPath,
    stagingTag: assertDistTag(
      text(value.stagingTag, "candidate staging tag"),
      "candidate staging tag",
    ),
    intendedTag: assertDistTag(
      text(value.intendedTag, "candidate intended tag"),
      "candidate intended tag",
    ),
  };
  check(
    result.size > 0 && result.fileCount > 0 && result.unpackedBytes > 0,
    "candidate artifact metadata must be nonempty",
  );
  return result;
}

function assertCandidateContext(
  value: ReleaseCandidate,
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): void {
  const expected = {
    name: manifest.name,
    version: manifest.version,
    tag: releaseTag(manifest),
    commit: exactCommit(text(env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA"),
    repository: repositorySlug(manifest),
    workflow: RELEASE_WORKFLOW,
    stagingTag: stagingDistTag(manifest.version),
    intendedTag: intendedDistTag(manifest),
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    check(
      value[key as keyof ReleaseCandidate] === expectedValue,
      `candidate ${key} disagrees with release context`,
    );
  }
}

export function verifyCandidateArtifact(value: ReleaseCandidate): Buffer {
  const stat = lstatSync(value.artifactPath);
  check(
    stat.isFile() && !stat.isSymbolicLink(),
    "candidate artifact must be a regular non-symlink file",
  );
  check(stat.size === value.size, "candidate artifact size changed after verification");
  check(
    stat.size > 0 && stat.size <= MAX_TARBALL_BYTES,
    `candidate artifact exceeds ${MAX_TARBALL_BYTES} bytes`,
  );
  const bytes = readFileSync(value.artifactPath);
  check(
    createHash("sha1").update(bytes).digest("hex") === value.shasum &&
      `sha512-${createHash("sha512").update(bytes).digest("base64")}` ===
        value.integrity,
    "candidate artifact bytes changed after verification",
  );
  verifyPackedManifestIdentity(value.artifactPath, value);
  return bytes;
}

function assertToolchain(root: string): void {
  const npm = run("npm", ["--version"], root).trim();
  check(
    process.versions.node === RELEASE_NODE_VERSION,
    `Node ${process.versions.node} is not pinned release version ${RELEASE_NODE_VERSION}`,
  );
  check(
    npm === RELEASE_NPM_VERSION,
    `npm ${npm} is not pinned release version ${RELEASE_NPM_VERSION}`,
  );
  check(
    Bun.version === RELEASE_BUN_VERSION,
    `Bun ${Bun.version} is not pinned release version ${RELEASE_BUN_VERSION}`,
  );
}

function assertGitHubContext(
  root: string,
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): void {
  const repository = repositorySlug(manifest);
  const tag = releaseTag(manifest);
  const expected: Record<string, string> = {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: `refs/tags/${tag}`,
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: tag,
    GITHUB_REPOSITORY: repository,
    GITHUB_WORKFLOW_REF: `${repository}/${RELEASE_WORKFLOW}@refs/tags/${tag}`,
  };
  for (const [name, value] of Object.entries(expected)) {
    check(
      env[name] === value,
      `${name} must be ${value}; received ${env[name] ?? "<unset>"}`,
    );
  }
  const sha = exactCommit(text(env.GITHUB_SHA, "GITHUB_SHA"), "GITHUB_SHA");
  check(
    run("git", ["rev-parse", "HEAD"], root).trim() === sha,
    "checked-out commit disagrees with GITHUB_SHA",
  );
  check(
    run("git", ["rev-parse", `${env.GITHUB_REF}^{commit}`], root).trim() === sha,
    "tag commit disagrees with GITHUB_SHA",
  );
}

function assertReleaseEnvironment(
  root: string,
  manifest: Manifest,
  env: NodeJS.ProcessEnv,
): void {
  assertToolchain(root);
  assertGitHubContext(root, manifest, env);
  check(
    env.NPM_DIST_TAG_TOKEN_CONFIGURED === "true",
    "NPM_DIST_TAG_TOKEN is not configured in the protected release environment",
  );
}

function assertPublishEnvironment(env: NodeJS.ProcessEnv): void {
  check(
    !env.NODE_AUTH_TOKEN && !env.NPM_TOKEN,
    "OIDC publication must not receive a long-lived npm token",
  );
}

function assertPromotionEnvironment(env: NodeJS.ProcessEnv): void {
  check(
    typeof env.NODE_AUTH_TOKEN === "string" && env.NODE_AUTH_TOKEN.length > 0,
    "dist-tag promotion requires the package-scoped NPM_DIST_TAG_TOKEN",
  );
}

function packageUrl(name: string, version = ""): URL {
  return new URL(
    `${REGISTRY}/${encodeURIComponent(name)}${
      version ? `/${encodeURIComponent(version)}` : ""
    }`,
  );
}

export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null) {
    const parsed = Number(length);
    check(
      Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maxBytes,
      `response content-length exceeds ${maxBytes} bytes`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  check(bytes.length <= maxBytes, `response exceeds ${maxBytes} bytes`);
  return bytes;
}

async function fetchLimited(
  url: URL,
  maxBytes: number,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<Buffer> {
  const response = await fetcher(url, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  check(response.ok, `registry request returned ${response.status}`);
  return readLimited(response, maxBytes);
}

async function fetchJson(
  url: URL,
  maxBytes = MAX_JSON_BYTES,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<unknown> {
  return JSON.parse((await fetchLimited(url, maxBytes, init, fetcher)).toString("utf8"));
}

function safeRegistryUrl(value: unknown, label: string, prefix: string): URL {
  const url = new URL(text(value, label));
  check(
    url.origin === REGISTRY &&
      decodeURIComponent(url.pathname).startsWith(prefix) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    `unsafe ${label}`,
  );
  return url;
}

export function verifyRegistryArtifactMetadata(
  value: ReleaseCandidate,
  input: unknown,
): { tarballUrl: URL } {
  const metadata = record(input, "registry metadata");
  check(
    metadata.name === value.name && metadata.version === value.version,
    "registry package identity disagrees",
  );
  check(metadata.gitHead === value.commit, "registry gitHead disagrees");
  const dist = record(metadata.dist, "registry dist");
  check(
    dist.integrity === value.integrity && dist.shasum === value.shasum,
    "registry integrity disagrees",
  );
  check(
    integer(dist.fileCount, "registry fileCount") === value.fileCount,
    "registry fileCount disagrees",
  );
  check(
    integer(dist.unpackedSize, "registry unpackedSize") === value.unpackedBytes,
    "registry unpackedSize disagrees",
  );
  return {
    tarballUrl: safeRegistryUrl(
      dist.tarball,
      "tarball URL",
      `/${value.name}/-/`,
    ),
  };
}

export function verifyRegistryMetadata(
  value: ReleaseCandidate,
  input: unknown,
): { tarballUrl: URL } {
  const urls = verifyRegistryArtifactMetadata(value, input);
  const dist = record(record(input, "registry metadata").dist, "registry dist");
  const attestations = record(dist.attestations, "registry attestations");
  check(
    record(attestations.provenance, "registry provenance").predicateType ===
      PROVENANCE_PREDICATE,
    "registry does not advertise SLSA v1 provenance",
  );
  const attestationsUrl = safeRegistryUrl(
    attestations.url,
    "attestations URL",
    "/-/npm/v1/attestations/",
  );
  check(
    decodeURIComponent(attestationsUrl.pathname) ===
      `/-/npm/v1/attestations/${value.name}@${value.version}`,
    "registry attestations URL disagrees with the package identity",
  );
  return urls;
}

export function verifyDownloadedTarball(
  value: ReleaseCandidate,
  bytes: Uint8Array,
): void {
  const buffer = Buffer.from(bytes);
  check(
    buffer.length === value.size,
    "downloaded registry tarball size differs from the reviewed pack",
  );
  check(
    buffer.length > 0 && buffer.length <= MAX_TARBALL_BYTES,
    `downloaded tarball exceeds ${MAX_TARBALL_BYTES} bytes`,
  );
  check(
    createHash("sha1").update(buffer).digest("hex") === value.shasum &&
      `sha512-${createHash("sha512").update(buffer).digest("base64")}` ===
        value.integrity,
    "downloaded registry tarball differs from the reviewed pack",
  );
}

export function verifyDistTags(
  value: ReleaseCandidate,
  input: unknown,
  phase: RegistryPhase,
): void {
  const tags = record(record(input, "registry package metadata")["dist-tags"], "dist-tags");
  check(
    tags[value.stagingTag] === value.version,
    `${value.stagingTag} does not point to ${value.version}`,
  );
  if (phase === "staged") {
    check(
      tags[value.intendedTag] !== value.version,
      `${value.intendedTag} was promoted before registry verification completed`,
    );
  } else {
    check(
      tags[value.intendedTag] === value.version,
      `${value.intendedTag} does not agree with ${value.stagingTag}`,
    );
  }
}

function publicationStateFromTags(
  value: ReleaseCandidate,
  input: unknown,
): RegistryPhase {
  const metadata = record(input, "registry package metadata");
  const tags = record(metadata["dist-tags"], "dist-tags");
  check(
    tags[value.stagingTag] === value.version,
    `${value.stagingTag} does not point to ${value.version}`,
  );
  return tags[value.intendedTag] === value.version ? "promoted" : "staged";
}

export async function resolvePublicationState(
  value: ReleaseCandidate,
  response: { status: number; ok: boolean },
  operations: PublicationStateOperations,
): Promise<PublicationState> {
  const packageMetadata = await operations.readPackageMetadata();
  let versionMetadata: unknown;
  if (response.status === 404) {
    const versions = record(
      record(packageMetadata, "registry package metadata").versions,
      "registry versions",
    );
    if (!Object.prototype.hasOwnProperty.call(versions, value.version)) {
      return "unpublished";
    }
    versionMetadata = versions[value.version];
  } else {
    check(response.ok, `registry preflight returned ${response.status}`);
    versionMetadata = await operations.readVersionMetadata();
  }
  try {
    const urls = verifyRegistryArtifactMetadata(value, versionMetadata);
    verifyDownloadedTarball(
      value,
      await operations.readTarball(urls.tarballUrl),
    );
    return publicationStateFromTags(value, packageMetadata);
  } catch (error) {
    throw new Error(
      `${value.name}@${value.version} already exists and is not this candidate ` +
        `staged for release; versions are immutable (${
          error instanceof Error ? error.message : String(error)
        })`,
    );
  }
}

async function ensurePublishable(value: ReleaseCandidate): Promise<PublicationState> {
  const response = await fetch(packageUrl(value.name, value.version), {
    redirect: "error",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const state = await resolvePublicationState(value, response, {
    readVersionMetadata: () =>
      fetchJson(packageUrl(value.name, value.version)),
    readPackageMetadata: createOriginPackumentReader(value.name),
    readTarball: (url) => fetchLimited(url, MAX_TARBALL_BYTES),
  });
  console.log(
    state === "unpublished"
      ? `${value.name}@${value.version} is not published`
      : `${value.name}@${value.version} is already this exact ${state} candidate; resuming`,
  );
  return state;
}

export function originIntentPackumentUrl(input: URL, nonce: string): URL {
  let decodedPath = "";
  try {
    decodedPath = decodeURIComponent(input.pathname);
  } catch {
    throw new Error("origin-intent packument URL has malformed encoding");
  }
  const segments = decodedPath.split("/").filter(Boolean);
  const segment = /^[a-z0-9][a-z0-9._~-]*$/;
  const isUnscoped = segments.length === 1 && segment.test(segments[0]!);
  const isScoped =
    segments.length === 2 &&
    segments[0]!.startsWith("@") &&
    segment.test(segments[0]!.slice(1)) &&
    segment.test(segments[1]!);
  check(
    input.origin === REGISTRY &&
      !input.username &&
      !input.password &&
      !input.hash &&
      (isUnscoped || isScoped),
    "origin-intent packument URL must target full npm package metadata",
  );
  check(
    /^[A-Za-z0-9._~-]{1,128}$/.test(nonce),
    "origin read nonce must be 1-128 URL-safe non-secret characters",
  );
  const url = new URL(input);
  url.searchParams.set("write", "true");
  url.searchParams.set("_hasna_origin_read", nonce);
  return url;
}

export function createOriginPackumentReader(
  name: string,
  options: { nonce?: () => string; fetcher?: Fetcher } = {},
): () => Promise<unknown> {
  const nonce = options.nonce ?? randomUUID;
  const observed = new Set<string>();
  const base = packageUrl(name);
  return async () => {
    const next = nonce();
    check(!observed.has(next), "origin read nonce was reused");
    observed.add(next);
    return fetchJson(
      originIntentPackumentUrl(base, next),
      MAX_JSON_BYTES,
      {},
      options.fetcher,
    );
  };
}

export function createInstallPackumentReader(
  name: string,
  fetcher?: Fetcher,
): () => Promise<unknown> {
  const url = packageUrl(name);
  return () =>
    fetchJson(
      url,
      MAX_JSON_BYTES,
      { headers: { accept: NPM_INSTALL_ACCEPT } },
      fetcher,
    );
}

export function packumentListsVersion(
  input: unknown,
  version: string,
): boolean {
  const versions = record(
    record(input, "registry packument").versions,
    "registry packument versions",
  );
  return Object.prototype.hasOwnProperty.call(versions, version);
}

export async function waitForInstallVisibility(
  value: ReleaseCandidate,
  operations: InstallVisibilityOperations,
  timeoutMs = INSTALL_VISIBILITY_TIMEOUT_MS,
  pollMs = INSTALL_VISIBILITY_POLL_MS,
): Promise<void> {
  const deadline = operations.now() + timeoutMs;
  let lastFailure = "no read attempted";
  for (;;) {
    try {
      if (
        packumentListsVersion(
          await operations.readInstallPackument(),
          value.version,
        )
      ) {
        return;
      }
      lastFailure = `the abbreviated packument does not list ${value.version}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (operations.now() >= deadline) {
      throw new Error(
        `${value.name}@${value.version} did not become visible to npm's install resolver ` +
          `within ${timeoutMs}ms (${lastFailure})`,
      );
    }
    await operations.sleep(pollMs);
  }
}

function decodeBase64(value: unknown, label: string): Buffer {
  const encoded = text(value, label);
  check(
    encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
    `${label} is not strict base64`,
  );
  const bytes = Buffer.from(encoded, "base64");
  check(bytes.toString("base64") === encoded, `${label} is not canonical base64`);
  check(bytes.length <= MAX_JSON_BYTES, `${label} exceeds ${MAX_JSON_BYTES} bytes`);
  return bytes;
}

function integrityHex(integrity: string): string {
  const match = integrity.match(/^sha512-([A-Za-z0-9+/]+={0,2})$/);
  check(match?.[1], "candidate integrity is not sha512");
  return decodeBase64(match[1], "candidate integrity").toString("hex");
}

function positiveInteger(value: unknown, label: string): bigint {
  const encoded = typeof value === "number" ? String(value) : value;
  check(
    typeof encoded === "string" && /^[1-9]\d*$/.test(encoded),
    `${label} must be a positive integer`,
  );
  return BigInt(encoded);
}

function auditedStatement(
  item: unknown,
  value: ReleaseCandidate,
): RecordValue {
  const attestation = record(item, "cryptographically verified attestation");
  const predicateType = text(attestation.predicateType, "predicate type");
  const bundle = record(attestation.bundle, "Sigstore bundle");
  check(
    bundle.mediaType === "application/vnd.dev.sigstore.bundle.v0.3+json",
    "attestation must use a Sigstore v0.3 bundle",
  );
  const envelope = record(bundle.dsseEnvelope, "DSSE envelope");
  check(
    Array.isArray(envelope.signatures) && envelope.signatures.length > 0,
    "unsigned DSSE bundle is forbidden",
  );
  check(
    envelope.payloadType === DSSE_IN_TOTO_PAYLOAD_TYPE,
    `DSSE payloadType must be exactly ${DSSE_IN_TOTO_PAYLOAD_TYPE}`,
  );
  const material = record(
    bundle.verificationMaterial,
    "Sigstore verification material",
  );
  check(
    Array.isArray(material.tlogEntries) && material.tlogEntries.length === 1,
    "exactly one Sigstore transparency-log entry is required",
  );
  const tlog = record(
    material.tlogEntries[0],
    "Sigstore transparency-log entry",
  );
  positiveInteger(tlog.logIndex, "Sigstore logIndex");
  positiveInteger(tlog.integratedTime, "Sigstore integratedTime");
  const decoded = record(
    JSON.parse(decodeBase64(envelope.payload, "DSSE payload").toString("utf8")),
    "in-toto statement",
  );
  const requiredType = REQUIRED_STATEMENT_TYPE.get(predicateType);
  check(
    requiredType !== undefined,
    `unrecognised attestation predicate type ${predicateType}`,
  );
  check(
    decoded._type === requiredType,
    `in-toto statement type for ${predicateType} must be exactly ${requiredType}`,
  );
  check(
    decoded.predicateType === predicateType,
    "attestation predicate types disagree",
  );
  check(
    Array.isArray(decoded.subject) && decoded.subject.length === 1,
    "attestation must have one subject",
  );
  const subject = record(decoded.subject[0], "attestation subject");
  check(
    subject.name === packagePurl(value.name, value.version) &&
      record(subject.digest, "subject digest").sha512 ===
        integrityHex(value.integrity),
    "attestation subject disagrees with the package digest",
  );
  return decoded;
}

export function verifyAttestations(
  value: ReleaseCandidate,
  input: unknown,
): void {
  check(
    Array.isArray(input),
    "npm audit did not return cryptographically verified attestation bundles",
  );
  const statements = input.map((entry) => auditedStatement(entry, value));
  const publish = statements.filter(
    (entry) => entry.predicateType === PUBLISH_PREDICATE,
  );
  const provenance = statements.filter(
    (entry) => entry.predicateType === PROVENANCE_PREDICATE,
  );
  check(
    publish.length === 1 && provenance.length === 1,
    "exactly one npm publish and one SLSA provenance attestation are required",
  );
  const published = record(publish[0]!.predicate, "publish predicate");
  check(
    published.name === value.name &&
      published.version === value.version &&
      published.registry === REGISTRY,
    "publish attestation disagrees",
  );
  const provenancePredicate = record(
    provenance[0]!.predicate,
    "provenance predicate",
  );
  const build = record(
    provenancePredicate.buildDefinition,
    "build definition",
  );
  check(
    build.buildType === GITHUB_ACTIONS_BUILD_TYPE,
    "provenance build type is not GitHub Actions",
  );
  const workflow = record(
    record(build.externalParameters, "external parameters").workflow,
    "workflow",
  );
  check(
    workflow.repository === `https://github.com/${value.repository}` &&
      workflow.path === value.workflow &&
      workflow.ref === `refs/tags/${value.tag}`,
    "provenance workflow, repository, or tag disagrees",
  );
  check(
    Array.isArray(build.resolvedDependencies) &&
      build.resolvedDependencies.some((entry) => {
        const dependency =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as RecordValue)
            : {};
        const digest =
          dependency.digest &&
          typeof dependency.digest === "object" &&
          !Array.isArray(dependency.digest)
            ? (dependency.digest as RecordValue)
            : {};
        return digest.gitCommit === value.commit;
      }),
    "provenance does not bind the release commit",
  );
  const runDetails = record(provenancePredicate.runDetails, "run details");
  check(
    record(runDetails.builder, "builder").id === GITHUB_ACTIONS_BUILDER,
    "provenance builder is not the GitHub-hosted Actions runner",
  );
  check(
    text(record(runDetails.metadata, "run metadata").invocationId, "invocation ID")
      .startsWith(`https://github.com/${value.repository}/actions/runs/`),
    "provenance invocation does not belong to the release repository",
  );
}

export function extractVerifiedAttestations(
  value: ReleaseCandidate,
  input: unknown,
): unknown[] {
  const audit = record(input, "npm audit signatures result");
  check(
    Array.isArray(audit.invalid) && audit.invalid.length === 0,
    "npm reported invalid signatures",
  );
  check(
    Array.isArray(audit.missing) && audit.missing.length === 0,
    "npm reported missing signatures",
  );
  check(
    Array.isArray(audit.verified),
    "npm audit signatures did not report verified packages",
  );
  const expectedLocation = `node_modules/${value.name}`;
  const verified = audit.verified
    .map((entry, index) => record(entry, `npm verified entry ${index}`))
    .find(
      (entry) =>
        entry.name === value.name &&
        entry.version === value.version &&
        entry.location === expectedLocation,
    );
  check(
    verified,
    `npm did not cryptographically verify ${value.name}@${value.version}`,
  );
  check(
    Array.isArray(verified.attestationBundles) &&
      verified.attestationBundles.length > 0,
    "npm did not return the verified attestation bundles",
  );
  return verified.attestationBundles;
}

export function installArguments(value: ReleaseCandidate): string[] {
  return [
    "install",
    "--ignore-scripts",
    "--audit=false",
    "--fund=false",
    "--save-exact",
    `${value.name}@${value.version}`,
    "--registry",
    REGISTRY,
  ];
}

export function auditArguments(): string[] {
  return [
    "audit",
    "signatures",
    "--json",
    "--include-attestations",
    "--registry",
    REGISTRY,
  ];
}

export function assertExactCliVersion(
  value: ReleaseCandidate,
  stdout: string,
): void {
  check(
    stdout.trim() === value.version,
    `mementos --version returned ${stdout.trim() || "<empty>"}`,
  );
}

function verifyExactInstallAndAttestations(
  value: ReleaseCandidate,
): unknown[] {
  const root = mkdtempSync(join(tmpdir(), "mementos-consumer-"));
  const cache = join(root, ".npm-cache");
  try {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ private: true })}\n`,
      { mode: 0o600 },
    );
    run("npm", [...installArguments(value), "--cache", cache], root, {
      timeoutMs: 300_000,
    });
    const packageRoot = join(root, "node_modules", ...value.name.split("/"));
    const installed = record(
      JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")),
      "installed package",
    );
    check(
      installed.name === value.name && installed.version === value.version,
      "exact install resolved another version",
    );
    const cliPath = join(packageRoot, "dist", "cli", "index.js");
    const cliStat = lstatSync(cliPath);
    check(
      cliStat.isFile() && !cliStat.isSymbolicLink(),
      "installed Mementos CLI is not a regular file",
    );
    assertExactCliVersion(value, run("bun", [cliPath, "--version"], root));
    const audit = JSON.parse(
      run("npm", [...auditArguments(), "--cache", cache], root, {
        timeoutMs: 300_000,
      }),
    ) as unknown;
    return extractVerifiedAttestations(value, audit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function parseRetryOptions(
  attemptsInput: string,
  delayInput: string,
): { attempts: number; delayMs: number } {
  const attempts = Number(attemptsInput);
  const delayMs = Number(delayInput);
  check(
    Number.isInteger(attempts) && attempts > 0 && attempts <= 6,
    "attempts must be between 1 and 6",
  );
  check(
    Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 10_000,
    "delay must be between 0 and 10000 ms",
  );
  check(
    (attempts - 1) * delayMs <= 60_000,
    "retry delay budget exceeds 60 seconds",
  );
  return { attempts, delayMs };
}

export async function verifyRegistryReleaseAttempt(
  value: ReleaseCandidate,
  phase: RegistryPhase,
  operations: RegistryReleaseAttemptOperations,
): Promise<void> {
  const urls = verifyRegistryMetadata(
    value,
    await operations.readVersionMetadata(),
  );
  verifyDistTags(value, await operations.readPackageMetadata(), phase);
  verifyDownloadedTarball(
    value,
    await operations.readTarball(urls.tarballUrl),
  );
  await operations.awaitInstallVisibility();
  verifyAttestations(value, operations.verifyConsumer());
  verifyDistTags(value, await operations.readPackageMetadata(), phase);
}

async function retryLane<T>(
  label: string,
  attempts: number,
  delayMs: number,
  operation: () => Promise<T> | T,
): Promise<T> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt < attempts) {
        console.log(
          `${label} attempt ${attempt}/${attempts} failed; retrying only this lane`,
        );
        await Bun.sleep(delayMs);
      }
    }
  }
  throw failure;
}

async function verifyRegistryRelease(
  value: ReleaseCandidate,
  phase: RegistryPhase,
  attempts: number,
  delayMs: number,
): Promise<void> {
  const readPackageMetadata = createOriginPackumentReader(value.name);
  const readInstallPackument = createInstallPackumentReader(value.name);
  const urls = await retryLane(
    "version metadata and advertised provenance",
    attempts,
    delayMs,
    async () =>
      verifyRegistryMetadata(
        value,
        await fetchJson(packageUrl(value.name, value.version)),
      ),
  );
  await retryLane("full packument", attempts, delayMs, async () => {
    verifyDistTags(value, await readPackageMetadata(), phase);
  });
  await retryLane("registry tarball", attempts, delayMs, async () => {
    verifyDownloadedTarball(
      value,
      await fetchLimited(urls.tarballUrl, MAX_TARBALL_BYTES),
    );
  });
  await waitForInstallVisibility(value, {
    readInstallPackument,
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
  });
  await retryLane("exact install and npm signature audit", attempts, delayMs, () => {
    verifyAttestations(value, verifyExactInstallAndAttestations(value));
  });
  await retryLane("terminal full packument", attempts, delayMs, async () => {
    verifyDistTags(value, await readPackageMetadata(), phase);
  });
  console.log(
    `verified ${value.name}@${value.version}: registry bytes, gitHead, ` +
      `full and install packuments, npm signatures, provenance semantics, ` +
      `${phase} dist-tags, exact install, and CLI agree`,
  );
}

function parseStableVersion(value: string): [bigint, bigint, bigint] {
  const match = value.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
  );
  check(match, `${value} is not a stable canonical SemVer`);
  return [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)];
}

function compareStable(left: string, right: string): number {
  const leftParts = parseStableVersion(left);
  const rightParts = parseStableVersion(right);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

export function promotionSnapshot(
  value: ReleaseCandidate,
  input: unknown,
): PromotionSnapshot {
  const metadata = record(input, "registry package metadata");
  const versions = record(metadata.versions, "registry versions");
  check(
    Object.prototype.hasOwnProperty.call(versions, value.version),
    `candidate ${value.version} is absent from registry versions`,
  );
  const stable = Object.keys(versions).filter((version) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version),
  );
  check(stable.length > 0, "registry has no stable versions");
  const highestStable = stable.reduce((highest, current) =>
    compareStable(current, highest) > 0 ? current : highest,
  );
  const tags = record(metadata["dist-tags"], "dist-tags");
  const latest =
    typeof tags[value.intendedTag] === "string"
      ? (tags[value.intendedTag] as string)
      : undefined;
  const staging =
    typeof tags[value.stagingTag] === "string"
      ? (tags[value.stagingTag] as string)
      : undefined;
  return { latest, staging, highestStable };
}

function assertPromotionAllowed(
  value: ReleaseCandidate,
  snapshot: PromotionSnapshot,
): "promote" | "idempotent" {
  parseStableVersion(value.version);
  check(
    snapshot.staging === value.version,
    `${value.stagingTag} does not point to ${value.version}`,
  );
  check(
    snapshot.highestStable === value.version,
    `refusing to promote ${value.version}; registry highest stable is ${snapshot.highestStable}`,
  );
  if (snapshot.latest === value.version) return "idempotent";
  if (snapshot.latest !== undefined) {
    check(
      compareStable(value.version, snapshot.latest) > 0,
      `refusing stale or downgrade promotion of ${value.version} over ${snapshot.latest}`,
    );
  }
  return "promote";
}

export async function promoteLatestMonotonically(
  value: ReleaseCandidate,
  operations: PromotionOperations,
): Promise<"promoted" | "idempotent"> {
  const initial = promotionSnapshot(value, await operations.readPackage());
  if (assertPromotionAllowed(value, initial) === "idempotent") return "idempotent";

  const immediatelyBefore = promotionSnapshot(
    value,
    await operations.readPackage(),
  );
  if (assertPromotionAllowed(value, immediatelyBefore) === "idempotent") {
    return "idempotent";
  }

  let mutationFailure: unknown;
  try {
    operations.setLatest(value.version);
  } catch (error) {
    mutationFailure = error;
  }

  const after = promotionSnapshot(value, await operations.readPackage());
  if (
    after.latest === value.version &&
    after.highestStable === value.version &&
    after.staging === value.version
  ) {
    return "promoted";
  }

  if (
    compareStable(after.highestStable, value.version) > 0 &&
    after.latest !== after.highestStable
  ) {
    operations.setLatest(after.highestStable);
    const compensated = promotionSnapshot(
      value,
      await operations.readPackage(),
    );
    check(
      compensated.latest === after.highestStable,
      `failed to restore newer stable ${after.highestStable} after promotion race`,
    );
    throw new Error(
      `candidate ${value.version} was superseded by newer stable ` +
        `${after.highestStable}; registry latest was restored`,
    );
  }

  const detail =
    mutationFailure instanceof Error
      ? ` (${mutationFailure.message})`
      : mutationFailure
        ? ` (${String(mutationFailure)})`
        : "";
  throw new Error(
    `promotion did not converge; latest is ${after.latest ?? "<absent>"}${detail}`,
  );
}

export function publishArguments(value: ReleaseCandidate): string[] {
  return [
    "publish",
    value.artifactPath,
    "--ignore-scripts",
    "--provenance",
    "--access",
    "public",
    "--tag",
    value.stagingTag,
    "--registry",
    REGISTRY,
  ];
}

export function promoteArguments(
  value: ReleaseCandidate,
  version: string,
): string[] {
  return [
    "dist-tag",
    "add",
    `${value.name}@${version}`,
    value.intendedTag,
    "--registry",
    REGISTRY,
  ];
}

async function promoteDistTag(
  root: string,
  manifest: Manifest,
  value: ReleaseCandidate,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  assertReleaseEnvironment(root, manifest, env);
  assertPromotionEnvironment(env);
  assertCandidateContext(value, manifest, env);
  verifyCandidateArtifact(value);
  const readPackage = createOriginPackumentReader(value.name);
  const result = await promoteLatestMonotonically(value, {
    readPackage,
    setLatest: (version) => {
      run("npm", promoteArguments(value, version), root, {
        inherit: true,
        timeoutMs: 120_000,
      });
    },
  });
  console.log(
    result === "idempotent"
      ? `${value.name}@${value.version} was already ${value.intendedTag}`
      : `promoted ${value.name}@${value.version} to ${value.intendedTag}`,
  );
}

function option(args: string[], name: string, fallback?: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? fallback : args[index + 1];
  check(value && !value.startsWith("--"), `missing ${name}`);
  return value;
}

function writeState(state: PublicationState): void {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `state=${state}\n`, {
      encoding: "utf8",
    });
  }
  console.log(`publication-state=${state}`);
}

async function main(): Promise<void> {
  const root = resolve(process.cwd());
  const [subcommand, ...args] = process.argv.slice(2);
  const manifest = loadManifest(root);
  if (subcommand === "candidate") {
    assertReleaseEnvironment(root, manifest, process.env);
    const artifactPath = resolve(option(args, "--artifact"));
    const commit = exactCommit(
      text(process.env.GITHUB_SHA, "GITHUB_SHA"),
      "GITHUB_SHA",
    );
    const pack = verifyDeterministicPack(root, artifactPath, commit);
    const value = candidateFrom(manifest, pack, commit, artifactPath);
    const output = resolve(option(args, "--out"));
    writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`wrote release candidate ${output}`);
  } else if (subcommand === "ensure-unpublished") {
    const value = loadCandidate(resolve(option(args, "--candidate")));
    verifyCandidateArtifact(value);
    writeState(await ensurePublishable(value));
  } else if (subcommand === "publish-staged") {
    assertReleaseEnvironment(root, manifest, process.env);
    assertPublishEnvironment(process.env);
    const value = loadCandidate(resolve(option(args, "--candidate")));
    assertCandidateContext(value, manifest, process.env);
    verifyCandidateArtifact(value);
    const state = await ensurePublishable(value);
    if (state === "unpublished") {
      run("npm", publishArguments(value), root, {
        inherit: true,
        timeoutMs: 300_000,
      });
      writeState("staged");
    } else {
      console.log(
        `skipping publish: ${value.name}@${value.version} is already ${state}`,
      );
      writeState(state);
    }
  } else if (subcommand === "verify-registry") {
    const value = loadCandidate(resolve(option(args, "--candidate")));
    verifyCandidateArtifact(value);
    const retry = parseRetryOptions(
      option(args, "--attempts", "4"),
      option(args, "--delay-ms", "5000"),
    );
    const phase = option(args, "--phase", "staged");
    check(
      phase === "staged" || phase === "promoted",
      "phase must be staged or promoted",
    );
    await verifyRegistryRelease(
      value,
      phase,
      retry.attempts,
      retry.delayMs,
    );
  } else if (subcommand === "promote") {
    await promoteDistTag(
      root,
      manifest,
      loadCandidate(resolve(option(args, "--candidate"))),
      process.env,
    );
  } else {
    throw new Error(
      "usage: release-provenance.ts candidate --out FILE --artifact FILE | " +
        "ensure-unpublished --candidate FILE | publish-staged --candidate FILE | " +
        "verify-registry --candidate FILE [--phase staged|promoted] | " +
        "promote --candidate FILE",
    );
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `release provenance failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  });
}
