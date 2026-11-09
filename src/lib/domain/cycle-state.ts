// Publishing-cycle and cycle-item state rules, including locking and in-flight safety.
// Pure functions. The database layer must apply results with a compare-and-set UPDATE
// (WHERE id = ? AND version = ?) so two workers can never both win.
import type { CycleItem, CycleItemStatus, CycleStatus, PublishingCycle } from "./types.ts";

// ---------- Item status transitions ----------
const ALLOWED_ITEM_TRANSITIONS: Record<CycleItemStatus, CycleItemStatus[]> = {
  upcoming: ["scheduled", "processing", "publishing", "cancelled"],
  scheduled: ["upcoming", "processing", "publishing", "cancelled"],
  processing: ["scheduled", "publishing", "failed", "needs_review"],
  publishing: ["published", "failed", "needs_review"],
  needs_review: ["upcoming", "published", "failed", "cancelled"],
  failed: ["upcoming", "cancelled"],
  published: [],  // history is never rewritten
  cancelled: [],
};

export function canItemTransition(from: CycleItemStatus, to: CycleItemStatus): boolean {
  return ALLOWED_ITEM_TRANSITIONS[from].includes(to);
}

/** Items the user may still edit/reorder/remove: nothing has been sent anywhere yet. */
export const EDITABLE_ITEM_STATUSES: CycleItemStatus[] = ["upcoming", "scheduled"];
/** Items a worker is actively touching right now. They must never be changed by the UI. */
export const IN_FLIGHT_ITEM_STATUSES: CycleItemStatus[] = ["processing", "publishing"];
/** Items that will never change again. */
export const FINISHED_ITEM_STATUSES: CycleItemStatus[] = ["published", "cancelled"];

export const isEditableItem = (item: CycleItem): boolean => EDITABLE_ITEM_STATUSES.includes(item.status);
export const isInFlightItem = (item: CycleItem): boolean => IN_FLIGHT_ITEM_STATUSES.includes(item.status);

/** Return a changed copy of an item, with the version bumped. Throws if the move is not allowed. */
export function moveItemToStatus(item: CycleItem, newStatus: CycleItemStatus, changes: Partial<CycleItem> = {}): CycleItem {
  if (!canItemTransition(item.status, newStatus)) {
    throw new Error(`Cannot move a cycle item from "${item.status}" to "${newStatus}".`);
  }
  return { ...item, ...changes, status: newStatus, version: item.version + 1 };
}

// ---------- Cycle status transitions ----------
const ALLOWED_CYCLE_TRANSITIONS: Record<CycleStatus, CycleStatus[]> = {
  draft: ["running", "stopped"],
  running: ["paused", "stopped", "completed"],
  paused: ["running", "stopped"],
  stopped: [],
  completed: [],
};

export function canCycleTransition(from: CycleStatus, to: CycleStatus): boolean {
  return ALLOWED_CYCLE_TRANSITIONS[from].includes(to);
}

export type CycleChangeResult =
  | { ok: true; cycle: PublishingCycle; inFlightItemIds: string[]; cancelledItemIds: string[] }
  | { ok: false; reason: string };

/** Start needs the final review screen to be confirmed and at least one item to publish. */
export function startCycle(cycle: PublishingCycle, items: CycleItem[]): CycleChangeResult {
  if (!canCycleTransition(cycle.status, "running") || cycle.status !== "draft") {
    return { ok: false, reason: `A cycle that is "${cycle.status}" cannot be started.` };
  }
  if (!cycle.finalReviewConfirmed) return { ok: false, reason: "Please confirm the final review before starting." };
  if (!items.some(isEditableItem)) return { ok: false, reason: "Add at least one video before starting." };
  return { ok: true, cycle: { ...cycle, status: "running" }, inFlightItemIds: [], cancelledItemIds: [] };
}

/** Pause stops NEW claims. Items already processing/publishing continue; we report them honestly. */
export function pauseCycle(cycle: PublishingCycle, items: CycleItem[]): CycleChangeResult {
  if (!canCycleTransition(cycle.status, "paused")) return { ok: false, reason: `A cycle that is "${cycle.status}" cannot be paused.` };
  return { ok: true, cycle: { ...cycle, status: "paused" }, inFlightItemIds: items.filter(isInFlightItem).map((i) => i.id), cancelledItemIds: [] };
}

export function resumeCycle(cycle: PublishingCycle): CycleChangeResult {
  if (cycle.status !== "paused") return { ok: false, reason: "Only a paused cycle can be resumed." };
  return { ok: true, cycle: { ...cycle, status: "running" }, inFlightItemIds: [], cancelledItemIds: [] };
}

