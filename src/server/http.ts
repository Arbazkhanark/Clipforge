// Turns a handler into a Web-standard route (Request -> Response). Uses only standard Request/Response,
// so it works in Next.js Route Handlers AND can be tested in plain Node.
//
// Protections (the session cookie will be added with real authentication):
//  - JSON only (a plain HTML form from another site cannot send application/json cross-origin without a preflight),
//  - cross-site requests are refused (Origin must match our host; Sec-Fetch-Site must not be "cross-site"),
//  - request body size is capped, responses are never cached, errors never leak internals.
import type { RequestContext } from "./context.ts";
import { AppError, toHttpResult } from "./errors.ts";
import { buildContext, type Runtime, getRuntime } from "./runtime.ts";

export const MAX_JSON_BODY_BYTES = 1_000_000;
const NO_STORE = { "Cache-Control": "no-store" };

function jsonResponse(body: unknown, status: number): Response { return Response.json(body, { status, headers: NO_STORE }); }

export function checkSameOrigin(request: Request): AppError | null {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite === "cross-site") return new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost: string;
    try { originHost = new URL(origin).host; } catch { return new AppError(403, "cross_site_request", "Cross-site requests are not allowed."); }
    const ownHost = request.headers.get("host") ?? new URL(request.url).host;
    if (originHost !== ownHost) return new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
  }
  return null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) throw new AppError(415, "unsupported_media_type", "Send the request as application/json.");
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BODY_BYTES) throw new AppError(413, "payload_too_large", "The request is too large.");
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) throw new AppError(413, "payload_too_large", "The request is too large.");
  try { return JSON.parse(text); } catch { throw new AppError(400, "invalid_json", "The request body is not valid JSON."); }
}

export function jsonRoute(handler: (ctx: RequestContext, body: unknown) => Promise<unknown>, runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const crossSite = checkSameOrigin(request);
      if (crossSite) throw crossSite;
      const body = await readJsonBody(request);
      const ctx = await buildContext(runtime());
      return jsonResponse(await handler(ctx, body), 200);
    } catch (error) {
      const result = toHttpResult(error);
      return jsonResponse(result.body, result.status);
    }
  };
}
