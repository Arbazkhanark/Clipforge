import { isPlanId, type PlanId } from "./catalog.ts";
import { effectivePlanId, type SubscriptionStatus } from "./subscription-state.ts";

export interface PaidSubscriptionEntitlement {
  planId: string;
  status: SubscriptionStatus;
  trialEndsAt: number | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  hasCapturedPayment: boolean;
  hasFailedPayment: boolean;
}

export type DeferredAccessState = "ended" | "active" | "unresolved";

export interface PlanAccessPeriod {
  planId: string;
  startsAt: Date;
  expiresAt: Date;
}

export interface PromotionalPlanGrant extends PlanAccessPeriod {
  status: string;
  activationPolicy: string;
  activatedAt: Date | null;
  revokedAt: Date | null;
}

export interface ComplimentaryPlanGrant { planId: string; status: string }

export interface EffectiveEntitlementInput {
  now: Date;
  subscription?: PaidSubscriptionEntitlement | null;
  manualAccess?: readonly PlanAccessPeriod[];
  promotionalGrants?: readonly PromotionalPlanGrant[];
  complimentaryGrant?: ComplimentaryPlanGrant | null;
  deferredAccessState?: DeferredAccessState;
  /** Memory/demo repository compatibility for its pre-existing seeded plan fixtures. */
  legacyPlanId?: string | null;
}

export interface EffectiveEntitlement {
  planId: PlanId;
  source: "free" | "subscription_trial" | "recurring_subscription" | "manual_access" | "promotion" | "legacy_access" | "complimentary_access";
}

const PLAN_PRIORITY: Record<PlanId, number> = { free: 0, creator: 1, pro: 2, agency: 3 };

function validPlan(value: string): value is PlanId { return isPlanId(value); }
function activeInWindow(startsAt: Date, expiresAt: Date, now: Date): boolean {
  return startsAt instanceof Date && expiresAt instanceof Date && Number.isFinite(startsAt.getTime()) && Number.isFinite(expiresAt.getTime()) && startsAt.getTime() <= now.getTime() && now.getTime() < expiresAt.getTime();
}

/**
 * Prior to promotional access, effectivePlanId granted recurring access for active/pending
 * subscriptions and authenticated trials until their trial end. It did not require a payment
 * row or currentPeriodEnd. Unknown/nonterminal provider states are unresolved for deferred
 * promotions and must not be treated as proof that paid access ended.
 */
export function resolveDeferredAccessState(input: Pick<EffectiveEntitlementInput, "now" | "subscription" | "manualAccess" | "legacyPlanId">): DeferredAccessState {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return "unresolved";
  for (const access of input.manualAccess ?? []) {
    if (!(access.startsAt instanceof Date) || !(access.expiresAt instanceof Date) || !Number.isFinite(access.startsAt.getTime()) || !Number.isFinite(access.expiresAt.getTime()) || access.expiresAt <= access.startsAt) return "unresolved";
    if (activeInWindow(access.startsAt, access.expiresAt, input.now)) return "active";
    if (access.startsAt > input.now) return "unresolved";
  }
  if (input.legacyPlanId && validPlan(input.legacyPlanId) && input.legacyPlanId !== "free") return "unresolved";
  const subscription = input.subscription;
  if (!subscription) return "ended";
  if (!validPlan(subscription.planId) || subscription.planId === "free") return "unresolved";
  if (subscription.status === "active" || subscription.status === "pending") return "active";
  if (subscription.status === "authenticated") {
    if (typeof subscription.trialEndsAt !== "number" || !Number.isFinite(subscription.trialEndsAt)) return "unresolved";
    // An elapsed authentication trial can still be followed by a provider activation event.
    return subscription.trialEndsAt * 1000 > nowMs ? "active" : "unresolved";
  }
  if (subscription.status === "cancelled" || subscription.status === "completed" || subscription.status === "expired") return "ended";
  return "unresolved";
}

/** Resolves access only from authoritative stored access periods and the shared plan catalog IDs. */
export function resolveEffectiveEntitlement(input: EffectiveEntitlementInput): EffectiveEntitlement {
  const candidates: EffectiveEntitlement[] = [{ planId: "free", source: "free" }];
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return candidates[0]!;
  const subscription = input.subscription;
  if (subscription && validPlan(subscription.planId) && subscription.planId !== "free") {
    const statePlan = effectivePlanId({
      planId: subscription.planId,
      interval: "weekly",
      status: subscription.status,
      lastEventAt: 0,
      processedEventIds: [],
      trialEndsAt: subscription.trialEndsAt,
    }, Math.floor(input.now.getTime() / 1000));
    if (subscription.status === "authenticated" && statePlan !== "free") candidates.push({ planId: statePlan, source: "subscription_trial" });
    // Preserve the pre-promotion effectivePlanId semantics: active/pending are entitled
    // independently of PaymentRecord/currentPeriodEnd; authenticated trials use their end time.
    else if (subscription.status === "active" || subscription.status === "pending") {
      candidates.push({ planId: subscription.planId, source: "recurring_subscription" });
    }
  }
  if (input.legacyPlanId && validPlan(input.legacyPlanId) && input.legacyPlanId !== "free") candidates.push({ planId: input.legacyPlanId, source: "legacy_access" });
  if (input.complimentaryGrant?.status === "ACTIVE" && validPlan(input.complimentaryGrant.planId) && input.complimentaryGrant.planId !== "free") candidates.push({ planId: input.complimentaryGrant.planId, source: "complimentary_access" });
  for (const access of input.manualAccess ?? []) {
    if (validPlan(access.planId) && access.planId !== "free" && activeInWindow(access.startsAt, access.expiresAt, input.now)) candidates.push({ planId: access.planId, source: "manual_access" });
  }
  for (const grant of input.promotionalGrants ?? []) {
    const validActivation = grant.activationPolicy === "immediate" || grant.activationPolicy === "after_current_access";
    const activationTimestampValid = grant.activatedAt instanceof Date && Number.isFinite(grant.activatedAt.getTime()) && grant.startsAt instanceof Date && Number.isFinite(grant.startsAt.getTime()) && grant.activatedAt.getTime() === grant.startsAt.getTime();
    const notRevoked = grant.revokedAt === null;
    const deferredReady = grant.activationPolicy !== "after_current_access" || input.deferredAccessState === "ended";
    if (grant.status === "active" && validActivation && activationTimestampValid && notRevoked && deferredReady && validPlan(grant.planId) && grant.planId !== "free" && activeInWindow(grant.startsAt, grant.expiresAt, input.now)) candidates.push({ planId: grant.planId, source: "promotion" });
  }
  return candidates.reduce((best, candidate) => PLAN_PRIORITY[candidate.planId] > PLAN_PRIORITY[best.planId] ? candidate : best);
}
