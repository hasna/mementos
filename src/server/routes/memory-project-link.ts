import {
  applyMemoryProjectLink,
  getMemoryProjectLinkReceipt,
  MemoryProjectLinkError,
  previewMemoryProjectLink,
  rollbackMemoryProjectLink,
} from "../../db/memory-project-link.js";
import type {
  MemoryProjectLinkRequest,
  MemoryProjectLinkRollbackRequest,
  ProjectAuthorityIdentity,
} from "../../types/index.js";
import { addRoute } from "../router.js";
import { errorResponse, json, readJson } from "../helpers.js";

function linkError(error: MemoryProjectLinkError): Response {
  const status = error.code === "MEMORY_PROJECT_LINK_AUTHORITY_MISMATCH"
    ? 403
    : error.code === "MEMORY_PROJECT_LINK_MEMORY_NOT_FOUND"
      || error.code === "MEMORY_PROJECT_LINK_PROJECT_NOT_FOUND"
      || error.code === "MEMORY_PROJECT_LINK_RECEIPT_NOT_FOUND"
      ? 404
      : error.code === "MEMORY_PROJECT_LINK_INVALID_INPUT"
        ? 400
        : 409;
  return errorResponse(error.message, status, { code: error.code, ...error.details });
}

addRoute("POST", "/api/memories/:id/guarded-project-link", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return errorResponse("Invalid JSON body", 400);
  try {
    const request = body as unknown as MemoryProjectLinkRequest & { dry_run?: boolean };
    return json(request.dry_run
      ? previewMemoryProjectLink(params["id"]!, request)
      : applyMemoryProjectLink(params["id"]!, request));
  } catch (error) {
    if (error instanceof MemoryProjectLinkError) return linkError(error);
    throw error;
  }
});

addRoute("POST", "/api/memories/:id/guarded-project-link-rollback", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body) return errorResponse("Invalid JSON body", 400);
  try {
    return json(rollbackMemoryProjectLink(
      params["id"]!,
      body as unknown as MemoryProjectLinkRollbackRequest,
    ));
  } catch (error) {
    if (error instanceof MemoryProjectLinkError) return linkError(error);
    throw error;
  }
});

addRoute("POST", "/api/memories/:id/project-link-receipts/lookup", async (req, _url, params) => {
  const body = (await readJson(req)) as Record<string, unknown> | null;
  if (!body || typeof body["receipt_id"] !== "string") {
    return errorResponse("receipt_id is required", 400);
  }
  try {
    const identity: ProjectAuthorityIdentity = {
      authority_id: String(body["authority_id"] ?? ""),
      tenant_id: String(body["tenant_id"] ?? ""),
      corpus_id: String(body["corpus_id"] ?? ""),
    };
    return json(getMemoryProjectLinkReceipt(
      params["id"]!,
      body["receipt_id"],
      identity,
    ));
  } catch (error) {
    if (error instanceof MemoryProjectLinkError) return linkError(error);
    throw error;
  }
});
