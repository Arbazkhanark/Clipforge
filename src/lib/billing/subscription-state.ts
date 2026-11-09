// Subscription state machine mirroring Razorpay subscription statuses.
// Pure functions: no database. The webhook handler loads state, calls applySubscriptionEvent, saves result.
import { BILLING_INTERVALS, getPlan, type BillingInterval, type PlanId } from "./catalog.ts";

export type SubscriptionStatus =
  | "created" | "authenticated" | "active" | "pending" | "halted"
  | "paused" | "cancelled" | "completed" | "expired";

const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  created: ["authenticated", "active", "pending", "cancelled", "expired"],
  authenticated: ["active", "cancelled", "expired"],
  active: ["pending", "halted", "paused", "cancelled", "completed", "expired"],
  pending: ["active", "halted", "cancelled", "expired"],
  halted: ["active", "cancelled", "expired"],
  paused: ["active", "cancelled", "expired"],
  cancelled: [], completed: [], expired: [],
};

export const TERMINAL_STATUSES: SubscriptionStatus[] = ["cancelled", "completed", "expired"];
/** Only these statuses grant paid entitlements. Never a frontend redirect. */
export const ENTITLED_STATUSES: SubscriptionStatus[] = ["active", "pending"];

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Length of the free trial. Razorpay implements a trial with a FUTURE start_at (verified in its docs). */
export const TRIAL_DAYS = 7;

/** The start_at (unix seconds) to send to Razorpay: billing begins when the trial ends. */
export function trialStartAtUnix(nowUnix: number): number {
  return nowUnix + TRIAL_DAYS * 24 * 60 * 60;
}

/** Must be shown to the user BEFORE they authorise the subscription. */
export const TRIAL_DISCLOSURE =
  `Free for ${TRIAL_DAYS} days. To start, you authorise your payment method with a small authentication payment ` +
  `(Razorpay documents this as ₹5, refunded automatically). After the trial the plan price is charged every billing period ` +
  `until you cancel. You can cancel before the trial ends to avoid being charged.`;

export interface SubscriptionState {
  planId: PlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  /** Unix seconds of the last applied event; used to ignore stale, out-of-order events. */
  lastEventAt: number;
  processedEventIds: string[];
  /** Unix seconds when the free trial ends (the start_at we sent to Razorpay), or null/undefined if no trial. */
  trialEndsAt?: number | null;
}

export interface SubscriptionEvent { eventId: string; createdAt: number; newStatus: SubscriptionStatus; }

export type EventOutcome =
  | { applied: true; state: SubscriptionState }
  | { applied: false; state: SubscriptionState; reason: "duplicate" | "stale" | "invalid_transition" };

export function applySubscriptionEvent(state: SubscriptionState, event: SubscriptionEvent): EventOutcome {
  if (state.processedEventIds.includes(event.eventId)) return { applied: false, state, reason: "duplicate" };
  if (event.createdAt < state.lastEventAt) return { applied: false, state, reason: "stale" };
  if (event.newStatus === state.status) {
    // Same status, new event: record it so it is not reprocessed, but nothing changes.
    return { applied: true, state: { ...state, lastEventAt: event.createdAt, processedEventIds: [...state.processedEventIds, event.eventId] } };
  }
  if (!canTransition(state.status, event.newStatus)) return { applied: false, state, reason: "invalid_transition" };
  return {
    applied: true,
    state: { ...state, status: event.newStatus, lastEventAt: event.createdAt, processedEventIds: [...state.processedEventIds, event.eventId] },
  };
}

/**
 * Paid features are available when the subscription is active/pending, OR during a free trial:
 * the user authorised their payment method ("authenticated") and the trial end time has not passed.
 * Never based on a frontend redirect.
 */
export function hasPaidEntitlements(state: SubscriptionState, nowUnix?: number): boolean {
  if (ENTITLED_STATUSES.includes(state.status)) return true;
  return state.status === "authenticated" && nowUnix !== undefined && typeof state.trialEndsAt === "number" && nowUnix < state.trialEndsAt;
}

/** The plan whose limits apply right now (falls back to free if not entitled). */
export function effectivePlanId(state: SubscriptionState, nowUnix?: number): PlanId {
  return hasPaidEntitlements(state, nowUnix) ? state.planId : "free";
}

/** Changing plans NEVER changes the billing interval silently. */
export function planChangeRequest(state: SubscriptionState, newPlanId: string, requestedInterval?: string): { planId: PlanId; interval: BillingInterval } {
  const plan = getPlan(newPlanId);
  if (requestedInterval !== undefined && requestedInterval !== state.interval) {
    if (!(BILLING_INTERVALS as readonly string[]).includes(requestedInterval)) throw new Error(`Unsupported billing interval: "${requestedInterval}"`);
    throw new Error("Changing billing interval needs explicit user consent in a separate step.");
  }
  return { planId: plan.id, interval: state.interval };
}
