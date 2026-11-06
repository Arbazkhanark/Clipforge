// Who may render a video. The original file is read only for an owner, or for someone the owner
// explicitly allowed to use or download it. A public or view-only share is not enough.
import { getCollectionCapabilities } from "./sharing-permissions.ts";
import type { CollectionPermissionGrant, Decision, MediaAsset, UserId, VideoCollection } from "./types.ts";

export interface RenderSourceAccess {
  userId: UserId;
  media: MediaAsset;
  containing: { collection: VideoCollection; grants: CollectionPermissionGrant[] }[];
  now: Date;
}

export function decideCanRenderSource(args: RenderSourceAccess): Decision {
  const { userId, media, containing, now } = args;
  if (media.status !== "active" || (media.kind ?? "video") !== "video") return { allowed: false, reason: "This video cannot be rendered." };
  if (media.ownerId === userId) return { allowed: true, reason: "You own this video." };
  const held = new Set<string>();
  for (const { collection, grants } of containing) {
    if (!collection.mediaIds.includes(media.id)) continue;
    for (const capability of getCollectionCapabilities(userId, collection, grants, now)) held.add(capability);
  }
  if (held.has("use_in_cycle") || held.has("download")) return { allowed: true, reason: "The owner allowed you to use this video." };
  return { allowed: false, reason: "You do not have access to this video." };
}
