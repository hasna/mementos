import { runSynthesis, rollbackSynthesis, getSynthesisStatus } from "../../lib/synthesis/index.js";
import { listSynthesisRuns } from "../../db/synthesis.js";
import { synthesizeProfile } from "../../lib/profile-synthesizer.js";
import { addRoute } from "../router.js";
import { json, readJson, getSearchParams } from "../helpers.js";

export function registerSystemSynthesisRoutes(): void {
  addRoute("POST", "/api/synthesis/run", async (req) => {
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    const result = await runSynthesis({
      projectId: body.project_id as string | undefined,
      agentId: body.agent_id as string | undefined,
      dryRun: body.dry_run as boolean | undefined,
      maxProposals: body.max_proposals as number | undefined,
      provider: body.provider as string | undefined,
    });
    return json(result, result.dryRun ? 200 : 201);
  });

  addRoute("GET", "/api/synthesis/runs", (_req, url) => {
    const projectId = url.searchParams.get("project_id") ?? undefined;
    const limit = url.searchParams.get("limit") ? parseInt(url.searchParams.get("limit")!) : 20;
    const runs = listSynthesisRuns({ project_id: projectId, limit });
    return json({ runs, count: runs.length });
  });

  addRoute("GET", "/api/synthesis/status", (_req, url) => {
    const projectId = url.searchParams.get("project_id") ?? undefined;
    const runId = url.searchParams.get("run_id") ?? undefined;
    return json(getSynthesisStatus(runId, projectId));
  });

  addRoute("POST", "/api/synthesis/rollback/:run_id", async (_req, _url, params) => {
    const result = await rollbackSynthesis(params["run_id"]!);
    return json(result);
  });

  addRoute("GET", "/api/profile/synthesize", async (_req: Request, url: URL) => {
    const q = getSearchParams(url);
    const result = await synthesizeProfile({
      project_id: q["project_id"] || undefined,
      agent_id: q["agent_id"] || undefined,
      force_refresh: q["force_refresh"] === "true",
    });

    if (!result) {
      return json({ profile: null, message: "No preference/fact memories found to synthesize" });
    }

    return json(result);
  });
}
