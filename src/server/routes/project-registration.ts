import { getDatabase } from "../../db/database.js";
import {
  createMementosProjectRegistrationAuthority,
  handleMementosProjectRegistrationHttpRequest,
} from "../../project-registration/index.js";
import { addRoute, type RouteHandler } from "../router.js";

const handle: RouteHandler = async (request, url) => {
  const basePath = url.pathname.startsWith("/v1/")
    ? "/v1/project-registration"
    : "/api/project-registration";
  const response = await handleMementosProjectRegistrationHttpRequest(
    request,
    url,
    createMementosProjectRegistrationAuthority(getDatabase()),
    basePath,
  );
  return response ?? new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
};

addRoute("GET", "/api/project-registration", handle);
addRoute("GET", "/api/project-registration/capability", handle);
addRoute("POST", "/api/project-registration/create", handle);
addRoute("POST", "/api/project-registration/receipts/lookup", handle);
addRoute("POST", "/api/project-registration/read-exact", handle);
addRoute("POST", "/api/project-registration/compensate", handle);
addRoute("POST", "/api/project-registration/verify-inverse", handle);
