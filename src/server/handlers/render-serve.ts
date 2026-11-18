// Download a finished export. The caller must be the person who rendered it.
// The file is sent only when its stored size matches the database row.
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, notFound, validationFailed } from "../errors.ts";
import { contentDisposition, MAX_PARTIAL_BYTES, parseRange } from "./media-serve.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function serveRender(ctx: RequestContext, input: { exportId: unknown }): Promise<{ status: 200; headers: Record<string, string>; body: ReadableStream<Uint8Array> }> {
  const userId = requireUser(ctx);
  if (!ctx.media) throw new AppError(503, "storage_not_configured", "Media is not available: no storage is configured.");
  if (ctx.media.unavailable) throw new AppError(503, "storage_unavailable", ctx.media.unavailable);
  if (typeof input.exportId !== "string" || !ID.test(input.exportId)) throw validationFailed(["id must be a valid id."]);
  const row = await ctx.repo.getRenderOutput(input.exportId);
  if (!row || row.ownerId !== userId) throw notFound("Export");
  const size = await ctx.media.storage.statSize(row.storageKey);
  if (size === null || size !== row.sizeBytes) throw notFound("Export");
  await ctx.repo.appendAudit({ actorId: userId, action: "render.downloaded", entityType: "MediaDerivative", entityId: row.id, metadata: { sourceMediaId: row.sourceMediaId } });
  return {
    status: 200,
    headers: {
      "Content-Type": "video/mp4", "Content-Length": String(size), "Accept-Ranges": "none",
      "Content-Disposition": contentDisposition("attachment", "export.mp4"),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
    },
    body: await ctx.media.storage.openRead(row.storageKey),
  };
}

/** Inline playback of a completed private render. Only its owner can read it. */
export async function serveRenderPreview(ctx: RequestContext, input: { exportId: unknown; rangeHeader: string | null }): Promise<{ status: 200 | 206 | 416; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null }> {
  const userId = requireUser(ctx);
  if (!ctx.media) throw new AppError(503, "storage_not_configured", "Media is not available: no storage is configured.");
  if (ctx.media.unavailable) throw new AppError(503, "storage_unavailable", ctx.media.unavailable);
  if (typeof input.exportId !== "string" || !ID.test(input.exportId)) throw validationFailed(["id must be a valid id."]);
  const row = await ctx.repo.getRenderOutput(input.exportId);
  if (!row || row.ownerId !== userId) throw notFound("Export");
  const size = await ctx.media.storage.statSize(row.storageKey);
  if (size === null || size !== row.sizeBytes) throw notFound("Export");
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition("inline", "export.mp4"),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
  };
  const range = parseRange(input.rangeHeader, size);
  if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` }, body: null };
  if (range) {
    const end = Math.min(range.end, range.start + MAX_PARTIAL_BYTES - 1);
    return {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${range.start}-${end}/${size}`, "Content-Length": String(end - range.start + 1) },
      body: await ctx.media.storage.openRead(row.storageKey, { start: range.start, end }),
    };
  }
  return { status: 200, headers: { ...headers, "Content-Length": String(size) }, body: await ctx.media.storage.openRead(row.storageKey) };
}
