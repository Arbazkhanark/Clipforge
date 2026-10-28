// Bulk and single updates of captions and covers for cycle items.
// GOLDEN RULES:
//  1. Only "upcoming" / "scheduled" items can change. Published history is NEVER rewritten.
//  2. Items a worker is touching (processing/publishing) are skipped, not forced.
//  3. Custom (individually chosen) captions/covers are not overwritten without confirmation.
//  4. Every change checks the item's version (optimistic lock) so we never overwrite a newer edit
//     or race with a worker that just claimed the item.
//  5. Results are reported per item. We never say "all updated" if some were not.
import { isEditableItem } from "./cycle-state.ts";
import type { CycleItem, UserId } from "./types.ts";

// ---------- Caption validation ----------
/**
 * UNVERIFIED ASSUMPTION: these numbers come from memory of Instagram's documented limits
 * (2,200 characters, 30 hashtags). They have NOT been checked against current official docs
 * (no network in this environment). Re-verify before relying on them.
 */
export const CAPTION_RULES_UNVERIFIED = { maxLength: 2200, maxHashtags: 30 } as const;

export function validateCaption(captionText: string): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  if (captionText.length > CAPTION_RULES_UNVERIFIED.maxLength) {
    problems.push(`Caption is ${captionText.length} characters; the limit we check is ${CAPTION_RULES_UNVERIFIED.maxLength}.`);
  }
  const hashtagCount = (captionText.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashtagCount > CAPTION_RULES_UNVERIFIED.maxHashtags) {
    problems.push(`Caption has ${hashtagCount} hashtags; the limit we check is ${CAPTION_RULES_UNVERIFIED.maxHashtags}.`);
  }
  return { valid: problems.length === 0, problems };
}

// ---------- Choosing which items are affected ----------
export type UpdateTarget =
  | { kind: "all_upcoming" }
  | { kind: "selected"; itemIds: string[] };

type SkipReason = string;

interface TargetedItem { item: CycleItem; skipReason: SkipReason | null; }

function explainWhyNotEditable(item: CycleItem): SkipReason {
  switch (item.status) {
    case "published": return "Already published. History is never changed.";
    case "processing":
    case "publishing": return `Currently ${item.status}. Wait until it finishes.`;
    case "needs_review": return "Needs review first. Resolve it before editing.";
    case "failed": return "Failed. Retry it first, then edit.";
    case "cancelled": return "Removed from the cycle.";
    default: return "Not editable.";
  }
}

/** Turn a target (all upcoming, or a list of ids) into the items to consider + the reasons for skipping. */
function selectTargetItems(items: CycleItem[], target: UpdateTarget): { targeted: TargetedItem[]; unknownIds: string[] } {
  if (target.kind === "all_upcoming") {
    return { targeted: items.filter(isEditableItem).map((item) => ({ item, skipReason: null })), unknownIds: [] };
  }
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const targeted: TargetedItem[] = [];
  const unknownIds: string[] = [];
  for (const id of new Set(target.itemIds)) {
    const item = itemsById.get(id);
    if (!item) { unknownIds.push(id); continue; }
    targeted.push({ item, skipReason: isEditableItem(item) ? null : explainWhyNotEditable(item) });
  }
  return { targeted, unknownIds };
}

export type ItemOutcome = "updated" | "will_update" | "needs_overwrite_confirmation" | "skipped" | "conflict";

export interface ItemResult { itemId: string; outcome: ItemOutcome; reason: string; }

// ---------- Captions ----------
export interface CaptionRevision {
  itemId: string;
  previousText: string;
  newText: string;
  source: "bulk" | "individual";
  changedBy: UserId;
  changedAt: Date;
}

/** Has the user typed their own caption for this item that a bulk change would replace? */
const hasCustomCaption = (item: CycleItem, newCaption: string): boolean =>
  item.captionSource === "individual" && item.captionText.trim() !== "" && item.captionText !== newCaption;

