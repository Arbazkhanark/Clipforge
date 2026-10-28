// Shared-media lifecycle: importing an independent copy, and the owner deleting a video that
// other people may still be using. Pure rules - the server performs the actual S3 work.
//
// Key ideas:
//  - Deleting is two steps: (1) mark the media (a "tombstone"), (2) a cleanup job removes the S3
//    object ONLY when canPhysicallyDeleteMedia() says nothing still needs it.
//  - Importing creates a NEW owned media record. Storage is charged only after the copy is verified.
import { canImportVideo, getCollectionCapabilities } from "./sharing-permissions.ts";
import { isEditableItem, isInFlightItem } from "./cycle-state.ts";
import type {
  CollectionPermissionGrant, CycleItem, Decision, MediaAsset, UserId, VideoCollection,
} from "./types.ts";

// =====================================================================
// Import
// =====================================================================
export const IMPORT_STATUSES = ["pending", "copying", "verifying", "succeeded", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export interface MediaImportJob {
  id: string;
  importerId: UserId;
  sourceMediaId: string;
  status: ImportStatus;
  /** S3 key of the new copy, once we started writing it. Needed to clean up if the job fails. */
  newObjectKey: string | null;
  failureReason: string | null;
}

/** Text the user must see and confirm before an import (shown in the UI). */
export const IMPORT_WARNING_POINTS = [
  "Importing creates an independent copy in your storage and uses part of your storage allowance.",
  "You can use the copy on its own, but the original owner may later remove or revoke the original.",
  "An imported copy does not transfer copyright or other legal rights. You are responsible for using it lawfully and within the permission you were given.",
] as const;

const ACTIVE_OR_DONE: ImportStatus[] = ["pending", "copying", "verifying", "succeeded"];

/** Same user + same source = same key, so a retry can never create a second copy. */
export const buildImportIdempotencyKey = (importerId: UserId, sourceMediaId: string): string =>
  `import:${importerId}:${sourceMediaId}`;

export type ImportPlan =
  | { kind: "allowed"; idempotencyKey: string }
  | { kind: "already_exists"; existingJob: MediaImportJob }
  | { kind: "denied"; reason: string };

export function planImport(args: {
  userId: UserId; media: MediaAsset; collection: VideoCollection; grants: CollectionPermissionGrant[]; now: Date;
  existingJobs: MediaImportJob[]; storageUsedBytes: number; storageLimitBytes: number; warningAcknowledged: boolean;
}): ImportPlan {
  const { userId, media, collection, grants, now, existingJobs, storageUsedBytes, storageLimitBytes, warningAcknowledged } = args;
  if (!warningAcknowledged) return { kind: "denied", reason: "Please read and confirm the import warning first." };

  const permission = canImportVideo(userId, media, collection, grants, now);
  if (!permission.allowed) return { kind: "denied", reason: permission.reason };

  const existingJob = existingJobs.find((j) => j.importerId === userId && j.sourceMediaId === media.id && ACTIVE_OR_DONE.includes(j.status));
  if (existingJob) return { kind: "already_exists", existingJob };

  if (storageUsedBytes + media.sizeBytes > storageLimitBytes) {
    return { kind: "denied", reason: "Not enough storage left in your plan for this copy." };
  }
  return { kind: "allowed", idempotencyKey: buildImportIdempotencyKey(userId, media.id) };
}

export interface ImportVerification {
  newObjectExists: boolean;
  copiedSizeBytes: number;
  /** null = checksum could not be compared. We then rely on size only and record that. */
  checksumMatches: boolean | null;
}

export interface ImportCompletion {
  job: MediaImportJob;
  /** Bytes to add to the importer's storage usage. 0 unless the import truly succeeded. */
  storageBytesToCharge: number;
  /** If set, the cleanup worker must delete this object (failed import). Prevents orphans. */
  orphanObjectKeyToDelete: string | null;
  /** True only when the importer should now get a new owned media record. */
  createOwnedMediaRecord: boolean;
}

function failedCompletion(job: MediaImportJob, reason: string): ImportCompletion {
  return {
    job: { ...job, status: "failed", failureReason: reason },
    storageBytesToCharge: 0, orphanObjectKeyToDelete: job.newObjectKey, createOwnedMediaRecord: false,
  };
}

/**
 * Finish an import. Re-checks permission (it may have been revoked while copying) and verifies
 * the copy. Only then is the job "succeeded" and storage charged.
 */
export function completeImport(args: {
  job: MediaImportJob; sourceMedia: MediaAsset; collection: VideoCollection;
  grants: CollectionPermissionGrant[]; now: Date; verification: ImportVerification;
}): ImportCompletion {
  const { job, sourceMedia, collection, grants, now, verification } = args;
  if (job.status !== "verifying") throw new Error("Only a job in the verifying step can be completed.");

  const permission = canImportVideo(job.importerId, sourceMedia, collection, grants, now);
  if (!permission.allowed) return failedCompletion(job, `Permission changed before the copy finished: ${permission.reason}`);
  if (!verification.newObjectExists) return failedCompletion(job, "The copied file could not be found.");
  if (verification.copiedSizeBytes !== sourceMedia.sizeBytes) return failedCompletion(job, "The copied file size does not match the original.");
  if (verification.checksumMatches === false) return failedCompletion(job, "The copied file failed its integrity check.");

  return {
    job: { ...job, status: "succeeded", failureReason: null },
    storageBytesToCharge: verification.copiedSizeBytes, orphanObjectKeyToDelete: null, createOwnedMediaRecord: true,
  };
}

/** Any other failure (network, crash). Always requests cleanup of a half-written object. */
export function failImport(job: MediaImportJob, reason: string): ImportCompletion {
  if (job.status === "succeeded") throw new Error("A succeeded import cannot be failed.");
  return failedCompletion(job, reason);
}

/** After a successful import the recipient may CHOOSE to point an upcoming item at their own copy. */
export function switchItemToImportedCopy(args: { item: CycleItem; importedMedia: MediaAsset; job: MediaImportJob }):
  { ok: true; item: CycleItem } | { ok: false; reason: string } {
  const { item, importedMedia, job } = args;
  if (job.status !== "succeeded") return { ok: false, reason: "The import has not finished successfully." };
  if (importedMedia.ownerId !== item.cycleOwnerId) return { ok: false, reason: "The copy must belong to the person running the cycle." };
  if (!isEditableItem(item)) return { ok: false, reason: `This item is ${item.status}; it can no longer be changed.` };
  return { ok: true, item: { ...item, mediaAssetId: importedMedia.id, sourceKind: "imported_copy", sourceCollectionId: null, version: item.version + 1 } };
}

// =====================================================================
// Owner deletion
// =====================================================================
const ACTIVE_IMPORT_STATUSES: ImportStatus[] = ["pending", "copying", "verifying"];
/** Items that still depend on their source video. Finished ones (published/cancelled) do not. */
const isItemStillDependingOnSource = (item: CycleItem): boolean => !["published", "cancelled"].includes(item.status);

export interface MediaDependencies {
  /** Other users who currently hold a valid grant on a collection containing this media. */
  sharedWithUserIds: UserId[];
  /** Cycle items (anyone's, including the owner's) that still need this media. */
  activeCycleItems: CycleItem[];
  inFlightCycleItems: CycleItem[];
  activeImportJobs: MediaImportJob[];
  hasDependencies: boolean;
}

export function findMediaDependencies(args: {
  media: MediaAsset; collections: VideoCollection[]; grants: CollectionPermissionGrant[];
  cycleItems: CycleItem[]; importJobs: MediaImportJob[]; now: Date;
}): MediaDependencies {
  const { media, collections, grants, cycleItems, importJobs, now } = args;
  const sharedWithUserIds = new Set<UserId>();
  for (const collection of collections.filter((c) => c.mediaIds.includes(media.id))) {
    for (const grant of grants.filter((g) => g.collectionId === collection.id && g.granteeId !== media.ownerId)) {
      // getCollectionCapabilities already ignores revoked / expired grants.
      if (getCollectionCapabilities(grant.granteeId, collection, grants, now).has("use_in_cycle") ||
          getCollectionCapabilities(grant.granteeId, collection, grants, now).has("import_copy")) {
        sharedWithUserIds.add(grant.granteeId);
      }
    }
  }
  const activeCycleItems = cycleItems.filter((i) => i.mediaAssetId === media.id && isItemStillDependingOnSource(i));
  const activeImportJobs = importJobs.filter((j) => j.sourceMediaId === media.id && ACTIVE_IMPORT_STATUSES.includes(j.status));
  return {
    sharedWithUserIds: [...sharedWithUserIds],
    activeCycleItems,
    inFlightCycleItems: activeCycleItems.filter(isInFlightItem),
    activeImportJobs,
    hasDependencies: sharedWithUserIds.size > 0 || activeCycleItems.length > 0 || activeImportJobs.length > 0,
  };
}

export type DeletionReason = "normal" | "legal_removal";

export type DeletionPlan =
  | { outcome: "denied"; reason: string }
  /** Nothing depends on the media: mark it deleted; cleanup removes the S3 object. */
  | { outcome: "delete_now" }
  /** Others depend on it. The owner must choose; options are shown in the UI. */
  | { outcome: "needs_owner_choice"; options: ("cancel" | "schedule_with_grace_period")[]; affectedUserIds: UserId[]; activeItemCount: number; activeImportCount: number }
  /** Legal/privacy removal: access ends immediately; no grace period. */
  | { outcome: "forced_removal"; affectedUserIds: UserId[]; cycleItemIdsToBlock: string[]; importJobIdsToFail: string[] };

export function planOwnerDeletion(args: {
  requestedBy: UserId; media: MediaAsset; dependencies: MediaDependencies; reason: DeletionReason;
}): DeletionPlan {
  const { requestedBy, media, dependencies, reason } = args;
  if (media.ownerId !== requestedBy) return { outcome: "denied", reason: "Only the owner can delete this video." };
  if (media.status === "deleted") return { outcome: "denied", reason: "This video is already deleted." };

  const affectedUserIds = [...new Set([...dependencies.sharedWithUserIds, ...dependencies.activeCycleItems.map((i) => i.cycleOwnerId).filter((id) => id !== media.ownerId)])];

  if (reason === "legal_removal") {
    return {
      outcome: "forced_removal", affectedUserIds,
      cycleItemIdsToBlock: dependencies.activeCycleItems.filter(isEditableItem).map((i) => i.id),
      importJobIdsToFail: dependencies.activeImportJobs.map((j) => j.id),
    };
  }
  if (!dependencies.hasDependencies) return { outcome: "delete_now" };
  return {
    outcome: "needs_owner_choice", options: ["cancel", "schedule_with_grace_period"], affectedUserIds,
    activeItemCount: dependencies.activeCycleItems.length, activeImportCount: dependencies.activeImportJobs.length,
  };
}

export interface RecipientNotification {
  userId: UserId;
  type: "shared_media_scheduled_for_removal";
  mediaId: string;
  /** The real date access ends. Never invent a different one. */
  deleteAfter: Date;
  usedInActiveCycle: boolean;
  /** Storage an import would use. */
  importSizeBytes: number;
  canImport: boolean;
}

/** Owner chose a grace period. Marks the media and builds one notification per affected user. */
export function scheduleDeletionWithGracePeriod(args: {
  media: MediaAsset; dependencies: MediaDependencies; graceDays: number; now: Date;
  collections: VideoCollection[]; grants: CollectionPermissionGrant[];
}): { media: MediaAsset; notifications: RecipientNotification[] } | { error: string } {
  const { media, dependencies, graceDays, now, collections, grants } = args;
  if (!Number.isInteger(graceDays) || graceDays < 1) return { error: "The grace period must be a whole number of days, at least 1." };
  if (media.status !== "active") return { error: "Only an active video can be scheduled for removal." };

  const deleteAfter = new Date(now.getTime() + graceDays * 24 * 60 * 60 * 1000);
  const affectedUserIds = new Set<UserId>([
    ...dependencies.sharedWithUserIds,
    ...dependencies.activeCycleItems.map((i) => i.cycleOwnerId).filter((id) => id !== media.ownerId),
  ]);
  const markedMedia: MediaAsset = { ...media, status: "pending_deletion", deleteAfter };

  const notifications = [...affectedUserIds].map((userId): RecipientNotification => {
    const canImport = collections.some((c) => canImportVideo(userId, markedMedia, c, grants, now).allowed);
    return {
      userId, type: "shared_media_scheduled_for_removal", mediaId: media.id, deleteAfter,
      usedInActiveCycle: dependencies.activeCycleItems.some((i) => i.cycleOwnerId === userId),
      importSizeBytes: media.sizeBytes, canImport,
    };
  });
  return { media: markedMedia, notifications };
}

/**
 * When access ends, upcoming items that still point at the removed source cannot publish.
 * Move them to "needs_review" (reason: source_removed) so the user is told, instead of failing silently.
 * Published history and in-flight items are untouched.
 */
export function blockItemsForRemovedSource(items: CycleItem[], mediaId: string): CycleItem[] {
  return items.map((item) => {
    if (item.mediaAssetId !== mediaId || !isEditableItem(item)) return item;
    return { ...item, status: "needs_review", reviewReason: "source_removed", version: item.version + 1 };
  });
}

/**
 * The ONLY gate for deleting the real S3 object. All of these must be true:
 *  - the owner deleted it, or the grace period has ended,
 *  - no worker is processing/publishing an item that uses it,
 *  - no import is copying it,
 *  - no upcoming item still expects to use it (they must be blocked first).
 */
export function canPhysicallyDeleteMedia(args: {
  media: MediaAsset; cycleItems: CycleItem[]; importJobs: MediaImportJob[]; now: Date;
}): Decision {
  const { media, cycleItems, importJobs, now } = args;
  const isMarked = media.status === "deleted" || (media.status === "pending_deletion" && media.deleteAfter !== null && media.deleteAfter <= now);
  if (!isMarked) return { allowed: false, reason: "The video is not marked for deletion, or its grace period has not ended." };

  const usingItems = cycleItems.filter((i) => i.mediaAssetId === media.id);
  if (usingItems.some(isInFlightItem)) return { allowed: false, reason: "A job is still processing or publishing this video." };
  if (importJobs.some((j) => j.sourceMediaId === media.id && ACTIVE_IMPORT_STATUSES.includes(j.status))) {
    return { allowed: false, reason: "An import is still copying this video." };
  }
  if (usingItems.some(isEditableItem)) return { allowed: false, reason: "Upcoming items still reference this video; block them first." };
  return { allowed: true, reason: "Nothing needs this video any more." };
}

/** Immediate delete (no dependencies): tombstone only. The cleanup job still checks canPhysicallyDeleteMedia. */
export function markMediaDeleted(media: MediaAsset): MediaAsset {
  return { ...media, status: "deleted", deleteAfter: null };
}

