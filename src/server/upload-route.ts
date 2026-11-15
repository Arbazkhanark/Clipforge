// POST /api/forms/media-upload (and JSON when the caller asks for it). Multipart is buffered in memory and kept
// single-file per request; the selected private MediaStorage adapter handles staging, validation and commit.
import { AppError, toHttpResult } from "./errors.ts";
import { buildFlashLocation, flashCodeForError } from "./flash.ts";
import { redirectResponse } from "./form-routes.ts";
import { checkSameOrigin } from "./http.ts";
import { uploadMedia } from "./handlers/media-upload.ts";
import { DEFAULT_MAX_UPLOAD_BYTES, buildContext, getRuntime, type Runtime } from "./runtime.ts";

/** Extra bytes allowed for the multipart envelope around the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export function uploadRoute(runtime: () => Runtime = getRuntime): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
    const crossSite = checkSameOrigin(request);
    if (crossSite) return new Response("Cross-site requests are not allowed.", { status: 403, headers: { "Cache-Control": "no-store" } });
    try {
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new AppError(415, "unsupported_media_type", "Send the upload as multipart/form-data.");
      const ctx = await buildContext(runtime(), request);
      const maxBytes = ctx.media?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
      // Without a declared length we would have to buffer an unknown amount, so refuse.
      const declaredLength = request.headers.get("content-length");
      if (declaredLength === null || !/^\d+$/.test(declaredLength)) throw new AppError(411, "length_required", "The request did not say how large it is.");
      if (Number(declaredLength) > maxBytes + MULTIPART_OVERHEAD_BYTES) throw new AppError(413, "file_too_large", "That file is too large.");

      let form: FormData;
      try { form = await request.formData(); } catch { throw new AppError(422, "validation_failed", "The upload could not be read."); }
      const file = form.get("file");
      if (!(file instanceof File)) throw new AppError(422, "validation_failed", "Choose a file to upload.");
      const result = await uploadMedia(ctx, { filename: file.name, declaredMimeType: file.type, data: new Uint8Array(await file.arrayBuffer()) });
      if (wantsHtml) return redirectResponse(buildFlashLocation("/media", "notice", result.validation === "verified" ? "upload_ok" : "upload_incomplete"));
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (wantsHtml) return redirectResponse(buildFlashLocation("/media", "error", flashCodeForError(error)));
      const result = toHttpResult(error);
      return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
    }
  };
}
