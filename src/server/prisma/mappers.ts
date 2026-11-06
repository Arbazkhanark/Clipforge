// Pure conversions between database rows and our domain types. Kept separate so they can be tested on their own.
import type { CollectionPermissionGrant, CycleItem, MediaAsset, VideoCollection } from "../../lib/domain/types.ts";
import { INSTAGRAM_ACCOUNT_TYPES, type CycleRecord, type InstagramAccountType, type SocialAccountRecord } from "../repository.ts";
import type { Row } from "./prisma-client-like.ts";

const optionalNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mediaToRow(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }): Row {
  return {
    id: media.id, ownerId: media.ownerId, kind: media.kind ?? "video", status: media.status, originalFilename: media.title ?? "Untitled",
    mimeType: media.mimeType ?? "application/octet-stream", storageKey: keys.storageKey, thumbnailKey: keys.thumbnailKey,
    sizeBytes: BigInt(media.sizeBytes), durationMs: media.durationMs ?? null, width: media.width ?? null, height: media.height ?? null,
    metadataValidated: media.validation === "verified", deleteAfter: media.deleteAfter, createdAt: media.createdAt ?? new Date(),
  };
}
export function rowToMedia(row: Row): MediaAsset {
  return {
    id: row["id"], ownerId: row["ownerId"], status: row["status"], sizeBytes: Number(row["sizeBytes"]), deleteAfter: row["deleteAfter"] ?? null,
    title: row["originalFilename"], kind: row["kind"], durationMs: optionalNumber(row["durationMs"]), createdAt: row["createdAt"],
    width: optionalNumber(row["width"]), height: optionalNumber(row["height"]), validation: row["metadataValidated"] ? "verified" : "incomplete",
    mimeType: row["mimeType"], hasThumbnail: row["thumbnailKey"] != null,
  };
}

export const rowToCollection = (row: Row, mediaIds: string[]): VideoCollection =>
  ({ id: row["id"], ownerId: row["ownerId"], visibility: row["visibility"], archived: row["archived"], mediaIds, name: row["name"], ...(row["description"] != null ? { description: row["description"] } : {}), ...(row["createdAt"] != null ? { createdAt: row["createdAt"] } : {}) });

export function grantToRow(g: CollectionPermissionGrant): Row {
  return { collectionId: g.collectionId, granteeId: g.granteeId, capabilities: [...g.capabilities], status: g.status, expiresAt: g.expiresAt, grantedById: g.grantedById ?? null, revokedAt: g.status === "revoked" ? new Date() : null };
}
export const rowToGrant = (row: Row): CollectionPermissionGrant =>
  ({ collectionId: row["collectionId"], granteeId: row["granteeId"], capabilities: [...row["capabilities"]], status: row["status"], expiresAt: row["expiresAt"] ?? null, ...(row["grantedById"] != null ? { grantedById: row["grantedById"] } : {}) });

export const cycleToRow = (c: CycleRecord): Row => ({ id: c.id, ownerId: c.ownerId, socialAccountId: c.socialAccountId, name: c.name, status: c.status, finalReviewConfirmed: c.finalReviewConfirmed, repeatBehavior: c.repeatBehavior ?? "never", scheduleSettings: {} });
export const rowToCycle = (row: Row): CycleRecord => ({ id: row["id"], ownerId: row["ownerId"], status: row["status"], finalReviewConfirmed: row["finalReviewConfirmed"], name: row["name"], socialAccountId: row["socialAccountId"], repeatBehavior: row["repeatBehavior"] === "ask" || row["repeatBehavior"] === "automatic" ? row["repeatBehavior"] : "never" });

/** The fields a version-checked update may change. Identity fields (id, cycleId, cycleOwnerId) never change. */
export function itemToMutableData(i: CycleItem): Row {
  return {
    mediaAssetId: i.mediaAssetId, sourceKind: i.sourceKind, sourceCollectionId: i.sourceCollectionId, status: i.status, position: i.position, version: i.version,
    scheduledFor: i.scheduledFor, captionText: i.captionText, captionSource: i.captionSource, coverMediaId: i.coverMediaId, coverIsCustom: i.coverIsCustom,
    coverState: i.coverState, lockedBy: i.lockedBy, lockExpiresAt: i.lockExpiresAt, reviewReason: i.reviewReason,
  };
}
export const itemToRow = (i: CycleItem): Row => ({ id: i.id, cycleId: i.cycleId, cycleOwnerId: i.cycleOwnerId, ...itemToMutableData(i) });
export const rowToItem = (row: Row): CycleItem => ({
  id: row["id"], cycleId: row["cycleId"], cycleOwnerId: row["cycleOwnerId"], mediaAssetId: row["mediaAssetId"], sourceKind: row["sourceKind"], sourceCollectionId: row["sourceCollectionId"] ?? null,
  status: row["status"], position: row["position"], version: row["version"], scheduledFor: row["scheduledFor"] ?? null, captionText: row["captionText"], captionSource: row["captionSource"],
  coverMediaId: row["coverMediaId"] ?? null, coverIsCustom: row["coverIsCustom"], coverState: row["coverState"], lockedBy: row["lockedBy"] ?? null, lockExpiresAt: row["lockExpiresAt"] ?? null, reviewReason: row["reviewReason"] ?? null,
});

const SCOPE_NAME = /^[a-z0-9_]{1,80}$/;
function accountTypeOf(value: unknown): InstagramAccountType | undefined {
  return typeof value === "string" && (INSTAGRAM_ACCOUNT_TYPES as readonly string[]).includes(value) ? value as InstagramAccountType : undefined;
}
function scopesOf(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const scopes = value.split(" ").filter((scope) => SCOPE_NAME.test(scope));
  return scopes.length > 0 ? scopes : undefined;
}
export const rowToSocialAccount = (row: Row): SocialAccountRecord => {
  const hasToken = typeof row["encryptedAccessToken"] === "string" && row["encryptedAccessToken"].length > 0;
  const accountType = accountTypeOf(row["accountType"]);
  const grantedScopes = scopesOf(row["grantedScopes"]);
  return {
    id: row["id"], userId: row["userId"], status: row["status"],
    ...(typeof row["username"] === "string" && row["username"].length > 0 ? { username: row["username"] } : {}),
    ...(accountType ? { accountType } : {}),
    ...(grantedScopes ? { grantedScopes } : {}),
    ...(row["tokenExpiresAt"] instanceof Date ? { tokenExpiresAt: row["tokenExpiresAt"] } : {}),
    ...(hasToken ? { hasToken: true } : {}),
  };
};
