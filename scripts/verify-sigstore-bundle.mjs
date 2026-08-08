import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verify } from "sigstore";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) {
  inputBytes += chunk.length;
  if (inputBytes > MAX_INPUT_BYTES) {
    throw new Error(`Sigstore verification input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  chunks.push(chunk);
}

const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!request || typeof request !== "object" || Array.isArray(request)) {
  throw new Error("Sigstore verification request must be an object");
}
const { bundle, policy } = request;
if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
  throw new Error("Sigstore verification bundle must be an object");
}
if (
  !policy ||
  typeof policy !== "object" ||
  Array.isArray(policy) ||
  typeof policy.certificateIssuer !== "string" ||
  typeof policy.certificateIdentityURI !== "string" ||
  !policy.certificateIdentityURI.startsWith("^") ||
  !policy.certificateIdentityURI.endsWith("$")
) {
  throw new Error("Sigstore verification requires an anchored certificate policy");
}

const tufCachePath = mkdtempSync(join(tmpdir(), "mementos-sigstore-tuf-"));
try {
  await verify(bundle, {
    certificateIssuer: policy.certificateIssuer,
    certificateIdentityURI: policy.certificateIdentityURI,
    tufCachePath,
    tufForceCache: true,
  });
  console.log("verified Sigstore certificate identity");
} finally {
  rmSync(tufCachePath, { recursive: true, force: true });
}
