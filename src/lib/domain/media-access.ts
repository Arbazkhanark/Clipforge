// Who may see or fetch a media file, and in what form. Pure rules; the server re-runs them on EVERY request.
//   thumbnail: a small preview image  -> owner, or anyone who can see the item through a valid share
//   preview / download: the ORIGINAL file -> owner, or someone the owner explicitly gave "download"
// "Public view" and "use in a publishing cycle" never reveal the original file.
import { getCollectionCapabilities } from "./sharing-permissions.ts";
import type { Capability, CollectionPermissionGrant, Decision, MediaAsset, UserId, VideoCollection } from "./types.ts";

export const MEDIA_VARIANTS = ["thumbnail", "preview", "download"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

export interface ContainingCollection { collection: VideoCollection; grants: CollectionPermissionGrant[]; }

export function decideMediaAccess(args: {
  userId: UserId; media: MediaAsset; containing: ContainingCollection[]; variant: MediaVariant; now: Date;
}): Decision {
  const { userId, media, containing, variant, now } = args;
  const deny = (reason: string): Decision => ({ allowed: false, reason });
  if (media.status === "deleted") return deny("This file has been removed.");
  if (media.ownerId === userId) return { allowed: true, reason: "You own this file." };

  // Everyone else: the owner may have scheduled removal; after the grace period nobody else can fetch it.
  if (media.status === "pending_deletion" && (media.deleteAfter === null || media.deleteAfter <= now)) return deny("The owner removed this file.");

  const held = new Set<Capability>();
  for (const { collection, grants } of containing) {
    if (!collection.mediaIds.includes(media.id)) continue;
    for (const capability of getCollectionCapabilities(userId, collection, grants, now)) held.add(capability);
  }
  if (held.size === 0) return deny("You do not have access to this file.");
  if (variant === "thumbnail") return { allowed: true, reason: "You can see this item." };
  return held.has("download") ? { allowed: true, reason: "The owner allows downloads." } : deny("The owner has not allowed you to view or download the original file.");
}
