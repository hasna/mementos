import { getDatabase } from "../../db/database.js";
import { addRoute } from "../router.js";
import { json } from "../helpers.js";

export function registerSystemChainRoutes(): void {
  addRoute("GET", "/api/chains/:sequence_group", (_req: Request, _url: URL, params) => {
    const db = getDatabase();
    const sequenceGroup = decodeURIComponent(params["sequence_group"]!);

    const rows = db.query(
      `SELECT * FROM memories WHERE sequence_group = ? AND status = 'active' ORDER BY sequence_order ASC`
    ).all(sequenceGroup) as Record<string, unknown>[];

    if (rows.length === 0) {
      return json({ chain: [], count: 0, sequence_group: sequenceGroup });
    }

    return json({ chain: rows, count: rows.length, sequence_group: sequenceGroup });
  });
}
