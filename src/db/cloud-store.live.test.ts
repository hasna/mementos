// Live conformance test: drives the memories REPOSITORY (createMemory/getMemory/
// listMemories/deleteMemory) with the client flipped to self_hosted, proving the
// repo layer routes ALL reads+writes to the cloud HTTP API. Skips cleanly when
// the cloud env is not configured (offline / CI without secrets).
//
// Enable by exporting:
//   HASNA_MEMENTOS_STORAGE_MODE=self_hosted
//   HASNA_MEMENTOS_API_URL=https://mementos.hasna.xyz
//   HASNA_MEMENTOS_API_KEY=<key>

import { describe, expect, test } from "bun:test";
import { createMemory, deleteMemory, getMemory, listMemories } from "./memories.js";
import { resetCloudConfigCache } from "./cloud-store.js";

const HAS_CLOUD =
  Boolean(process.env.HASNA_MEMENTOS_API_URL || process.env.MEMENTOS_API_URL) &&
  Boolean(process.env.HASNA_MEMENTOS_API_KEY || process.env.MEMENTOS_API_KEY) &&
  /cloud|self_hosted|remote|hybrid/i.test(
    process.env.HASNA_MEMENTOS_STORAGE_MODE ?? process.env.MEMENTOS_STORAGE_MODE ?? "",
  );

const maybe = HAS_CLOUD ? test : test.skip;

describe("live cloud memories CRUD via repository (self_hosted)", () => {
  maybe("create -> get -> list -> delete round-trips against the cloud API", () => {
    resetCloudConfigCache();
    const key = `__live_repo_probe__${Date.now()}`;

    const created = createMemory({ key, value: "live repo probe", category: "fact", scope: "global" }, "create");
    expect(created.id).toBeTruthy();
    expect(created.key).toBe(key);

    const fetched = getMemory(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.value).toBe("live repo probe");

    const listed = listMemories({ search: "live repo probe", limit: 500 });
    expect(listed.some((m) => m.id === created.id)).toBe(true);

    const deleted = deleteMemory(created.id);
    expect(deleted).toBe(true);

    expect(getMemory(created.id)).toBeNull();
  });
});