/**
 * Stop cancels upcoming/scheduled items only. Published history is kept. Items already
 * processing/publishing are NOT cancelled: an accepted external publish cannot be recalled.
 */
export function stopCycle(cycle: PublishingCycle, items: CycleItem[]): CycleChangeResult {
  if (!canCycleTransition(cycle.status, "stopped")) return { ok: false, reason: `A cycle that is "${cycle.status}" cannot be stopped.` };
  return {
    ok: true,
    cycle: { ...cycle, status: "stopped" },
    inFlightItemIds: items.filter(isInFlightItem).map((i) => i.id),
    cancelledItemIds: items.filter(isEditableItem).map((i) => i.id),
  };
}

/** A running cycle is complete when nothing is left that could still publish. */
export function isCycleFinished(items: CycleItem[]): boolean {
  return items.length > 0 && items.every((i) => ["published", "cancelled", "failed"].includes(i.status));
}

// ---------- Claiming an item for publishing (the lock) ----------
export type ClaimResult =
  | { claimed: true; item: CycleItem }
  | { claimed: false; reason: string };

/**
 * A worker asks to publish one item. Succeeds only if:
 *  - the cycle is running (so Pause really stops new work),
 *  - the item is upcoming/scheduled and due,
 *  - the item's version is exactly what the worker last saw (nobody edited it meanwhile).
 * `expectedVersion` is the optimistic-lock check: if a user edited the caption a moment ago,
 * the version changed and the worker must reload the item and decide again.
 */
export function claimItemForPublishing(
  cycle: PublishingCycle, item: CycleItem, expectedVersion: number,
  workerId: string, now: Date, leaseSeconds: number,
): ClaimResult {
  if (cycle.status !== "running") return { claimed: false, reason: "The cycle is not running." };
  if (!isEditableItem(item)) return { claimed: false, reason: `Item is "${item.status}" and cannot be claimed.` };
  if (item.scheduledFor !== null && item.scheduledFor > now) return { claimed: false, reason: "Item is not due yet." };
  if (item.version !== expectedVersion) return { claimed: false, reason: "Item changed since it was read; reload and retry." };
  if (item.lockedBy !== null && item.lockExpiresAt !== null && item.lockExpiresAt > now) {
    return { claimed: false, reason: "Item is locked by another worker." };
  }
  const lockExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);
  return { claimed: true, item: moveItemToStatus(item, "publishing", { lockedBy: workerId, lockExpiresAt }) };
}

/** What happened when we called the platform. "ambiguous" = timeout / unknown result. */
export type PublishOutcome = "success" | "definite_failure" | "ambiguous";

/**
 * Record the result. Ambiguous results go to needs_review and are NEVER auto-retried,
 * because retrying could publish the same video twice.
 */
export function recordPublishOutcome(item: CycleItem, workerId: string, outcome: PublishOutcome): CycleItem {
  if (item.status !== "publishing") throw new Error("Only an item that is being published can receive a result.");
  if (item.lockedBy !== workerId) throw new Error("This item is locked by a different worker.");
  const unlocked = { lockedBy: null, lockExpiresAt: null };
  if (outcome === "success") return moveItemToStatus(item, "published", { ...unlocked, reviewReason: null });
  if (outcome === "definite_failure") return moveItemToStatus(item, "failed", unlocked);
  return moveItemToStatus(item, "needs_review", { ...unlocked, reviewReason: "ambiguous_publish_result" });
}

/**
 * Restart recovery. Call when a worker/scheduler starts.
 *  - Stale "processing" (rendering) items are safe to redo -> back to upcoming.
 *  - Stale "publishing" items might already be live on the platform -> needs_review (never auto-retry).
 */
export function recoverStaleLocks(items: CycleItem[], now: Date): CycleItem[] {
  return items.map((item) => {
    const lockIsStale = item.lockExpiresAt !== null && item.lockExpiresAt <= now;
    if (!lockIsStale) return item;
    const unlocked = { lockedBy: null, lockExpiresAt: null };
    if (item.status === "processing") return moveItemToStatus(item, "scheduled", unlocked);
    if (item.status === "publishing") return moveItemToStatus(item, "needs_review", { ...unlocked, reviewReason: "worker_lost_during_publish" });
    return item;
  });
}

/** Stable key sent with each publish attempt so a retry cannot create a second post. */
export function buildPublishIdempotencyKey(item: Pick<CycleItem, "cycleId" | "id">, attemptNumber = 1): string {
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) throw new Error("Publishing attempt number must be a positive integer.");
  return `publish:${item.cycleId}:${item.id}:${attemptNumber}`;
}
