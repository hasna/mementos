// ============================================================================
// Route matching infrastructure
// ============================================================================

export type RouteHandler = (
  req: Request,
  url: URL,
  params: Record<string, string>
) => Promise<Response> | Response;

export interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  paramNames: string[];
  specificity: number;
  order: number;
  handler: RouteHandler;
}

export const routes: Route[] = [];
let nextRouteOrder = 0;

function computeSpecificity(path: string): number {
  return path
    .split("/")
    .filter(Boolean)
    .reduce((score, segment) => score + (segment.startsWith(":") ? 1 : 10), 0);
}

export function addRoute(
  method: string,
  path: string,
  handler: RouteHandler
): void {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_match, name: string) => {
    paramNames.push(name);
    return "([^/]+)";
  });
  routes.push({
    method,
    path,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    specificity: computeSpecificity(path),
    order: nextRouteOrder++,
    handler,
  });
}

export function matchRoute(
  method: string,
  pathname: string
): { handler: RouteHandler; params: Record<string, string> } | null {
  let bestMatch:
    | {
        route: Route;
        params: Record<string, string>;
      }
    | null = null;

  for (const route of routes) {
    if (route.method !== method) continue;
    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1]!;
      });

      if (
        !bestMatch ||
        route.specificity > bestMatch.route.specificity ||
        (route.specificity === bestMatch.route.specificity &&
          route.order < bestMatch.route.order)
      ) {
        bestMatch = { route, params };
      }
    }
  }

  if (!bestMatch) return null;
  return { handler: bestMatch.route.handler, params: bestMatch.params };
}
