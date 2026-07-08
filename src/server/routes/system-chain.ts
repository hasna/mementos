import { getDatabase } from "../../db/database.js";
import { getMemoryChain } from "../../db/memories.js";
import { addRoute } from "../router.js";
import { json, getSearchParams } from "../helpers.js";

export function registerSystemChainRoutes(): void {
  addRoute("GET", "/api/chains/:sequence_group", (_req: Request, url: URL, params) => {
    const sequenceGroup = decodeURIComponent(params["sequence_group"]!);
    const projectId = getSearchParams(url)["project_id"];
    const chain = getMemoryChain(sequenceGroup, projectId, getDatabase());
    return json({ chain, count: chain.length, sequence_group: sequenceGroup });
  });
}
