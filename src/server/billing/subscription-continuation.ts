import type { Repository, SubscriptionContinuationCandidate } from "../repository.ts";
import { RazorpayTestClient } from "./razorpay-client.ts";

const CONTINUE_WHEN_REMAINING = 10;
const MAX_CYCLES_100_YEARS = { weekly: 5_217, monthly: 1_200 } as const;

export type ContinuationResult = "not_due" | "extended" | "cancelled" | "already_handled" | "needs_manual_review";

/**
 * Extends the existing Razorpay subscription in place. Never creates a second provider
 * subscription, so two subscriptions cannot charge overlapping periods. The upper bound
 * is Razorpay's documented 100-year maximum; reaching it is surfaced for operator review.
 */
export async function continueSubscription(candidate: SubscriptionContinuationCandidate, repo: Repository, client: RazorpayTestClient, now: Date): Promise<ContinuationResult> {
  const snapshotResult = await client.fetchSubscription(candidate.providerSubscriptionId);
  if (!snapshotResult.ok) return "needs_manual_review";
  const snapshot = snapshotResult.value;
  if (snapshot.status !== "active" || snapshot.cancel_at_cycle_end === true || snapshot.current_end !== Math.floor(candidate.currentPeriodEnd.getTime() / 1000)) return "cancelled";
  const total = snapshot.total_count!;
  const paid = snapshot.paid_count!;
  const remaining = snapshot.remaining_count!;
  if (remaining > CONTINUE_WHEN_REMAINING) return "not_due";
  const maxCycles = MAX_CYCLES_100_YEARS[candidate.interval];
  const atDurationLimit = paid + remaining >= maxCycles;
  const targetRemaining = atDurationLimit ? remaining : maxCycles - paid;
  const attemptId = `cont_${candidate.id}_${candidate.currentPeriodEnd.getTime()}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const reserved = await repo.reserveSubscriptionContinuation({ id: attemptId, subscriptionId: candidate.id, providerSubscriptionId: candidate.providerSubscriptionId, cycleEnd: candidate.currentPeriodEnd, observedTotalCount: total, observedPaidCount: paid, observedRemainingCount: remaining, targetRemainingCount: targetRemaining, now });
  if (reserved === "cancelled") return "cancelled";
  if (reserved !== "reserved") return reserved === "not_due" ? "not_due" : "already_handled";
  if (atDurationLimit) {
    await repo.finishSubscriptionContinuation({ id: attemptId, status: "manual_review", errorCategory: "provider_duration_limit_reached", now });
    return "needs_manual_review";
  }

  // A provider timeout is ambiguous. The unique durable attempt prevents any blind retry.
  const result = await client.setSubscriptionRemainingCount(candidate.providerSubscriptionId, targetRemaining);
  if (!result.ok || result.value.status !== "active" || result.value.cancel_at_cycle_end === true) {
    await repo.finishSubscriptionContinuation({ id: attemptId, status: "manual_review", errorCategory: result.ok ? "provider_state_changed" : "provider_outcome_uncertain", now });
    return "needs_manual_review";
  }
  if (result.value.remaining_count !== targetRemaining) {
    await repo.finishSubscriptionContinuation({ id: attemptId, status: "manual_review", errorCategory: "provider_count_unconfirmed", now });
    return "needs_manual_review";
  }
  await repo.finishSubscriptionContinuation({ id: attemptId, status: "applied", now });
  return "extended";
}

export async function runSubscriptionContinuations(repo: Repository, client: RazorpayTestClient, now = new Date()): Promise<Record<ContinuationResult, number>> {
  const counts: Record<ContinuationResult, number> = { not_due: 0, extended: 0, cancelled: 0, already_handled: 0, needs_manual_review: 0 };
  for (const candidate of await repo.listSubscriptionContinuationCandidates(now)) {
    try { counts[await continueSubscription(candidate, repo, client, now)] += 1; }
    catch { counts.needs_manual_review += 1; }
  }
  return counts;
}
