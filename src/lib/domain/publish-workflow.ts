// Decisions a publisher must make before it calls Instagram.
// Nothing here contacts Meta. Limits that come from Meta are named in instagram-capabilities.ts.
// The pause-after-repeated-failures number is a ClipForge rule, not a Meta quota.
import { isCycleFinished, isEditableItem } from "./cycle-state.ts";
import type { CycleItem, CycleStatus, PublishingCycle } from "./types.ts";

/** After this many definite failures in a row, ClipForge pauses new claims. Not an Instagram limit. */
export const REPEATED_DEFINITE_FAILURES_BEFORE_PAUSE = 3;

export type PublishAttemptOutcome = "in_progress" | "success" | "definite_failure" | "ambiguous";
export type PublishAttemptDecision = "publish" | "skip_published" | "verify_before_retry" | "skip_in_progress" | "skip_not_claimable";
export type RepeatBehavior = "never" | "ask" | "automatic";
export type SettledCycleDecision = "keep_running" | "complete" | "ask_before_repeat" | "repeat_without_published_items";

/** Due items for one account, oldest scheduled time first, then queue position, then id. */
export function orderDueItems(items: CycleItem[], now: Date): CycleItem[] {
  return items.filter((item) => isEditableItem(item) && (item.scheduledFor === null || item.scheduledFor <= now))
    .sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0) || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether a worker may call the publish API.
 * A success, an ambiguous result, or an in-progress attempt blocks another upload.
 */
export function decidePublishAttempt(item: CycleItem, attempts: { outcome: PublishAttemptOutcome }[]): PublishAttemptDecision {
  if (item.status === "published" || attempts.some((attempt) => attempt.outcome === "success")) return "skip_published";
  if (item.status === "needs_review" || item.reviewReason === "ambiguous_publish_result" || item.reviewReason === "worker_lost_during_publish" || attempts.some((attempt) => attempt.outcome === "ambiguous")) return "verify_before_retry";
  if (item.status === "publishing" || item.status === "processing" || attempts.some((attempt) => attempt.outcome === "in_progress")) return "skip_in_progress";
  if (!isEditableItem(item)) return "skip_not_claimable";
  return "publish";
}

export function shouldPauseForAccount(input: { status: "connected" | "token_expired" | "revoked" | "disconnected"; consecutiveDefiniteFailures: number }): { pause: boolean; reason: string | null } {
  if (input.status === "token_expired") return { pause: true, reason: "The Instagram token has expired. Reconnect the account before publishing continues." };
  if (input.status === "revoked") return { pause: true, reason: "Instagram permissions were revoked. Reconnect the account before publishing continues." };
  if (input.status === "disconnected") return { pause: true, reason: "The Instagram account is disconnected." };
  if (input.consecutiveDefiniteFailures >= REPEATED_DEFINITE_FAILURES_BEFORE_PAUSE) {
    return { pause: true, reason: `Publishing paused after ${input.consecutiveDefiniteFailures} definite failures in a row. This pause is a ClipForge rule, not an Instagram quota.` };
  }
  return { pause: false, reason: null };
}

export function decideSettledCycle(cycle: Pick<PublishingCycle, "status">, items: CycleItem[], repeat: RepeatBehavior): SettledCycleDecision {
  if (cycle.status !== "running" || !isCycleFinished(items)) return "keep_running";
  if (repeat === "automatic") return "repeat_without_published_items";
  if (repeat === "ask") return "ask_before_repeat";
  return "complete";
}

/** Items that may be copied into another round. Published items are never included. */
export function itemsEligibleForRepeat(items: CycleItem[]): CycleItem[] {
  return items.filter((item) => item.status !== "published" && item.status !== "publishing" && item.status !== "processing");
}

export function canCycleStayRunning(status: CycleStatus): boolean {
  return status === "running";
}

/** Newest completed job first. In-progress rows are skipped. A success or an ambiguous result ends the streak. */
export function consecutiveDefiniteFailures(jobs: { outcome: PublishAttemptOutcome; startedAt: Date }[]): number {
  const ordered = [...jobs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  let count = 0;
  for (const job of ordered) {
    if (job.outcome === "in_progress") continue;
    if (job.outcome !== "definite_failure") break;
    count += 1;
  }
  return count;
}
