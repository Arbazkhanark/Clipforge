// Small builders so each test only states what matters.
import type { CollectionPermissionGrant, CycleItem, MediaAsset, PublishingCycle, VideoCollection } from "../src/lib/domain/types.ts";

export const NOW = new Date("2026-06-01T12:00:00Z");
export const inDays = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

export const makeMedia = (over: Partial<MediaAsset> = {}): MediaAsset =>
  ({ id: "media1", ownerId: "owner", status: "active", sizeBytes: 1000, deleteAfter: null, ...over });

export const makeCollection = (over: Partial<VideoCollection> = {}): VideoCollection =>
  ({ id: "col1", ownerId: "owner", visibility: "private", archived: false, mediaIds: ["media1"], ...over });

export const makeGrant = (over: Partial<CollectionPermissionGrant> = {}): CollectionPermissionGrant =>
  ({ collectionId: "col1", granteeId: "bob", capabilities: ["view", "use_in_cycle"], status: "active", expiresAt: null, ...over });

export const makeItem = (over: Partial<CycleItem> = {}): CycleItem => ({
  id: "item1", cycleId: "cycle1", cycleOwnerId: "bob", mediaAssetId: "media1", sourceKind: "shared_reference",
  sourceCollectionId: "col1", status: "upcoming", position: 1, version: 1, scheduledFor: null,
  captionText: "", captionSource: "none", coverMediaId: null, coverIsCustom: false, coverState: "none",
  lockedBy: null, lockExpiresAt: null, reviewReason: null, ...over,
});

export const makeCycle = (over: Partial<PublishingCycle> = {}): PublishingCycle =>
  ({ id: "cycle1", ownerId: "bob", status: "running", finalReviewConfirmed: true, ...over });
