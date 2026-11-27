// POST /api/forms/media-upload (and JSON when the caller asks for it). Multipart is buffered in memory and kept
// single-file per request; the selected private MediaStorage adapter handles staging, validation and commit.
import { randomUUID } from "node:crypto";
import { AppError, toHttpResult } from "./errors.ts";
import { buildFlashLocation, flashCodeForError } from "./flash.ts";
import { redirectResponse } from "./form-routes.ts";
import { checkSameOrigin } from "./http.ts";
import { uploadMedia } from "./handlers/media-upload.ts";
import { DEFAULT_MAX_UPLOAD_BYTES, buildContext, getRuntime, type Runtime } from "./runtime.ts";
import { classifyMediaUploadError, logMediaUploadEvent, mediaUploadOperationFor, publicMediaUploadFailure, safeDeploymentEnvironment, withMediaUploadDiagnosticContext, type MediaUploadDiagnosticContext } from "./storage/media-upload-diagnostics.ts";

/** Extra bytes allowed for the multipart envelope around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function responseWithRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}


export function uploadRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = randomUUID();
    const diagnosticContext: MediaUploadDiagnosticContext = { requestId, environment: safeDeploymentEnvironment(process.env), provider: "unavailable" };
    const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
    const crossSite = checkSameOrigin(request);
    if (crossSite) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
    return withMediaUploadDiagnosticContext(diagnosticContext, async () => {
      logMediaUploadEvent("media_upload_started", "request.multipart_parse");
      let operation = "request.multipart_parse";
      try {
        if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new AppError(415, "unsupported_media_type", "Send the upload as multipart/form-data.");
        operation = "runtime.storage_configuration";
        const ctx = await buildContext(runtime(), request);
        diagnosticContext.provider = ctx.media?.storage.kind ?? "unavailable";
        const customAccessKey = Boolean(process.env["CLIPFORGE_S3_ACCESS_KEY_ID"]?.trim());
        const customSecretKey = Boolean(process.env["CLIPFORGE_S3_SECRET_ACCESS_KEY"]?.trim());
        const credentialMode = customAccessKey && customSecretKey ? "explicit_static" : customAccessKey || customSecretKey ? "invalid_partial_static" : "default_aws_provider_chain";
        logMediaUploadEvent("media_storage_configuration_checked", operation, undefined, {
          configured: Boolean(ctx.media && !ctx.media.unavailable),
          credentialMode,
          clipforgeSessionTokenPresent: Boolean(process.env["CLIPFORGE_S3_SESSION_TOKEN"]?.trim()),
          awsSessionTokenEnvironmentPresent: Boolean(process.env["AWS_SESSION_TOKEN"]?.trim()),
          awsEnvironmentAccessKeyPresent: Boolean(process.env["AWS_ACCESS_KEY_ID"]?.trim()),
          awsEnvironmentSecretPresent: Boolean(process.env["AWS_SECRET_ACCESS_KEY"]?.trim()),
        });
        const maxBytes = ctx.media?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
        operation = "request.content_length_check";
        // Without a declared length we would have to buffer an unknown amount, so refuse.
        const declaredLength = request.headers.get("content-length");
        if (declaredLength === null || !/^\d+$/.test(declaredLength)) throw new AppError(411, "length_required", "The request did not say how large it is.");
        if (Number(declaredLength) > maxBytes + MULTIPART_OVERHEAD_BYTES) throw new AppError(413, "file_too_large", "That file is too large.");

        operation = "request.multipart_parse";
        let form: FormData;
        try { form = await request.formData(); } catch { throw new AppError(422, "validation_failed", "The upload could not be read."); }
        const file = form.get("file");
        if (!(file instanceof File)) throw new AppError(422, "validation_failed", "Choose a file to upload.");
        const rawCollectionId = form.get("collectionId");
        const collectionId = typeof rawCollectionId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawCollectionId) ? rawCollectionId : undefined;
        operation = "upload.validate_and_persist";
        const result = await uploadMedia(ctx, { filename: file.name, declaredMimeType: file.type, data: new Uint8Array(await file.arrayBuffer()), ...(rawCollectionId ? { collectionId: rawCollectionId } : {}) });
        logMediaUploadEvent("media_upload_succeeded", "upload.complete");
        if (wantsHtml) return responseWithRequestId(redirectResponse(buildFlashLocation(result.collectionId ? `/collections/${result.collectionId}` : "/media", "notice", result.validation === "verified" ? "upload_ok" : "upload_incomplete")), requestId);
        return Response.json({ ...result, requestId }, { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } });
      } catch (error) {
        const actualOperation = mediaUploadOperationFor(error) ?? operation;
        const info = classifyMediaUploadError(error, actualOperation);
        logMediaUploadEvent("media_upload_failed", actualOperation, error, { errorType: error instanceof Error ? "exception" : "unknown" });
        const safe = publicMediaUploadFailure(error, requestId, actualOperation);
        if (wantsHtml) return responseWithRequestId(redirectResponse(buildFlashLocation("/media", "error", flashCodeForError(error))), requestId);
        const base = toHttpResult(error);
        const details = info.errorCategory === "file_validation_error" ? base.body.error.details : undefined;
        return Response.json({ error: { code: safe.code, message: safe.message, requestId, confirmationRequired: safe.confirmationRequired, ...(details !== undefined ? { details } : {}) } }, {
          status: safe.status,
          headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
        });
      }
    });
  };
}
