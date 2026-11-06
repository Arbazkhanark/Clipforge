// The database as the handlers see it.
// src/server/prisma/prisma-repository.ts is the PostgreSQL implementation.
// src/server/memory-repository.ts is the same contract in memory, used by tests and local demo mode.
//
// CONCURRENCY CONTRACT: saveCycleItemsIfVersionMatches must behave like
//   UPDATE "CycleItem" SET ... , version = :newVersion WHERE id = :id AND version = :expectedVersion
// for each item, and report whether a row changed. Two writers can never both win.
import type { PlanId } from "../lib/billing/catalog.ts";
import type { CaptionRevision } from "../lib/domain/caption-cover-updates.ts";
import type { EditingSettings } from "../lib/domain/editing-settings.ts";
import type { UsageRecordDraft } from "../lib/domain/usage-accounting.ts";
import type { MediaSort } from "../lib/domain/media-list.ts";
import type { CollectionPermissionGrant, CollectionVisibility, CycleItem, CycleStatus, MediaAsset, PublishingCycle, VideoCollection } from "../lib/domain/types.ts";

export interface CycleRecord extends PublishingCycle { name: string; socialAccountId: string; }
export interface SocialAccountRecord { id: string; userId: string; status: "connected" | "token_expired" | "revoked" | "disconnected"; }
export interface EditingTemplateRecord { id: string; ownerId: string; name: string; settings: EditingSettings; createdAt: Date; }
export interface RenderOutputRecord { id: string; sourceMediaId: string; ownerId: string; sizeBytes: number; createdAt: Date; }
export type SaveRenderResult = { status: "saved" | "duplicate"; id: string } | { status: "over_quota" };
export interface AuditEntry { actorId: string | null; action: string; entityType: string; entityId: string; metadata?: Record<string, unknown>; }

export interface Repository {
  /** The plan whose limits apply to this user right now (free when there is no entitled subscription). */
  getPlanIdForUser(userId: string): Promise<PlanId>;

  getCycle(cycleId: string): Promise<CycleRecord | null>;
  countActiveCycles(userId: string): Promise<number>;
  createCycle(cycle: CycleRecord): Promise<void>;
  /** Moves a cycle from `from` to `to` only if it is still in `from`. Returns false if someone else changed it first. */
  transitionCycleStatus(cycleId: string, from: CycleStatus, to: CycleStatus, finalReviewConfirmed: boolean): Promise<boolean>;

  getCycleItems(cycleId: string): Promise<CycleItem[]>;
  addCycleItems(items: CycleItem[]): Promise<void>;
  saveCycleItemsIfVersionMatches(updates: { item: CycleItem; expectedVersion: number }[]): Promise<{ itemId: string; saved: boolean }[]>;

