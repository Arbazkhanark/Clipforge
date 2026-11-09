import { checkSameOrigin } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "./razorpay-client.ts";

export async function cancelOwnedSubscription(request: Request, runtime: Runtime, clientOverride?: RazorpayTestClient, config = readRazorpayTestConfig()): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (checkSameOrigin(request)) return json({ error: "cross_site_request" }, 403);
  if (runtime.mode !== "database") return json({ error: "durable_billing_store_required" }, 503);
  const userId = await runtime.currentUserId(request);
  if (!userId) return json({ error: "unauthenticated" }, 401);
  if (!config) return json({ error: "checkout_not_configured" }, 503);
  const cancelAtCycleEnd = config.cancellationAtCycleEnd ?? true;
  const local = await runtime.repo.getRazorpaySubscriptionForOwner(userId);
  if (!local?.razorpaySubscriptionId || !["active", "pending", "authenticated", "created", "halted"].includes(local.status)) return json({ error: "subscription_not_cancellable" }, 409);
  // Record intent before the provider call so the continuation runner cannot extend
  // the cycle count while cancellation is being processed or its result is uncertain.
  if (!await runtime.repo.requestRazorpayCancellation(userId, local.razorpaySubscriptionId, runtime.now())) return json({ error: "subscription_not_found" }, 404);
  const expectedPlan = config?.subscriptionPlanIds[local.planId]?.[local.interval];
  if (!config || !expectedPlan) return json({ error: "checkout_not_configured" }, 503);
  const client = clientOverride ?? new RazorpayTestClient(config);
  const cancelled = await client.cancelSubscription(local.razorpaySubscriptionId, cancelAtCycleEnd);
  if (!cancelled.ok || cancelled.value.id !== local.razorpaySubscriptionId || cancelled.value.plan_id !== expectedPlan) return json({ error: "cancellation_unconfirmed" }, 503);
  if (!cancelAtCycleEnd && cancelled.value.status !== "cancelled") return json({ error: "cancellation_unconfirmed" }, 503);
  const statuses = ["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"] as const;
  if (!(statuses as readonly string[]).includes(cancelled.value.status)) return json({ error: "cancellation_unconfirmed" }, 503);
  const periodEnd = typeof cancelled.value.current_end === "number" ? new Date(cancelled.value.current_end * 1000) : local.currentPeriodEnd;
  const confirmedCycleEnd = cancelAtCycleEnd && cancelled.value.status !== "cancelled";
  const ok = await runtime.repo.recordRazorpayCancellation(userId, local.razorpaySubscriptionId, confirmedCycleEnd, cancelled.value.status as typeof local.status, periodEnd, runtime.now());
  return ok ? json({ cancelled: true, cancelAtCycleEnd: confirmedCycleEnd, currentPeriodEnd: periodEnd?.toISOString() ?? null }) : json({ error: "subscription_not_found" }, 404);
}
