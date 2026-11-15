// Uploading a media file. Order of checks (cheapest and safest first):
//   signed in -> input shape -> size limit -> real file type (magic bytes, not the browser's claim) -> plan quota (early)
//   -> stage -> ffprobe (if installed) -> commit -> record the media atomically within the quota
// Failure rules:
//   - anything that fails BEFORE commit removes only the staged copy of THIS upload,
//   - if the record cannot be created after commit, only the file this upload just wrote is removed,
//   - existing media is never touched.
import { getPlan } from "../../lib/billing/catalog.ts";
import { createHash, randomUUID } from "node:crypto";
import type { MediaAsset } from "../../lib/domain/types.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, fileTooLarge, invalidMedia, planLimit, unsupportedMediaType, validationFailed } from "../errors.ts";
import { CANONICAL_MIME, declaredMimeAgrees, sanitizeFilename, sniffMedia } from "../storage/media-inspection.ts";
import { mediaKeyFor, stagingKeyFor, thumbnailKeyFor } from "../storage/media-storage.ts";

export interface UploadInput { filename: unknown; declaredMimeType: unknown; data: unknown; }

export interface UploadResult {
  mediaId: string;
  title: string;
  kind: "video" | "image";
  sizeBytes: number;
  durationMs: number | null;
  validation: "verified" | "incomplete";
  verificationStatus: "processing";
  /** Set when validation is incomplete, in words the user can read. */
  warning: string | null;
  storage: "memory" | "local-disk" | "s3";
  hasThumbnail: boolean;
}

