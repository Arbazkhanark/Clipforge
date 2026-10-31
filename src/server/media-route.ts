// GET /api/media/file?id=<mediaId>&variant=thumbnail|preview|download  (Web Request -> Response)
// Same-origin only (no hotlinking from other sites). Errors carry no internal details.
import { AppError, toHttpResult } from "./errors.ts";
import { serveMedia } from "./handlers/media-serve.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";

export function mediaFileRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
      const url = new URL(request.url);
      const ctx = await buildContext(runtime(), request);
      const served = await serveMedia(ctx, { mediaId: url.searchParams.get("id"), variant: url.searchParams.get("variant") ?? "thumbnail", rangeHeader: request.headers.get("range") });
      return new Response(served.body, { status: served.status, headers: served.headers });
    } catch (error) {
      const result = toHttpResult(error);
      return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
  };
}
