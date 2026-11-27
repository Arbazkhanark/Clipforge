// Uploading a media file. Order of checks (cheapest and safest first):
//   signed in -> input shape -> size limit -> real file type (magic bytes, not the browser's claim) -> plan quota (early)
//   -> stage -> ffprobe (if installed) -> commit -> record the media atomically within the quota
// Failure rules:
//   - anything that fails BEFORE commit removes only the staged copy of THIS upload,
//   - a definite record-write failure removes only this upload; an ambiguous database outcome keeps the committed file for reconciliation,
//   - existing media is never touched.
import { getPlan } from "../../lib/billing/catalog.ts";
import { createHash, randomUUID } from "node:crypto";
import type { MediaAsset } from "../../lib/domain/types.ts";
import { requireUser, type RequestContext } from "../context.ts";
import { AppError, fileTooLarge, invalidMedia, notFound, planLimit, unsupportedMediaType, validationFailed } from "../errors.ts";
import { CANONICAL_MIME, declaredMimeAgrees, sanitizeFilename, sniffMedia } from "../storage/media-inspection.ts";
import { mediaKeyFor, stagingKeyFor, thumbnailKeyFor, type MediaStorage } from "../storage/media-storage.ts";
import { databaseWriteOutcomeUncertain, logMediaUploadEvent, mediaUploadOperationFor, runMediaUploadOperation } from "../storage/media-upload-diagnostics.ts";

export interface UploadInput { filename: unknown; declaredMimeType: unknown; data: unknown; collectionId?: unknown; }

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
  collectionId?: string;
}

function withStorageOperation<T>(storage: MediaStorage, operation: string, work: () => Promise<T>): Promise<T> {
  // S3MediaStorage records the exact AWS command; non-S3 adapters still get request-scoped operation events here.
  return storage.kind === "s3" ? work() : runMediaUploadOperation(`storage.${operation}`, work);
}

