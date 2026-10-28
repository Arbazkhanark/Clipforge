// Mix and Unmix: combining owned and shared videos in one cycle, and taking them out again.
// Unmixing only touches the CYCLE ITEM. It never changes the source video, the owner's
// collection, or anyone's sharing permissions.
import { canAddVideoToCycle } from "./sharing-permissions.ts";
import { FINISHED_ITEM_STATUSES, isEditableItem, isInFlightItem, moveItemToStatus } from "./cycle-state.ts";
import type {
  CollectionPermissionGrant, CycleItem, MediaAsset, SourceKind, UserId, VideoCollection,
} from "./types.ts";

/** The slice of the plan catalog these rules need (see src/lib/billing/catalog.ts). */
export interface MixPlanFeatures {
  useSharedVideosInCycles: boolean;
  mixAndUnmix: boolean;
}

export interface MixCandidate {
  media: MediaAsset;
  /** The collection the user picked this video from. */
  collection: VideoCollection;
  /** True when this media is the user's own imported copy of someone else's video. */
  isImportedCopy?: boolean;
}

export interface MixRejection { mediaAssetId: string; reason: string; }

export interface NewCycleItemDraft {
  mediaAssetId: string;
  sourceKind: SourceKind;
  sourceCollectionId: string;
  position: number;
}

export interface MixResult {
  accepted: NewCycleItemDraft[];
  rejected: MixRejection[];
}

function decideSourceKind(userId: UserId, candidate: MixCandidate): SourceKind {
  if (candidate.media.ownerId !== userId) return "shared_reference";
  return candidate.isImportedCopy ? "imported_copy" : "owned";
}

/**
 * Decide which candidates can join the cycle. Does not modify anything.
 * Rules:
 *  - Every video needs permission RIGHT NOW (canAddVideoToCycle).
 *  - Shared videos need the plan feature useSharedVideosInCycles.
 *  - Mixing owners (owned + shared, or several owners) needs the plan feature mixAndUnmix.
 *  - The same underlying video cannot be added twice unless the user confirmed that repeat.
 */
export function mixVideosIntoCycle(args: {
  userId: UserId;
  candidates: MixCandidate[];
  existingItems: CycleItem[];
  grants: CollectionPermissionGrant[];
  planFeatures: MixPlanFeatures;
  /** Media ids the user explicitly said "yes, repeat this one". */
  confirmedDuplicateMediaIds?: string[];
  now: Date;
}): MixResult {
  const { userId, candidates, existingItems, grants, planFeatures, now } = args;
  const confirmedDuplicates = new Set(args.confirmedDuplicateMediaIds ?? []);
  const accepted: NewCycleItemDraft[] = [];
  const rejected: MixRejection[] = [];

  const hasSharedCandidate = candidates.some((c) => c.media.ownerId !== userId);
  const ownerIds = new Set(candidates.map((c) => c.media.ownerId));
  const isMixedOwnership = ownerIds.size > 1;

  if (hasSharedCandidate && !planFeatures.useSharedVideosInCycles) {
    return { accepted, rejected: candidates.filter((c) => c.media.ownerId !== userId).map((c) => ({ mediaAssetId: c.media.id, reason: "Your plan does not include using shared videos in cycles." })) };
  }
  if (isMixedOwnership && !planFeatures.mixAndUnmix) {
    return { accepted, rejected: candidates.map((c) => ({ mediaAssetId: c.media.id, reason: "Your plan does not include mixing videos from different owners." })) };
  }

  // Media already in this cycle and still relevant (not cancelled).
  const alreadyInCycle = new Set(existingItems.filter((i) => i.status !== "cancelled").map((i) => i.mediaAssetId));
  const addedThisRequest = new Set<string>();
  let nextPosition = existingItems.reduce((highest, i) => Math.max(highest, i.position), 0) + 1;

  for (const candidate of candidates) {
    const mediaId = candidate.media.id;
    const permission = canAddVideoToCycle(userId, candidate.media, candidate.collection, grants, now);
    if (!permission.allowed) { rejected.push({ mediaAssetId: mediaId, reason: permission.reason }); continue; }

    const isDuplicate = alreadyInCycle.has(mediaId) || addedThisRequest.has(mediaId);
    if (isDuplicate && !confirmedDuplicates.has(mediaId)) {
      rejected.push({ mediaAssetId: mediaId, reason: "This video is already in the cycle. Confirm to repeat it on purpose." });
      continue;
    }
    addedThisRequest.add(mediaId);
    accepted.push({ mediaAssetId: mediaId, sourceKind: decideSourceKind(userId, candidate), sourceCollectionId: candidate.collection.id, position: nextPosition++ });
  }
  return { accepted, rejected };
}

/**
 * Reorder items that have not started yet. Items that are published, in flight, or need review
 * keep their exact positions; only editable items swap among the editable slots.
 */
export function reorderUpcomingItems(items: CycleItem[], desiredOrderOfEditableIds: string[]):
  { ok: true; items: CycleItem[] } | { ok: false; reason: string } {
  const editableItems = items.filter(isEditableItem);
  const editableIds = new Set(editableItems.map((i) => i.id));
  const requestedIds = new Set(desiredOrderOfEditableIds);

  if (requestedIds.size !== desiredOrderOfEditableIds.length) return { ok: false, reason: "The new order lists an item twice." };
  for (const id of desiredOrderOfEditableIds) {
    if (!editableIds.has(id)) return { ok: false, reason: "Only upcoming items can be reordered; one item is published, in progress, or unknown." };
  }
  if (requestedIds.size !== editableIds.size) return { ok: false, reason: "The new order must include every upcoming item." };

  const slots = editableItems.map((i) => i.position).sort((a, b) => a - b);
  const newPositionById = new Map(desiredOrderOfEditableIds.map((id, index) => [id, slots[index] as number]));
  return {
    ok: true,
    items: items.map((item) => {
      const newPosition = newPositionById.get(item.id);
      return newPosition === undefined || newPosition === item.position ? item : { ...item, position: newPosition, version: item.version + 1 };
    }),
  };
}

export interface UnmixResult {
  items: CycleItem[];
  /** Upcoming items that were taken out of the cycle (status becomes "cancelled", row kept for history). */
  removedItemIds: string[];
  /** Items we could not remove, with the real reason shown to the user. */
  blocked: { itemId: string; reason: string }[];
}

/**
 * Take items out of a cycle. Removing = status "cancelled" (the row stays for the audit trail).
 * Never deletes media, collections or grants. Published items stay as history.
 */
export function unmixItems(items: CycleItem[], itemIdsToRemove: string[]): UnmixResult {
  const removeIds = new Set(itemIdsToRemove);
  const removedItemIds: string[] = [];
  const blocked: UnmixResult["blocked"] = [];

  const updatedItems = items.map((item) => {
    if (!removeIds.has(item.id)) return item;
    if (item.status === "published") { blocked.push({ itemId: item.id, reason: "Already published. It stays in your history; removing it does not unpublish the post." }); return item; }
    if (isInFlightItem(item)) { blocked.push({ itemId: item.id, reason: `This item is currently ${item.status}. Try again when it finishes.` }); return item; }
    if (FINISHED_ITEM_STATUSES.includes(item.status)) return item; // already cancelled: nothing to do
    removedItemIds.push(item.id);
    return moveItemToStatus(item, "cancelled", { lockedBy: null, lockExpiresAt: null });
  });
  return { items: updatedItems, removedItemIds, blocked };
}
