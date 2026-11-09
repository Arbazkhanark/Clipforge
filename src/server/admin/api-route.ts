import { checkSameOrigin } from "../http.ts";
import { AppError, toHttpResult } from "../errors.ts";
import { getRuntime, type Runtime } from "../runtime.ts";
import { requireAdmin } from "./authorization.ts";

const NO_STORE = { "Cache-Control": "no-store" };
type AdminHandler = (request: Request, adminUserId: string) => Promise<Response>;

function validateAdminRequestOrigin(request: Request): AppError | null {
  const method = request.method.toUpperCase();
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (!mutating) return checkSameOrigin(request);

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (!origin) return new AppError(403, "cross_site_request", "A same-origin request is required.");
  try {
    // URL.origin compares scheme, hostname, and effective port (including default-port normalization).
    if (new URL(origin).origin !== new URL(request.url).origin) {
      return new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
    }
  } catch {
    return new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
  }
  return null;
}

/**
 * Wrap every future /api/admin route with this boundary. Authorization runs before the handler,
 * and the actor ID comes only from the authenticated session and persisted role.
 */
export function adminApiRoute(handler: AdminHandler, runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const invalidOrigin = validateAdminRequestOrigin(request);
      if (invalidOrigin) throw invalidOrigin;
      const actorId = await requireAdmin(runtime(), request);
      const response = await handler(request, actorId);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } catch (error) {
      const result = toHttpResult(error);
      return Response.json(result.body, { status: result.status, headers: NO_STORE });
    }
  };
}
