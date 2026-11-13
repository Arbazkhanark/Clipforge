// Pure conversions between database rows and our domain types. Kept separate so they can be tested on their own.
import type { CollectionPermissionGrant, CycleItem, MediaAsset, VideoCollection } from "../../lib/domain/types.ts";
import { isValidTimeZone, validateScheduleSettings, type ScheduleSettings } from "../../lib/domain/schedule.ts";
import { INSTAGRAM_ACCOUNT_TYPES, type CycleRecord, type InstagramAccountType, type PersistedCycleSchedule, type SocialAccountRecord } from "../repository.ts";
import { normalizeInstagramScopes } from "../../lib/integrations/instagram-eligibility.ts";
import type { Row } from "./prisma-client-like.ts";

function validScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const optionalNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function mediaToRow(media: MediaAsset, keys: { storageKey: string; thumbnailKey: string | null }): Row {
  return {
    id: media.id, ownerId: media.ownerId, kind: media.kind ?? "video", status: media.status, originalFilename: media.title ?? "Untitled",
    mimeType: media.mimeType ?? "application/octet-stream", storageKey: keys.storageKey, thumbnailKey: keys.thumbnailKey,
    sizeBytes: BigInt(media.sizeBytes), durationMs: media.durationMs ?? null, width: media.width ?? null, height: media.height ?? null,
    metadataValidated: media.validation === "verified", deleteAfter: media.deleteAfter, importedFromId: media.importedFromId ?? null,
    checksumSha256: media.checksumSha256 ?? null, createdAt: media.createdAt ?? new Date(),
  };
}
export function rowToMedia(row: Row): MediaAsset {
  return {
    id: row["id"], ownerId: row["ownerId"], status: row["status"], sizeBytes: Number(row["sizeBytes"]), deleteAfter: row["deleteAfter"] ?? null,
    title: row["originalFilename"], kind: row["kind"], durationMs: optionalNumber(row["durationMs"]), createdAt: row["createdAt"],
    width: optionalNumber(row["width"]), height: optionalNumber(row["height"]), validation: row["metadataValidated"] ? "verified" : "incomplete",
    mimeType: row["mimeType"], hasThumbnail: row["thumbnailKey"] != null, importedFromId: row["importedFromId"] ?? null, checksumSha256: row["checksumSha256"] ?? null,
  };
}

export const rowToCollection = (row: Row, mediaIds: string[], items: { mediaAssetId: string; captionText: string; coverMediaId: string | null; version: number }[] = []): VideoCollection =>
  ({ id: row["id"], ownerId: row["ownerId"], visibility: row["visibility"], archived: row["archived"], mediaIds, name: row["name"], captionMode: row["captionMode"] === "shared" ? "shared" : "individual", sharedCaptionText: row["sharedCaptionText"] ?? null, coverMode: row["coverMode"] === "shared" ? "shared" : "individual", sharedCoverMediaId: row["sharedCoverMediaId"] ?? null, settingsVersion: typeof row["settingsVersion"] === "number" ? row["settingsVersion"] : 1, items, ...(row["description"] != null ? { description: row["description"] } : {}), ...(row["createdAt"] != null ? { createdAt: row["createdAt"] } : {}) });

export function grantToRow(g: CollectionPermissionGrant): Row {
  return { collectionId: g.collectionId, granteeId: g.granteeId, capabilities: [...g.capabilities], status: g.status, expiresAt: g.expiresAt, grantedById: g.grantedById ?? null, revokedAt: g.status === "revoked" ? new Date() : null };
}
export const rowToGrant = (row: Row): CollectionPermissionGrant =>
  ({ collectionId: row["collectionId"], granteeId: row["granteeId"], capabilities: [...row["capabilities"]], status: row["status"], expiresAt: row["expiresAt"] ?? null, ...(row["grantedById"] != null ? { grantedById: row["grantedById"] } : {}) });

function cycleScheduleFromJson(value: unknown): PersistedCycleSchedule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const settings: ScheduleSettings = {
    timeZone: typeof row["timeZone"] === "string" ? row["timeZone"] : "",
    intervalMinutes: typeof row["intervalMinutes"] === "number" ? row["intervalMinutes"] : Number.NaN,
    postsPerInterval: typeof row["postsPerInterval"] === "number" ? row["postsPerInterval"] : Number.NaN,
    daysOfWeek: Array.isArray(row["daysOfWeek"]) ? row["daysOfWeek"] as number[] : [],
    windowStart: typeof row["windowStart"] === "string" ? row["windowStart"] : "",
    windowEnd: typeof row["windowEnd"] === "string" ? row["windowEnd"] : "",
    dailyMax: typeof row["dailyMax"] === "number" ? row["dailyMax"] : row["dailyMax"] === null ? null : Number.NaN,
    endDate: typeof row["endDate"] === "string" ? row["endDate"] : row["endDate"] === null ? null : "invalid",
  };
  const startDate = row["startDate"];
  if (!validScheduleDate(startDate) || (settings.endDate !== null && !validScheduleDate(settings.endDate)) || (settings.endDate !== null && settings.endDate < startDate) || !validateScheduleSettings(settings).valid) return null;
  return { ...settings, startDate };
}