/** Decide, for each targeted item, what WOULD happen. Changes nothing. Used by the preview screen. */
export function previewBulkCaptionUpdate(args: {
  items: CycleItem[]; target: UpdateTarget; newCaption: string; overwriteCustomConfirmed: boolean;
}): ItemResult[] {
  const { items, target, newCaption, overwriteCustomConfirmed } = args;
  const { targeted, unknownIds } = selectTargetItems(items, target);
  const results: ItemResult[] = unknownIds.map((id) => ({ itemId: id, outcome: "skipped", reason: "Not part of this cycle." }));

  for (const { item, skipReason } of targeted) {
    if (skipReason) results.push({ itemId: item.id, outcome: "skipped", reason: skipReason });
    else if (item.captionText === newCaption) results.push({ itemId: item.id, outcome: "skipped", reason: "Already has this caption." });
    else if (hasCustomCaption(item, newCaption) && !overwriteCustomConfirmed) {
      results.push({ itemId: item.id, outcome: "needs_overwrite_confirmation", reason: "Has a custom caption. Confirm to replace it." });
    } else results.push({ itemId: item.id, outcome: "will_update", reason: "Will receive the new caption." });
  }
  return results;
}

export interface BulkCaptionResult {
  /** false only when the caption itself is invalid; then nothing was changed. */
  ok: boolean;
  problems: string[];
  items: CycleItem[];
  results: ItemResult[];
  revisions: CaptionRevision[];
  summary: { updated: number; skipped: number; conflicts: number; needsConfirmation: number };
}

/**
 * Apply a caption to targeted upcoming items.
 * `expectedVersions` = the version of each item when the user looked at it. If an item changed
 * since (user edit, or a worker claimed it), it is reported as a conflict and left untouched.
 */
export function applyBulkCaptionUpdate(args: {
  items: CycleItem[]; target: UpdateTarget; newCaption: string; overwriteCustomConfirmed: boolean;
  expectedVersions: Record<string, number>; changedBy: UserId; now: Date;
}): BulkCaptionResult {
  const { items, target, newCaption, overwriteCustomConfirmed, expectedVersions, changedBy, now } = args;
  const validation = validateCaption(newCaption);
  if (!validation.valid) {
    return { ok: false, problems: validation.problems, items, results: [], revisions: [], summary: { updated: 0, skipped: 0, conflicts: 0, needsConfirmation: 0 } };
  }

  const decisions = previewBulkCaptionUpdate({ items, target, newCaption, overwriteCustomConfirmed });
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const updatedItemsById = new Map<string, CycleItem>();
  const revisions: CaptionRevision[] = [];

  const results = decisions.map((decision): ItemResult => {
    if (decision.outcome !== "will_update") return decision;
    const currentItem = itemsById.get(decision.itemId) as CycleItem;
    if (expectedVersions[currentItem.id] !== currentItem.version) {
      return { itemId: currentItem.id, outcome: "conflict", reason: "Changed since you opened it. Reload and try again." };
    }
    updatedItemsById.set(currentItem.id, { ...currentItem, captionText: newCaption, captionSource: "bulk", version: currentItem.version + 1 });
    revisions.push({ itemId: currentItem.id, previousText: currentItem.captionText, newText: newCaption, source: "bulk", changedBy, changedAt: now });
    return { itemId: currentItem.id, outcome: "updated", reason: "Caption updated." };
  });

  return {
    ok: true, problems: [],
    items: items.map((i) => updatedItemsById.get(i.id) ?? i),
    results, revisions,
    summary: {
      updated: results.filter((r) => r.outcome === "updated").length,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      conflicts: results.filter((r) => r.outcome === "conflict").length,
      needsConfirmation: results.filter((r) => r.outcome === "needs_overwrite_confirmation").length,
    },
  };
}

/** Edit ONE item's caption. Marks it "individual" so later bulk edits ask before overwriting it. */
export function editSingleCaption(args: {
  item: CycleItem; newCaption: string; expectedVersion: number; changedBy: UserId; now: Date;
}): { ok: true; item: CycleItem; revision: CaptionRevision } | { ok: false; reason: string } {
  const { item, newCaption, expectedVersion, changedBy, now } = args;
  const validation = validateCaption(newCaption);
  if (!validation.valid) return { ok: false, reason: validation.problems.join(" ") };
  if (!isEditableItem(item)) return { ok: false, reason: explainWhyNotEditable(item) };
  if (item.version !== expectedVersion) return { ok: false, reason: "This item changed since you opened it. Reload and try again." };
  return {
    ok: true,
    item: { ...item, captionText: newCaption, captionSource: "individual", version: item.version + 1 },
    revision: { itemId: item.id, previousText: item.captionText, newText: newCaption, source: "individual", changedBy, changedAt: now },
  };
}

// ---------- Covers ----------
/** Whether the Instagram publishing path can accept a custom cover. UNVERIFIED: decided elsewhere once docs are checked. */
export type CoverSupport = "supported" | "unsupported" | "unknown";