  getMedia(mediaId: string): Promise<MediaAsset | null>;
  /** One query for many ids (avoids N+1). Missing ids are simply absent from the result. */
  getMediaByIds(mediaIds: string[]): Promise<MediaAsset[]>;
  /** Pages of the user's OWN media. Default order is newest, then id. Never loads a whole library at once. */
  listMediaForOwner(userId: string, page: { limit: number; offset: number; kind?: "video" | "image"; search?: string; sort?: MediaSort }): Promise<{ items: MediaAsset[]; total: number }>;
  /**
   * Adds a media record ONLY if the owner's stored bytes plus this file stay within `limitBytes`.
   * Must be atomic (a transaction in PostgreSQL) so two simultaneous uploads cannot both squeeze past the quota.
   * `storageKey` stays inside the repository: it is never returned by queries.
   */
  addMediaIfStorageWithin(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }, limitBytes: number): Promise<boolean>;
  /** For the serving routes ONLY. These keys never leave the server. */
  getMediaStorageInfo(mediaId: string): Promise<{ storageKey: string; thumbnailKey: string | null; mimeType: string | null } | null>;
  /** Every collection (anyone's) that currently contains this media, for access checks. */
  listCollectionsContainingMedia(mediaId: string): Promise<VideoCollection[]>;
  listSocialAccountsForOwner(userId: string): Promise<SocialAccountRecord[]>;
  listCollectionsForOwner(userId: string): Promise<VideoCollection[]>;
  /** Collections other people shared with this user through a currently valid grant. */
  listCollectionsSharedWith(userId: string, now: Date): Promise<VideoCollection[]>;
  listCyclesForOwner(userId: string): Promise<CycleRecord[]>;
  getStorageUsedBytes(userId: string): Promise<number>;
  getMonthlyUsage(userId: string, monthStart: Date): Promise<{ processingSeconds: number; exports: number }>;
  getCollection(collectionId: string): Promise<VideoCollection | null>;
  /**
   * Creates the collection and its items in `mediaIds` order.
   * Returns false when the id already exists, the media list repeats an id, or a media row does not exist.
   * Nothing is written in those cases.
   */
  createCollection(collection: VideoCollection): Promise<boolean>;
  /** Changes the name, description, visibility, and archived flag. Returns false when the collection does not exist. Items stay as they are. */
  updateCollection(collectionId: string, details: { name: string; description: string | null; visibility: CollectionVisibility; archived: boolean }): Promise<boolean>;
  /**
   * Replaces which media belong to the collection, in the given order.
   * Returns false, and writes nothing, when the collection is missing, an id is repeated, or a media row does not exist.
   * The same list sent twice leaves the same rows.
   */
  replaceCollectionMedia(collectionId: string, mediaIds: string[]): Promise<boolean>;
  /**
   * Removes the collection and its membership rows.
   * Does not delete media files or remove those files from any other collection.
   * Returns false when the collection does not exist. Nothing else is written in that case.
   */
  deleteCollection(collectionId: string): Promise<boolean>;
  getGrants(collectionId: string): Promise<CollectionPermissionGrant[]>;
  upsertGrant(grant: CollectionPermissionGrant): Promise<void>;

  getSocialAccount(accountId: string): Promise<SocialAccountRecord | null>;
  getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number>;
  getRecentPublishTimes(userId: string, since: Date): Promise<Date[]>;

  /** Saved editing settings (never part of a media file). Newest first. Includes per-video rows; callers that show the template list must skip reserved names. */
  listTemplatesForOwner(userId: string): Promise<EditingTemplateRecord[]>;
  /** Adds a template only if the owner would still have at most `limit` named templates. Per-video rows do not count. */
  createTemplateIfWithinLimit(template: EditingTemplateRecord, limit: number): Promise<boolean>;
  /** Inserts or replaces the one settings row for this owner and name. Not limited by the template cap. */
  saveVideoSettings(template: EditingTemplateRecord): Promise<void>;
  listAuditsForEntities(entityType: string, entityIds: string[]): Promise<{ entityId: string; action: string; metadata: Record<string, unknown> | null }[]>;

  saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;

  /** A finished export. The storage key stays on the server. */
  findRenderOutput(ownerId: string, sourceMediaId: string, settingsHash: string): Promise<{ id: string; sizeBytes: number } | null>;
  countRenderOutputsSince(ownerId: string, since: Date): Promise<number>;
  /** Writes the export row only when it fits the storage quota. A matching hash returns the existing row. */
  saveRenderOutput(record: { id: string; sourceMediaId: string; ownerId: string; storageKey: string; sizeBytes: number; settingsHash: string; createdAt: Date }, limitBytes: number): Promise<SaveRenderResult>;
  listRenderOutputsForOwner(ownerId: string): Promise<RenderOutputRecord[]>;
  /** Serving only. Includes the storage key, which must not be sent to a browser. */
  getRenderOutput(id: string): Promise<{ id: string; ownerId: string; sourceMediaId: string; sizeBytes: number; storageKey: string } | null>;
  /** Inserts usage rows. A repeated idempotency key is ignored. */
  addUsageRecords(records: UsageRecordDraft[]): Promise<void>;
}
