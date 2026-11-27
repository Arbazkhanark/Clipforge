// Serving a stored file (thumbnail, inline preview, or download) to a signed-in user.
// Rules:
//  - access is decided by decideMediaAccess() on EVERY request (no cached "allowed"),
//  - a denied request looks exactly like "not found" (nobody learns whether a file exists),
//  - storage keys, folder paths and URLs never appear in a response,
//  - browsers are told not to guess types, not to cache, and to treat the response as inert (nosniff, CSP sandbox, CORP).
import { decideMediaAccess, MEDIA_VARIANTS, type ContainingCollection, type MediaVariant } from "../../lib/domain/media-access.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, notFound, validationFailed } from "../errors.ts";
import { runMediaUploadOperation } from "../storage/media-upload-diagnostics.ts";
import type { MediaStorage } from "../storage/media-storage.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Types we will show inline. Anything else is forced to download as an opaque file. */
const INLINE_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "image/jpeg", "image/png", "image/webp"]);
/** A partial response for an inline preview carries at most this much, so one request cannot pull a whole large file. */
export const MAX_PARTIAL_BYTES = 8 * 1024 * 1024;

export interface ServedMedia { status: 200 | 206 | 416; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null; }

function withStorageOperation<T>(storage: MediaStorage, operation: string, work: () => Promise<T>): Promise<T> {
  // S3 records the precise HeadObject/GetObject command; other adapters get a useful storage stage.
  return storage.kind === "s3" ? work() : runMediaUploadOperation(`storage.${operation}`, work);
}

/** Parses ONE byte range ("bytes=0-99", "bytes=100-", "bytes=-50"). null = no usable range header (serve everything). "unsatisfiable" = 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;                       // malformed, or several ranges: ignore and serve the whole file
  const [, rawStart, rawEnd] = match as unknown as [string, string, string];
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") { const suffix = Number(rawEnd); return suffix === 0 ? "unsatisfiable" : { start: Math.max(0, size - suffix), end: size - 1 }; }
  const start = Number(rawStart); const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** A safe Content-Disposition: plain ASCII fallback plus the real name in the RFC 5987 form. */
export function contentDisposition(kind: "inline" | "attachment", title: string): string {
  const ascii = title.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_").slice(0, 100) || "file";
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(title.slice(0, 100)).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

export async function serveMedia(ctx: RequestContext, input: { mediaId: unknown; variant: unknown; rangeHeader: string | null }): Promise<ServedMedia> {
  const userId = requireUser(ctx);
  if (!ctx.media) throw new AppError(503, "storage_not_configured", "Media is not available: no storage is configured.");
  if (ctx.media.unavailable) throw new AppError(503, "storage_unavailable", ctx.media.unavailable);
  if (typeof input.mediaId !== "string" || !ID.test(input.mediaId)) throw validationFailed(["id must be a valid id."]);
  if (typeof input.variant !== "string" || !(MEDIA_VARIANTS as readonly string[]).includes(input.variant)) throw validationFailed(["variant must be thumbnail, preview or download."]);
  const variant = input.variant as MediaVariant;

  const media = await runMediaUploadOperation("database.media_record_lookup", () => ctx.repo.getMedia(input.mediaId as string));
  if (!media) throw notFound("File");

  let containing: ContainingCollection[] = [];
  if (media.ownerId !== userId) {
    const collections = await runMediaUploadOperation("database.media_access_collections", () => ctx.repo.listCollectionsContainingMedia(media.id));
    containing = await Promise.all(collections.map(async (collection) => ({
      collection,
      grants: await runMediaUploadOperation("database.media_access_grants", () => ctx.repo.getGrants(collection.id)),
    })));
  }
  if (!decideMediaAccess({ userId, media, containing, variant, now: ctx.now }).allowed) throw notFound("File"); // same answer as "missing"

  const info = await runMediaUploadOperation("database.media_storage_info", () => ctx.repo.getMediaStorageInfo(media.id));
  const key = variant === "thumbnail" ? info?.thumbnailKey : info?.storageKey;
  if (!info || !key) throw notFound("File");
  const storage = ctx.media.storage;
  const size = await withStorageOperation(storage, "stat_size", () => storage.statSize(key));
  if (size === null) throw notFound("File");

  const mime = variant === "thumbnail" ? "image/jpeg" : info.mimeType && INLINE_MIME_TYPES.has(info.mimeType) ? info.mimeType : "application/octet-stream";
  const inline = variant !== "download" && INLINE_MIME_TYPES.has(mime);
  const headers: Record<string, string> = {
    "Content-Type": mime, "Accept-Ranges": "bytes",
    "Content-Disposition": variant === "thumbnail" ? "inline" : contentDisposition(inline ? "inline" : "attachment", media.title ?? "file"),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
  };

  const range = parseRange(input.rangeHeader, size);
  if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` }, body: null };
  if (variant === "download") await runMediaUploadOperation("database.media_download_audit", () => ctx.repo.appendAudit({ actorId: userId, action: "media.downloaded", entityType: "MediaAsset", entityId: media.id, metadata: { byOwner: media.ownerId === userId } }));

  if (range) {
    const end = variant === "preview" ? Math.min(range.end, range.start + MAX_PARTIAL_BYTES - 1) : range.end;
    return { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${end}/${size}`,
      "Content-Length": String(end - range.start + 1) }, body: await withStorageOperation(storage, "open_read", () => storage.openRead(key, { start: range.start, end })) };
  }
  return { status: 200, headers: { ...headers, "Content-Length": String(size) }, body: await withStorageOperation(storage, "open_read", () => storage.openRead(key)) };
}
