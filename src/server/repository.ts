// The database as the handlers see it. The real implementation (Prisma + PostgreSQL) comes later;
// src/server/memory-repository.ts is a faithful in-memory version used by the tests.
//
// CONCURRENCY CONTRACT: saveCycleItemsIfVersionMatches must behave like
//   UPDATE "CycleItem" SET ... , version = :newVersion WHERE id = :id AND version = :expectedVersion
// for each item, and report whether a row changed. Two writers can never both win.
import type { PlanId } from "../lib/billing/catalog.ts";
import type { CaptionRevision } from "../lib/domain/caption-cover-updates.ts";
import type { CollectionPermissionGrant, CycleItem, CycleStatus, MediaAsset, PublishingCycle, VideoCollection } from "../lib/domain/types.ts";

export interface CycleRecord extends PublishingCycle { name: string; socialAccountId: string; }
export interface SocialAccountRecord { id: string; userId: string; status: "connected" | "token_expired" | "revoked" | "disconnected"; }
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
  getCollection(collectionId: string): Promise<VideoCollection | null>;
  getGrants(collectionId: string): Promise<CollectionPermissionGrant[]>;
  upsertGrant(grant: CollectionPermissionGrant): Promise<void>;

  getSocialAccount(accountId: string): Promise<SocialAccountRecord | null>;
  getScheduledItemsUsedThisMonth(userId: string, monthStart: Date): Promise<number>;
  getRecentPublishTimes(userId: string, since: Date): Promise<Date[]>;

  saveCaptionRevisions(revisions: CaptionRevision[]): Promise<void>;
  appendAudit(entry: AuditEntry): Promise<void>;
}
