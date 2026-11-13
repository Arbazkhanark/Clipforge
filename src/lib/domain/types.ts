// Plain data shapes used by the pure business rules.
// These mirror the Prisma models (prisma/schema.prisma) but contain only what the rules need.
// A test (tests/schema-sanity.test.ts) checks the status lists below match the Prisma enums.

export type UserId = string;

// ---------- Media ----------
export const MEDIA_STATUSES = ["active", "pending_deletion", "deleted"] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

export interface MediaAsset {
  id: string;
  ownerId: UserId;
  status: MediaStatus;
  sizeBytes: number;
  /** Only set while status is "pending_deletion": recipients keep access until this moment. */
  deleteAfter: Date | null;
  // Display fields (optional so rule tests stay small). Never put storage keys or URLs here.
  title?: string;
  kind?: "video" | "image";
  durationMs?: number | null;
  createdAt?: Date;
  width?: number | null;
  height?: number | null;
  /** "verified" = ffprobe decoded it; "incomplete" = accepted by file signature only (ffprobe unavailable). */
  validation?: "verified" | "incomplete";
  /** The real type (from the file signature): e.g. "video/mp4". Used for serving. */
  mimeType?: string;
  hasThumbnail?: boolean;
  /** Provenance for an independently owned copy of a shared source. */
  importedFromId?: string | null;
  checksumSha256?: string | null;
}

// ---------- Collections and sharing ----------
export const COLLECTION_VISIBILITIES = ["private", "link", "public_view"] as const;
export type CollectionVisibility = (typeof COLLECTION_VISIBILITIES)[number];

export interface VideoCollection {
  id: string;
  ownerId: UserId;
  visibility: CollectionVisibility;
  archived: boolean;
  /** Media ids currently inside this collection (from CollectionItem rows). */
  mediaIds: string[];
  name?: string;
  description?: string;
  createdAt?: Date;
  /** Older in-memory fixtures default to individual settings. */
  captionMode?: "individual" | "shared";
  sharedCaptionText?: string | null;
  coverMode?: "individual" | "shared";
  sharedCoverMediaId?: string | null;
  settingsVersion?: number;
  items?: CollectionItemSettings[];
}

export interface CollectionItemSettings {
  mediaAssetId: string;
  captionText: string;
  coverMediaId: string | null;
  version: number;
}

/**
 * What a person may do with a collection.
 *  - view:         see names, thumbnails, metadata
 *  - use_in_cycle: reference the video in their own publishing cycle (no copy)
 *  - import_copy:  make an independent copy in their own library
 *  - download:     download the original file (only if owner explicitly allows)
 *  - manage:       delegated management of the collection (never lets you delete owner's files)
 */
export const CAPABILITIES = ["view", "use_in_cycle", "import_copy", "download", "manage"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const GRANT_STATUSES = ["active", "revoked"] as const;
export type GrantStatus = (typeof GRANT_STATUSES)[number];

export interface CollectionPermissionGrant {
  collectionId: string;
  granteeId: UserId;
  capabilities: Capability[];
  status: GrantStatus;
  expiresAt: Date | null;
  /** Who created the grant (the owner or a delegated manager). Delegates may only revoke grants they made. */
  grantedById?: UserId;
}

export interface Decision {
  allowed: boolean;
  /** Human-readable explanation. Shown to users, so keep it clear. */
  reason: string;
}

// ---------- Publishing cycles ----------
export const CYCLE_ITEM_STATUSES = [
  "upcoming", "scheduled", "processing", "publishing",
  "published", "needs_review", "failed", "cancelled",
] as const;
export type CycleItemStatus = (typeof CYCLE_ITEM_STATUSES)[number];

export const CYCLE_STATUSES = ["draft", "running", "paused", "stopped", "completed"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/** Where the video in a cycle item comes from. */
export const SOURCE_KINDS = ["owned", "shared_reference", "imported_copy"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type CaptionSource = "none" | "individual" | "bulk";
export type CoverState = "none" | "saved_internally" | "applied_on_instagram";

export interface CycleItem {
  id: string;
  cycleId: string;
  /** The user whose cycle this is (the person publishing). */
  cycleOwnerId: UserId;
  mediaAssetId: string;
  /** Explicitly selected successful render output; legacy items stay null until selected. */
  selectedRenderOutputId: string | null;
  sourceKind: SourceKind;
  /** The collection the video came from (used to re-check sharing permission). */
  sourceCollectionId: string | null;
  status: CycleItemStatus;
  /** Position in the queue. Lower number = publishes earlier. */
  position: number;
  /** Optimistic-lock counter: increases on EVERY change. Used to detect races. */
  version: number;
  scheduledFor: Date | null;
  // Caption
  captionText: string;
  captionSource: CaptionSource;
  // Cover
  coverMediaId: string | null;
  coverIsCustom: boolean;
  coverState: CoverState;
  // Worker lock
  lockedBy: string | null;
  lockExpiresAt: Date | null;
  /** Why the item needs a human (e.g. "source_removed", "ambiguous_publish_result"). */
  reviewReason: string | null;
  externalPostId?: string | null;
  publishedAt?: Date | null;
}

export interface PublishingCycle {
  id: string;
  ownerId: UserId;
  status: CycleStatus;
  /** True after the user saw and confirmed the final review screen. */
  finalReviewConfirmed: boolean;
}
