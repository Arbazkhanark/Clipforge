// GET /api/media/file?id=<mediaId>&variant=thumbnail|preview|download  (Web Request -> Response)
// Same-origin only (no hotlinking from other sites). Errors carry no internal details.
import { randomUUID } from "node:crypto";
import { AppError, toHttpResult } from "./errors.ts";
import { serveMedia } from "./handlers/media-serve.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";

type MediaFileVariant = "thumbnail" | "original";

function safeDiagnosticValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value) ? value : undefined;
}

function logMediaServeFailure(requestId: string, variant: MediaFileVariant, error: unknown): void {
  let errorName: string | undefined;
  let errorCode: string | undefined;
  let storageHttpStatus: number | undefined;
  try {
    if (typeof error === "object" && error !== null) {
      const value = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
      errorName = safeDiagnosticValue(value.name);
      errorCode = safeDiagnosticValue(value.code);
      const status = value.$metadata?.httpStatusCode;
      if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) storageHttpStatus = status;
    }
  } catch {
    // Diagnostics must not interfere with the generic error response.
  }
  console.error(JSON.stringify({
    event: "media_file_serve_failed",
    requestId,
    variant,
    errorCategory: "unexpected_media_serve_failure",
    errorType: error instanceof Error ? "exception" : "unknown",
    ...(errorName ? { errorName } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(storageHttpStatus ? { storageHttpStatus } : {}),
  }));
}

export function mediaFileRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    let variant: MediaFileVariant = "thumbnail";
    try {
      if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
      const url = new URL(request.url);
      const requestedVariant = url.searchParams.get("variant");
      variant = requestedVariant === null || requestedVariant === "thumbnail" ? "thumbnail" : "original";
      const ctx = await buildContext(runtime(), request);
      const served = await serveMedia(ctx, { mediaId: url.searchParams.get("id"), variant: requestedVariant ?? "thumbnail", rangeHeader: request.headers.get("range") });
      return new Response(served.body, { status: served.status, headers: served.headers });
    } catch (error) {
      const result = toHttpResult(error);
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      if (result.status === 500) {
        logMediaServeFailure(requestId, variant, error);
        return Response.json(result.body, { status: result.status, headers: { ...headers, "X-Request-Id": requestId } });
      }
      return Response.json(result.body, { status: result.status, headers });
    }
  };
}
