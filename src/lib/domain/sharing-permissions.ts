// Collection ownership and sharing rules. Pure functions: no database, no network.
// The server loads rows, calls these functions, and enforces the answer.
// RULE: permission must be re-checked at every sensitive moment (add, process, publish, import).
import { createHash, randomBytes } from "node:crypto";
import type {
  Capability, CollectionPermissionGrant, Decision, MediaAsset, UserId, VideoCollection, CycleItem,
} from "./types.ts";

const allow = (reason: string): Decision => ({ allowed: true, reason });
const deny = (reason: string): Decision => ({ allowed: false, reason });

function grantIsCurrentlyValid(grant: CollectionPermissionGrant, now: Date): boolean {
  if (grant.status !== "active") return false;
  if (grant.expiresAt !== null && grant.expiresAt <= now) return false;
  return true;
}

/** Everything `userId` may do with `collection` right now. */
export function getCollectionCapabilities(
  userId: UserId, collection: VideoCollection, grants: CollectionPermissionGrant[], now: Date,
): Set<Capability> {
  // The owner can do everything with their own collection.
  if (collection.ownerId === userId) {
    return new Set<Capability>(["view", "use_in_cycle", "import_copy", "download", "manage"]);
  }

  const capabilities = new Set<Capability>();

  // Collect capabilities from this user's currently valid grants for THIS collection.
  for (const grant of grants) {
    if (grant.collectionId !== collection.id || grant.granteeId !== userId) continue;
    if (!grantIsCurrentlyValid(grant, now)) continue;
    for (const capability of grant.capabilities) capabilities.add(capability);
  }
  if (capabilities.has("manage")) capabilities.add("view"); // managing implies viewing

  // Public view lets anyone LOOK. It never gives use/import/download.
  if (collection.visibility === "public_view") capabilities.add("view");

  // Archived collections stay visible but cannot be newly used, imported, or downloaded by others.
  if (collection.archived) {
    capabilities.delete("use_in_cycle");
    capabilities.delete("import_copy");
    capabilities.delete("download");
  }
  return capabilities;
}

export function canViewCollection(userId: UserId, collection: VideoCollection, grants: CollectionPermissionGrant[], now: Date): Decision {
  return getCollectionCapabilities(userId, collection, grants, now).has("view")
    ? allow("You can view this collection.")
    : deny("You do not have access to this collection.");
}

/** Shared by the checks below: is the video inside this collection and not deleted? */
function checkVideoBelongsToCollection(media: MediaAsset, collection: VideoCollection): Decision | null {
  if (!collection.mediaIds.includes(media.id)) return deny("This video is no longer part of that collection.");
  if (media.status === "deleted") return deny("This video has been removed by its owner.");
  return null;
}

/**
 * Can `userId` ADD this video to a (new or existing) cycle?
 * Owners can always use their own active media. Recipients need the use_in_cycle capability.
 * Videos scheduled for deletion cannot be newly added by anyone.
 */
export function canAddVideoToCycle(
  userId: UserId, media: MediaAsset, collection: VideoCollection, grants: CollectionPermissionGrant[], now: Date,
): Decision {
  const problem = checkVideoBelongsToCollection(media, collection);
  if (problem) return problem;
  if (media.status === "pending_deletion") return deny("The owner has scheduled this video for removal, so it cannot be newly added.");
  if (media.ownerId === userId) return allow("You own this video.");

  const capabilities = getCollectionCapabilities(userId, collection, grants, now);
  return capabilities.has("use_in_cycle")
    ? allow("The owner allows this video to be used in publishing cycles.")
    : deny("The owner has not given you permission to use this video in a publishing cycle.");
}

/**
 * Can `userId` import an independent copy?
 * Allowed during the owner's grace period (pending_deletion) so recipients can save what they need.
 */
export function canImportVideo(
  userId: UserId, media: MediaAsset, collection: VideoCollection, grants: CollectionPermissionGrant[], now: Date,
): Decision {
  const problem = checkVideoBelongsToCollection(media, collection);
  if (problem) return problem;
  if (media.ownerId === userId) return deny("You already own this video.");
  if (media.status === "pending_deletion" && (media.deleteAfter === null || media.deleteAfter <= now)) {
    return deny("The grace period for this video has ended.");
  }
  return getCollectionCapabilities(userId, collection, grants, now).has("import_copy")
    ? allow("The owner allows you to import a copy.")
    : deny("The owner has not given you permission to import this video.");
}

export function canDownloadVideo(
  userId: UserId, media: MediaAsset, collection: VideoCollection, grants: CollectionPermissionGrant[], now: Date,
): Decision {
  const problem = checkVideoBelongsToCollection(media, collection);
  if (problem) return problem;
  if (media.ownerId === userId) return allow("You own this video.");
  return getCollectionCapabilities(userId, collection, grants, now).has("download")
    ? allow("The owner allows downloads.")
    : deny("Downloading is not allowed for this video.");
}