const hasCustomCover = (item: CycleItem, newCoverMediaId: string): boolean =>
  item.coverIsCustom && item.coverMediaId !== null && item.coverMediaId !== newCoverMediaId;

export function previewBulkCoverUpdate(args: {
  items: CycleItem[]; target: UpdateTarget; newCoverMediaId: string; overwriteCustomConfirmed: boolean;
}): ItemResult[] {
  const { items, target, newCoverMediaId, overwriteCustomConfirmed } = args;
  const { targeted, unknownIds } = selectTargetItems(items, target);
  const results: ItemResult[] = unknownIds.map((id) => ({ itemId: id, outcome: "skipped", reason: "Not part of this cycle." }));
  for (const { item, skipReason } of targeted) {
    if (skipReason) results.push({ itemId: item.id, outcome: "skipped", reason: skipReason });
    else if (item.coverMediaId === newCoverMediaId) results.push({ itemId: item.id, outcome: "skipped", reason: "Already uses this cover." });
    else if (hasCustomCover(item, newCoverMediaId) && !overwriteCustomConfirmed) {
      results.push({ itemId: item.id, outcome: "needs_overwrite_confirmation", reason: "Has a custom cover. Confirm to replace it." });
    } else results.push({ itemId: item.id, outcome: "will_update", reason: "Will receive the new cover." });
  }
  return results;
}

export interface BulkCoverResult {
  ok: boolean;
  problems: string[];
  items: CycleItem[];
  results: ItemResult[];
  /** Shown to the user. Honest about whether Instagram will actually receive the cover. */
  warning: string | null;
  summary: { updated: number; skipped: number; conflicts: number; needsConfirmation: number };
}

/**
 * Save a chosen cover on upcoming items. The state becomes "saved_internally" - NEVER
 * "applied_on_instagram". Only the publisher may set the latter, after the platform accepted it.
 */
export function applyBulkCoverUpdate(args: {
  items: CycleItem[]; target: UpdateTarget; newCoverMediaId: string; overwriteCustomConfirmed: boolean;
  expectedVersions: Record<string, number>;
  /** Caller checks the user may use this image (own library or permitted shared media). */
  userMayUseCoverMedia: boolean;
  coverSupport: CoverSupport;
}): BulkCoverResult {
  const { items, target, newCoverMediaId, overwriteCustomConfirmed, expectedVersions, userMayUseCoverMedia, coverSupport } = args;
  const emptySummary = { updated: 0, skipped: 0, conflicts: 0, needsConfirmation: 0 };
  if (!userMayUseCoverMedia) {
    return { ok: false, problems: ["You do not have permission to use that image as a cover."], items, results: [], warning: null, summary: emptySummary };
  }

  const decisions = previewBulkCoverUpdate({ items, target, newCoverMediaId, overwriteCustomConfirmed });
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const updatedById = new Map<string, CycleItem>();

  const results = decisions.map((decision): ItemResult => {
    if (decision.outcome !== "will_update") return decision;
    const currentItem = itemsById.get(decision.itemId) as CycleItem;
    if (expectedVersions[currentItem.id] !== currentItem.version) {
      return { itemId: currentItem.id, outcome: "conflict", reason: "Changed since you opened it. Reload and try again." };
    }
    updatedById.set(currentItem.id, { ...currentItem, coverMediaId: newCoverMediaId, coverIsCustom: false, coverState: "saved_internally", version: currentItem.version + 1 });
    return { itemId: currentItem.id, outcome: "updated", reason: "Cover saved in ClipForge." };
  });

  const warning = coverSupport === "supported" ? null
    : coverSupport === "unsupported"
      ? "Saved in ClipForge, but Instagram does not accept custom covers for this publishing method. It will NOT be applied on Instagram."
      : "Saved in ClipForge. We could not confirm that Instagram will accept this cover; it is not guaranteed to appear.";

  return {
    ok: true, problems: [], items: items.map((i) => updatedById.get(i.id) ?? i), results, warning,
    summary: {
      updated: results.filter((r) => r.outcome === "updated").length,
      skipped: results.filter((r) => r.outcome === "skipped").length,
      conflicts: results.filter((r) => r.outcome === "conflict").length,
      needsConfirmation: results.filter((r) => r.outcome === "needs_overwrite_confirmation").length,
    },
  };
}
