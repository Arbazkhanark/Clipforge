// Subscription state machine mirroring Razorpay subscription statuses.
// Pure functions: no database. The webhook handler loads state, calls applySubscriptionEvent, saves result.
import { BILLING_INTERVALS, getPlan, type BillingInterval, type PlanId } from "./catalog.ts";

export type SubscriptionStatus =
  | "created" | "authenticated" | "active" | "pending" | "halted"
  | "paused" | "cancelled" | "completed" | "expired";

const ALLOWED_TRANSITIONS: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  created: ["authenticated", "active", "cancelled", "expired"],
  authenticated: ["active", "cancelled", "expired"],
  active: ["pending", "paused", "cancelled", "completed"],
  pending: ["active", "halted", "cancelled"],
  halted: ["active", "cancelled"],
  paused: ["active", "cancelled"],
  cancelled: [], completed: [], expired: [],
};

export const TERMINAL_STATUSES: SubscriptionStatus[] = ["cancelled", "completed", "expired"];
/** Only these statuses grant paid entitlements. Never a frontend redirect. */
export const ENTITLED_STATUSES: SubscriptionStatus[] = ["active", "pending"];

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface SubscriptionState {
  planId: PlanId;
  interval: BillingInterval;
  status: SubscriptionStatus;
  /** Unix seconds of the last applied event; used to ignore stale, out-of-order events. */
  lastEventAt: number;
  processedEventIds: string[];
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

export function hasPaidEntitlements(state: SubscriptionState): boolean {
  return ENTITLED_STATUSES.includes(state.status);
}

/** The plan whose limits apply right now (falls back to free if not entitled). */
export function effectivePlanId(state: SubscriptionState): PlanId {
  return hasPaidEntitlements(state) ? state.planId : "free";
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