/**
 * Re-check the SOURCE of a video that is ALREADY in a cycle.
 * Call before processing and again before publishing - a permission that was valid when the
 * video was added may have been revoked since.
 * Difference from canAddVideoToCycle: a video in its grace period (pending_deletion) may still be
 * used by items that are already in a cycle, until the grace period ends.
 */
export function canKeepUsingSourceForCycleItem(
  item: CycleItem, media: MediaAsset | null, collection: VideoCollection | null,
  grants: CollectionPermissionGrant[], now: Date,
): Decision {
  if (media === null || media.status === "deleted") return deny("The source video no longer exists.");
  if (media.status === "pending_deletion" && (media.deleteAfter === null || media.deleteAfter <= now)) {
    return deny("The owner removed this video after the grace period.");
  }
  // Videos the cycle owner owns (including imported copies) just need to exist.
  if (media.ownerId === item.cycleOwnerId) return allow("You own this video.");

  if (item.sourceKind !== "shared_reference") return deny("This item is not marked as a shared reference.");
  if (collection === null || item.sourceCollectionId !== collection.id) return deny("The sharing collection is no longer available.");
  if (!collection.mediaIds.includes(media.id)) return deny("The owner removed this video from the shared collection.");
  return getCollectionCapabilities(item.cycleOwnerId, collection, grants, now).has("use_in_cycle")
    ? allow("Sharing permission is still valid.")
    : deny("The owner revoked your permission to use this video.");
}

// ---------- Share links ----------

export interface ShareLinkRecord {
  tokenHash: string;
  revoked: boolean;
  expiresAt: Date | null;
}

/** Create a random, unguessable token. Show it to the owner ONCE; store only its hash. */
export function generateShareToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashShareToken(token) };
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validateShareLink(link: ShareLinkRecord, presentedToken: string, now: Date): Decision {
  // Compare hashes, so the database never holds a usable token.
  if (hashShareToken(presentedToken) !== link.tokenHash) return deny("This link is not valid.");
  if (link.revoked) return deny("The owner has turned this link off.");
  if (link.expiresAt !== null && link.expiresAt <= now) return deny("This link has expired.");
  return allow("Link is valid.");
}

// ---------- Access requests ----------

export type AccessRequestStatus = "pending" | "approved" | "rejected";

export interface AccessRequest {
  collectionId: string;
  requesterId: UserId;
  requestedCapabilities: Capability[];
  status: AccessRequestStatus;
}

/** A user may have only one pending request per collection. Owners cannot request their own collection. */
export function canCreateAccessRequest(
  requesterId: UserId, collection: VideoCollection, existingRequests: AccessRequest[],
): Decision {
  if (collection.ownerId === requesterId) return deny("You own this collection.");
  // Private collections only accept requests via an owner-shared link; the caller validates that first.
  const alreadyPending = existingRequests.some(
    (r) => r.collectionId === collection.id && r.requesterId === requesterId && r.status === "pending",
  );
  return alreadyPending ? deny("You already have a pending request for this collection.") : allow("Request can be created.");
}

/** Only the owner decides. Approving creates a grant; submitting a request never grants anything. */
export function decideAccessRequest(
  deciderId: UserId, collection: VideoCollection, request: AccessRequest, decision: "approved" | "rejected",
  grantedCapabilities: Capability[] = request.requestedCapabilities,
): { ok: true; request: AccessRequest; newGrant: CollectionPermissionGrant | null } | { ok: false; reason: string } {
  if (collection.ownerId !== deciderId) return { ok: false, reason: "Only the collection owner can decide access requests." };
  if (request.status !== "pending") return { ok: false, reason: "This request was already decided." };
  if (decision === "rejected") return { ok: true, request: { ...request, status: "rejected" }, newGrant: null };
  if (grantedCapabilities.length === 0) return { ok: false, reason: "Choose at least one permission to grant." };
  return {
    ok: true,
    request: { ...request, status: "approved" },
    newGrant: { collectionId: collection.id, granteeId: request.requesterId, capabilities: grantedCapabilities, status: "active", expiresAt: null },
  };
}

/** Revoking keeps the row (for the audit trail) but makes it useless. */
export function revokeGrant(ownerId: UserId, collection: VideoCollection, grant: CollectionPermissionGrant):
  { ok: true; grant: CollectionPermissionGrant } | { ok: false; reason: string } {
  if (collection.ownerId !== ownerId) return { ok: false, reason: "Only the owner can revoke access." };
  return { ok: true, grant: { ...grant, status: "revoked" } };
}