export async function uploadMedia(ctx: RequestContext, input: UploadInput): Promise<UploadResult> {
  const userId = requireUser(ctx);
  if (!ctx.media) throw new AppError(503, "storage_not_configured", "Uploads are not available: no storage is configured.");
  if (ctx.media.unavailable) throw new AppError(503, "storage_unavailable", ctx.media.unavailable);
  const { storage, probe, maxUploadBytes } = ctx.media;
  const makeThumbnail = ctx.media.thumbnail ?? null;
  const collectionId = input.collectionId === undefined || input.collectionId === null || input.collectionId === "" ? undefined : input.collectionId;
  if (collectionId !== undefined) {
    if (typeof collectionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(collectionId)) throw validationFailed(["Choose a valid collection."]);
    const collection = await runMediaUploadOperation("database.collection_lookup", () => ctx.repo.getCollection(collectionId));
    if (!collection || collection.ownerId !== userId || collection.archived) throw notFound("Collection");
  }

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
  const planId = await runMediaUploadOperation("database.plan_lookup", () => ctx.repo.getPlanIdForUser(userId, ctx.now));
  const limitBytes = getPlan(planId).limits.storageBytes;
  const usedBytes = await runMediaUploadOperation("database.storage_usage_read", () => ctx.repo.getStorageUsedBytes(userId));
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
  let databaseWriteOutcomeUnconfirmed = false;
  let metadata: { width: number | null; height: number | null; durationMs: number | null; validation: "verified" | "incomplete" };
  try {
    await withStorageOperation(storage, "stage", () => storage.stage(stagingKey, data, { contentType: CANONICAL_MIME[sniffed.type] }));

    if (probe === null) {
      // ffprobe is not installed: we must NOT pretend the media was checked.
      metadata = { width: null, height: null, durationMs: null, validation: "incomplete" };
    } else {
      let probed;
      try { probed = await withStorageOperation(storage, "read_staged_for_probe", () => storage.runWithStagedFile(stagingKey, probe)); }
      catch (error) {
        // A failed S3 GetObject/download is a storage fault, not invalid user media.
        if (mediaUploadOperationFor(error)?.startsWith("s3.")) throw error;
        throw invalidMedia("That file could not be read as valid media, so it was not saved.");
      }
      if (!(probed.width > 0 && probed.height > 0)) throw invalidMedia("That file has no readable picture, so it was not saved.");
      if (sniffed.kind === "video" && !(probed.durationSeconds > 0)) throw invalidMedia("That video has no readable duration, so it was not saved.");
      metadata = { width: probed.width, height: probed.height, durationMs: sniffed.kind === "video" ? Math.round(probed.durationSeconds * 1000) : null, validation: "verified" };
    }

    // A small preview image. Failure here is NOT fatal: the upload simply has no thumbnail.
    let hasThumbnail = false;
    if (makeThumbnail) {
      const jpeg = await withStorageOperation(storage, "read_staged_for_thumbnail", () => storage.runWithStagedFile(stagingKey, (file) => makeThumbnail(file, metadata.durationMs === null ? null : metadata.durationMs / 1000))).catch((error: unknown) => {
        const operation = storage.kind === "s3" ? mediaUploadOperationFor(error) ?? "thumbnail.generate" : "thumbnail.generate";
        logMediaUploadEvent("media_thumbnail_failed", operation, error, { stage: "thumbnail.generate" });
        return null;
      });
      if (jpeg && jpeg.length > 0) { await withStorageOperation(storage, "stage_thumbnail", () => storage.stage(thumbStagingKey, jpeg, { contentType: "image/jpeg" })); hasThumbnail = true; }
    }

    await withStorageOperation(storage, "commit_upload", () => storage.commit(stagingKey, finalKey));
    committed = true;
    if (hasThumbnail) { await withStorageOperation(storage, "commit_thumbnail", () => storage.commit(thumbStagingKey, thumbFinalKey)); thumbCommitted = true; }

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
    let persisted: boolean | "collection_unavailable";
    try {
      persisted = await runMediaUploadOperation("database.media_record_create", () => ctx.repo.addMediaWithVerificationJobIfStorageWithin(media, { storageKey: finalKey, thumbnailKey: hasThumbnail ? thumbFinalKey : null }, job, audit, limitBytes, collectionId));
    } catch (error) {
      databaseWriteOutcomeUnconfirmed = databaseWriteOutcomeUncertain(error);
      throw error;
    }
    if (persisted === "collection_unavailable") throw notFound("Collection");
    if (!persisted) throw planLimit(quotaMessage);
    logMediaUploadEvent("media_verification_job_created", "database.media_record_create");
    return {
      mediaId, title, kind: sniffed.kind, sizeBytes: data.length, durationMs: metadata.durationMs, validation: "incomplete", verificationStatus: "processing", storage: storage.kind, hasThumbnail,
      warning: "Upload saved. Private storage and media verification are still in progress.",
      ...(collectionId ? { collectionId } : {}),
    };
  } catch (error) {
    // Cleanup of THIS upload only. Best effort: a cleanup problem must never hide the real error.
    const cleanup = async (operation: string, work: () => Promise<void>) => {
      try { await withStorageOperation(storage, operation, work); }
      catch (cleanupError) { logMediaUploadEvent("media_cleanup_failed", mediaUploadOperationFor(cleanupError) ?? `storage.${operation}`, cleanupError); }
    };
    await cleanup("discard_staged_upload", () => storage.discardStaged(stagingKey));
    await cleanup("discard_staged_thumbnail", () => storage.discardStaged(thumbStagingKey));
    if (databaseWriteOutcomeUnconfirmed && (committed || thumbCommitted)) {
      logMediaUploadEvent("media_cleanup_deferred", "database.media_record_create", error, { reason: "database_write_outcome_unconfirmed" });
    } else {
      if (thumbCommitted) await cleanup("delete_unreferenced_thumbnail", () => storage.deleteUnreferencedUpload(thumbFinalKey));
      if (committed) await cleanup("delete_unreferenced_upload", () => storage.deleteUnreferencedUpload(finalKey));
    }
    throw error;
  }
}