export async function uploadMedia(ctx: RequestContext, input: UploadInput): Promise<UploadResult> {
  const userId = requireUser(ctx);
  if (!ctx.media) throw new AppError(503, "storage_not_configured", "Uploads are not available: no storage is configured.");
  if (ctx.media.unavailable) throw new AppError(503, "storage_unavailable", ctx.media.unavailable);
  const { storage, probe, maxUploadBytes } = ctx.media;
  const makeThumbnail = ctx.media.thumbnail ?? null;

  // 1. Input shape
  const problems: string[] = [];
  if (typeof input.filename !== "string" || input.filename.length === 0 || input.filename.length > 255) problems.push("filename must be 1 to 255 characters.");
  if (typeof input.declaredMimeType !== "string" || input.declaredMimeType.length > 100) problems.push("The file type is not valid.");
  if (!(input.data instanceof Uint8Array)) problems.push("No file data was received.");
  else if (input.data.length === 0) problems.push("The file is empty.");
  if (problems.length > 0) throw validationFailed(problems);
  const data = input.data as Uint8Array;
  const declaredMimeType = input.declaredMimeType as string;

  // 2. Size limit (before anything is written)
  if (data.length > maxUploadBytes) throw fileTooLarge(maxUploadBytes);

  // 3. What is it REALLY? The bytes decide; the browser's claim must agree.
  const sniffed = sniffMedia(data);
  if (!sniffed) throw unsupportedMediaType("That file is not a supported video or image. Use MP4, MOV or WebM video, or JPEG, PNG or WebP images.");
  if (!declaredMimeAgrees(declaredMimeType, sniffed)) throw unsupportedMediaType("The file's contents do not match its declared type, so it was rejected.");

  // 4. Plan storage quota - early, so oversized uploads are refused before any bytes are stored.
  const planId = await ctx.repo.getPlanIdForUser(userId, ctx.now);
  const limitBytes = getPlan(planId).limits.storageBytes;
  const usedBytes = await ctx.repo.getStorageUsedBytes(userId);
  const quotaMessage = `Not enough storage left on your plan: this file is ${data.length} bytes and you have ${Math.max(0, limitBytes - usedBytes)} bytes free.`;
  if (usedBytes + data.length > limitBytes) throw planLimit(quotaMessage);

  // 5. Stage, inspect, commit. Keys come from ids only - never from the file name.
  const mediaId = ctx.newId();
  const checksumSha256 = createHash("sha256").update(data).digest("hex");
  const stagingKey = stagingKeyFor(mediaId);
  const finalKey = mediaKeyFor(userId, mediaId);
  const thumbStagingKey = stagingKeyFor(`${mediaId}-thumb`);
  const thumbFinalKey = thumbnailKeyFor(userId, mediaId);
  let committed = false;
  let thumbCommitted = false;
  let metadata: { width: number | null; height: number | null; durationMs: number | null; validation: "verified" | "incomplete" };
  try {
    await storage.stage(stagingKey, data, { contentType: CANONICAL_MIME[sniffed.type] });

    if (probe === null) {
      // ffprobe is not installed: we must NOT pretend the media was checked.
      metadata = { width: null, height: null, durationMs: null, validation: "incomplete" };
    } else {
      let probed;
      try { probed = await storage.runWithStagedFile(stagingKey, probe); }
      catch { throw invalidMedia("That file could not be read as valid media, so it was not saved."); }
      if (!(probed.width > 0 && probed.height > 0)) throw invalidMedia("That file has no readable picture, so it was not saved.");
      if (sniffed.kind === "video" && !(probed.durationSeconds > 0)) throw invalidMedia("That video has no readable duration, so it was not saved.");
      metadata = { width: probed.width, height: probed.height, durationMs: sniffed.kind === "video" ? Math.round(probed.durationSeconds * 1000) : null, validation: "verified" };
    }

    // A small preview image. Failure here is NOT fatal: the upload simply has no thumbnail.
    let hasThumbnail = false;
    if (makeThumbnail) {
      const jpeg = await storage.runWithStagedFile(stagingKey, (file) => makeThumbnail(file, metadata.durationMs === null ? null : metadata.durationMs / 1000)).catch(() => null);
      if (jpeg && jpeg.length > 0) { await storage.stage(thumbStagingKey, jpeg, { contentType: "image/jpeg" }); hasThumbnail = true; }
    }

    await storage.commit(stagingKey, finalKey);
    committed = true;
    if (hasThumbnail) { await storage.commit(thumbStagingKey, thumbFinalKey); thumbCommitted = true; }

    // 6. Record it, atomically within the quota (two simultaneous uploads cannot both squeeze in).
    const title = sanitizeFilename(input.filename as string);
    const media: MediaAsset = {
      id: mediaId, ownerId: userId, status: "active", sizeBytes: data.length, deleteAfter: null, title, kind: sniffed.kind,
      durationMs: metadata.durationMs, createdAt: ctx.now, width: metadata.width, height: metadata.height, validation: "incomplete",
      mimeType: CANONICAL_MIME[sniffed.type], hasThumbnail, checksumSha256,
    };
    const jobId = ctx.newId();
    const job = {
      id: jobId, ownerId: userId, mediaAssetId: mediaId, status: "queued" as const, progressPercent: 0, attempts: 0,
      idempotencyKey: `media-verification:${mediaId}`, lockedBy: null, lockToken: null, lockExpiresAt: null, errorMessage: null,
      createdAt: ctx.now, finishedAt: null, payload: {
        stage: "queued", outcome: "processing", completedStages: ["uploaded_to_storage", ...(metadata.validation === "verified" ? ["media_verified"] : [])],
        errorCode: null, retryable: false, updatedAt: ctx.now.toISOString(), thumbnailStatus: hasThumbnail ? "pending" : "skipped",
      },
    };
    const audit = { actorId: userId, action: "media.uploaded", entityType: "MediaAsset", entityId: mediaId, metadata: { sizeBytes: data.length, kind: sniffed.kind, validation: "processing" } };
    if (!(await ctx.repo.addMediaWithVerificationJobIfStorageWithin(media, { storageKey: finalKey, thumbnailKey: hasThumbnail ? thumbFinalKey : null }, job, audit, limitBytes))) throw planLimit(quotaMessage);
    return {
      mediaId, title, kind: sniffed.kind, sizeBytes: data.length, durationMs: metadata.durationMs, validation: "incomplete", verificationStatus: "processing", storage: storage.kind, hasThumbnail,
      warning: "Upload saved. Private storage and media verification are still in progress.",
    };
  } catch (error) {
    // Cleanup of THIS upload only. Best effort: a cleanup problem must never hide the real error.
    await storage.discardStaged(stagingKey).catch(() => undefined);
    await storage.discardStaged(thumbStagingKey).catch(() => undefined);
    if (thumbCommitted) await storage.deleteUnreferencedUpload(thumbFinalKey).catch(() => undefined);
    if (committed) await storage.deleteUnreferencedUpload(finalKey).catch(() => undefined);
    throw error;
  }
}