export const cycleToRow = (c: CycleRecord): Row => ({ id: c.id, ownerId: c.ownerId, socialAccountId: c.socialAccountId, name: c.name, status: c.status, finalReviewConfirmed: c.finalReviewConfirmed, repeatBehavior: c.repeatBehavior ?? "never", timezone: c.scheduleSettings?.timeZone ?? c.timezone ?? "Asia/Kolkata", scheduleSettings: c.scheduleSettings ?? {}, ...(c.createdAt ? { createdAt: c.createdAt } : {}) });
export const rowToCycle = (row: Row): CycleRecord => {
  const scheduleSettings = cycleScheduleFromJson(row["scheduleSettings"]);
  const timezone = scheduleSettings?.timeZone ?? (typeof row["timezone"] === "string" && isValidTimeZone(row["timezone"]) ? row["timezone"] : "Asia/Kolkata");
  return { id: row["id"], ownerId: row["ownerId"], status: row["status"], finalReviewConfirmed: row["finalReviewConfirmed"], name: row["name"], socialAccountId: row["socialAccountId"], repeatBehavior: row["repeatBehavior"] === "ask" || row["repeatBehavior"] === "automatic" ? row["repeatBehavior"] : "never", timezone, scheduleSettings, ...(row["createdAt"] instanceof Date ? { createdAt: row["createdAt"] } : {}) };
};

/** The fields a version-checked update may change. Identity fields (id, cycleId, cycleOwnerId) never change. */
export function itemToMutableData(i: CycleItem): Row {
  return {
    mediaAssetId: i.mediaAssetId, selectedRenderOutputId: i.selectedRenderOutputId, selectedRenderOwnerId: i.selectedRenderOutputId === null ? null : i.cycleOwnerId,
    selectedRenderSourceMediaId: i.selectedRenderOutputId === null ? null : i.mediaAssetId,
    sourceKind: i.sourceKind, sourceCollectionId: i.sourceCollectionId, status: i.status, position: i.position, version: i.version,
    scheduledFor: i.scheduledFor, captionText: i.captionText, captionSource: i.captionSource, coverMediaId: i.coverMediaId, coverIsCustom: i.coverIsCustom,
    coverState: i.coverState, lockedBy: i.lockedBy, lockExpiresAt: i.lockExpiresAt, reviewReason: i.reviewReason,
    externalPostId: i.externalPostId ?? null, publishedAt: i.publishedAt ?? null,
  };
}
export const itemToRow = (i: CycleItem): Row => ({ id: i.id, cycleId: i.cycleId, cycleOwnerId: i.cycleOwnerId, ...itemToMutableData(i) });
export const rowToItem = (row: Row): CycleItem => ({
  id: row["id"], cycleId: row["cycleId"], cycleOwnerId: row["cycleOwnerId"], mediaAssetId: row["mediaAssetId"], selectedRenderOutputId: row["selectedRenderOutputId"] ?? null, sourceKind: row["sourceKind"], sourceCollectionId: row["sourceCollectionId"] ?? null,
  status: row["status"], position: row["position"], version: row["version"], scheduledFor: row["scheduledFor"] ?? null, captionText: row["captionText"], captionSource: row["captionSource"],
  coverMediaId: row["coverMediaId"] ?? null, coverIsCustom: row["coverIsCustom"], coverState: row["coverState"], lockedBy: row["lockedBy"] ?? null, lockExpiresAt: row["lockExpiresAt"] ?? null, reviewReason: row["reviewReason"] ?? null,
  externalPostId: row["externalPostId"] ?? null, publishedAt: row["publishedAt"] ?? null,
});

function accountTypeOf(value: unknown): InstagramAccountType | undefined {
  return typeof value === "string" && (INSTAGRAM_ACCOUNT_TYPES as readonly string[]).includes(value) ? value as InstagramAccountType : undefined;
}
function scopesOf(value: unknown): string[] | undefined {
  const parsed = normalizeInstagramScopes(value);
  return !parsed.malformed && parsed.scopes.length > 0 ? parsed.scopes : undefined;
}
export const rowToSocialAccount = (row: Row): SocialAccountRecord => {
  const hasToken = typeof row["encryptedAccessToken"] === "string" && row["encryptedAccessToken"].length > 0;
  const accountType = accountTypeOf(row["accountType"]);
  const grantedScopes = scopesOf(row["grantedScopes"]);
  return {
    id: row["id"], userId: row["userId"], status: row["status"],
    ...(row["platform"] === "instagram" || row["platform"] === "youtube_shorts" || row["platform"] === "tiktok" ? { platform: row["platform"] } : {}),
    ...(typeof row["username"] === "string" && row["username"].length > 0 ? { username: row["username"] } : {}),
    ...(accountType ? { accountType } : {}),
    ...(grantedScopes ? { grantedScopes } : {}),
    ...(row["tokenExpiresAt"] instanceof Date ? { tokenExpiresAt: row["tokenExpiresAt"] } : {}),
    ...(hasToken ? { hasToken: true } : {}),
  };
};
