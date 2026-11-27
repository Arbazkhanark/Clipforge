// GET /api/media/file?id=<mediaId>&variant=thumbnail|preview|download  (Web Request -> Response)
// Same-origin only (no hotlinking from other sites). Errors carry no internal details.
import { randomUUID } from "node:crypto";
import { AppError, toHttpResult } from "./errors.ts";
import { serveMedia } from "./handlers/media-serve.ts";
import { buildContext, getRuntime, type Runtime } from "./runtime.ts";
import { classifyMediaUploadError, mediaUploadOperationFor, safeDeploymentEnvironment, withMediaUploadDiagnosticContext, type MediaUploadDiagnosticContext } from "./storage/media-upload-diagnostics.ts";

type MediaFileVariant = "thumbnail" | "original";

function logMediaServeFailure(requestId: string, variant: MediaFileVariant, operation: string, context: MediaUploadDiagnosticContext, error: unknown): void {
  const info = classifyMediaUploadError(error, operation);
  console.error(JSON.stringify({
    event: "media_file_serve_failed",
    timestamp: new Date().toISOString(),
    requestId,
    variant,
    operation,
    provider: context.provider,
    environment: context.environment,
    errorType: error instanceof Error ? "exception" : "unknown",
    ...info,
  }));
}

export function mediaFileRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    let variant: MediaFileVariant = "thumbnail";
    let url: URL;
    let requestedVariant: string | null;
    try {
      if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError(403, "cross_site_request", "Cross-site requests are not allowed.");
      url = new URL(request.url);
      requestedVariant = url.searchParams.get("variant");
      variant = requestedVariant === null || requestedVariant === "thumbnail" ? "thumbnail" : "original";
    } catch (error) {
      const result = toHttpResult(error);
      const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
      return Response.json(result.body, { status: result.status, headers });
    }
    const diagnosticContext: MediaUploadDiagnosticContext = {
      requestId,
      environment: safeDeploymentEnvironment(process.env),
      provider: "unavailable",
      logOperations: false,
    };
    return withMediaUploadDiagnosticContext(diagnosticContext, async () => {
      let operation = "runtime.context_build";
      try {
        const ctx = await buildContext(runtime(), request);
        diagnosticContext.provider = ctx.media?.storage.kind ?? "unavailable";
        operation = "media.serve";
        const served = await serveMedia(ctx, { mediaId: url.searchParams.get("id"), variant: requestedVariant ?? "thumbnail", rangeHeader: request.headers.get("range") });
        operation = "response.construct";
        const headers = new Headers(served.headers);
        headers.set("X-Request-Id", requestId);
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(served.body, { status: served.status, headers });
      } catch (error) {
        const result = toHttpResult(error);
        const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        if (result.status === 500) {
          const failedOperation = mediaUploadOperationFor(error) ?? operation;
          logMediaServeFailure(requestId, variant, failedOperation, diagnosticContext, error);
          return Response.json(result.body, { status: result.status, headers: { ...headers, "X-Request-Id": requestId } });
        }
        return Response.json(result.body, { status: result.status, headers });
      }
    });
  };
}
