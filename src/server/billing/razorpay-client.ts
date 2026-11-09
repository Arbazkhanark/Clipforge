import { randomUUID } from "node:crypto";
import { getPricePaise, isBillingInterval, isPlanId, type BillingInterval, type PlanId } from "../../lib/billing/catalog.ts";
import { verifyOrderPaymentSignature, verifySubscriptionPaymentSignature } from "../../lib/billing/razorpay-signature.ts";

const API_ORIGIN = "https://api.razorpay.com/v1";
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface RazorpayTestConfig {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  subscriptionPlanIds: Partial<Record<PlanId, Partial<Record<BillingInterval, string>>>>;
  subscriptionTotalCount?: number;
  cancellationAtCycleEnd?: boolean;
}

export function readRazorpayTestConfig(env: NodeJS.ProcessEnv = process.env): RazorpayTestConfig | null {
  const keyId = env["RAZORPAY_KEY_ID"]?.trim() ?? "";
  const keySecret = env["RAZORPAY_KEY_SECRET"]?.trim() ?? "";
  // Live credentials are categorically rejected in this implementation sprint.
  if (!keyId.startsWith("rzp_test_") || keySecret.length < 8) return null;
  const subscriptionPlanIds: RazorpayTestConfig["subscriptionPlanIds"] = {};
  for (const planId of ["creator", "pro", "agency"] as const) {
    const weekly = env[`RAZORPAY_PLAN_${planId.toUpperCase()}_WEEKLY`]?.trim();
    const monthly = env[`RAZORPAY_PLAN_${planId.toUpperCase()}_MONTHLY`]?.trim();
    subscriptionPlanIds[planId] = {
      ...(weekly && SAFE_ID.test(weekly) ? { weekly } : {}),
      ...(monthly && SAFE_ID.test(monthly) ? { monthly } : {}),
    };
  }
  const countText = env["RAZORPAY_SUBSCRIPTION_TOTAL_COUNT"]?.trim();
  const count = countText ? Number(countText) : undefined;
  return {
    keyId,
    keySecret,
    ...(env["RAZORPAY_WEBHOOK_SECRET"] ? { webhookSecret: env["RAZORPAY_WEBHOOK_SECRET"] } : {}),
    subscriptionPlanIds,
    cancellationAtCycleEnd: env["RAZORPAY_CANCEL_AT_CYCLE_END"] !== "false",
    ...(count && Number.isSafeInteger(count) && count > 0 ? { subscriptionTotalCount: count } : {}),
  };
}

export interface RazorpayOrder { id: string; amount: number; currency: string; status: string; notes?: Record<string, string>; }
export interface RazorpaySubscription { id: string; plan_id: string; status: string; short_url?: string; current_end?: number | null; current_start?: number | null; start_at?: number | null; cancel_at_cycle_end?: boolean; total_count?: number; paid_count?: number; remaining_count?: number; }
export interface RazorpayPaymentLink { id: string; short_url: string; amount: number; currency: string; status: string; amount_paid?: number; reference_id?: string; payments?: { payment_id?: string; amount?: number; status?: string }[]; }
export type RazorpayResult<T> = { ok: true; value: T } | { ok: false; reason: "not_configured" | "invalid_request" | "provider_error" | "invalid_provider_response" };

/** Fixed-origin, test-credential-only API client. All requests can be replaced with an offline fake in tests. */
export class RazorpayTestClient {
  constructor(
    private readonly config: RazorpayTestConfig | null,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly newId: () => string = randomUUID,
  ) {}

  async createOrder(input: { ownerId: string; planId: string; interval: string }): Promise<RazorpayResult<RazorpayOrder>> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    if (!SAFE_ID.test(input.ownerId) || !isPlanId(input.planId) || input.planId === "free" || !isBillingInterval(input.interval)) return { ok: false, reason: "invalid_request" };
    const receipt = `cf_${this.newId()}`.slice(0, 40);
    const amount = getPricePaise(input.planId, input.interval);
    const response = await this.request("/orders", {
      amount,
      currency: "INR",
      receipt,
      notes: { owner_id: input.ownerId, plan_id: input.planId, interval: input.interval },
    });
    if (!response.ok) return response;
    const order = response.value as Partial<RazorpayOrder>;
    if (typeof order.id !== "string" || order.amount !== amount || order.currency !== "INR" || typeof order.status !== "string") return { ok: false, reason: "invalid_provider_response" };
    return { ok: true, value: order as RazorpayOrder };
  }

  async createManualPaymentLink(input: { ownerId: string; intentId: string; planId: string; interval: string; amountPaise: number }): Promise<RazorpayResult<RazorpayPaymentLink>> {
    if (!this.config || !SAFE_ID.test(input.ownerId) || !SAFE_ID.test(input.intentId) || !isPlanId(input.planId) || input.planId === "free" || !isBillingInterval(input.interval)) return { ok: false, reason: "invalid_request" };
    const catalogPrice = getPricePaise(input.planId, input.interval);
    // Full-price checkout still supplies the catalog amount. Discounted checkout may supply
    // a lower amount only from the durable server-validated intent snapshot.
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 1 || input.amountPaise > catalogPrice) return { ok: false, reason: "invalid_request" };
    const response = await this.request("/payment_links", { amount: input.amountPaise, currency: "INR", accept_partial: false, reference_id: input.intentId, description: `ClipForge ${input.planId} ${input.interval} access (one-time, no auto-renewal)`, notify: { sms: false, email: false }, notes: { clipforge_owner: input.ownerId, clipforge_intent: input.intentId, clipforge_plan: input.planId, clipforge_interval: input.interval, billing_mode: "manual" } });
    if (!response.ok) return response;
    const link = response.value as Partial<RazorpayPaymentLink>;
    return typeof link.id === "string" && link.amount === input.amountPaise && link.currency === "INR" && typeof link.short_url === "string" && typeof link.status === "string" && link.reference_id === input.intentId
      ? { ok: true, value: link as RazorpayPaymentLink } : { ok: false, reason: "invalid_provider_response" };
  }

  async verifyManualPayment(input: { intentId: string; paymentLinkId: string; paymentId: string; amountPaise: number }): Promise<{ paymentId: string; paymentLinkId: string; amount: number; currency: "INR"; status: "captured"; paidAt: Date } | null> {
    if (!this.config || !SAFE_ID.test(input.intentId) || !SAFE_ID.test(input.paymentLinkId) || !SAFE_ID.test(input.paymentId)) return null;
    const [linkResponse, paymentResponse] = await Promise.all([this.request(`/payment_links/${encodeURIComponent(input.paymentLinkId)}`), this.request(`/payments/${encodeURIComponent(input.paymentId)}`)]);
    if (!linkResponse.ok || !paymentResponse.ok) return null;
    const link = linkResponse.value as Partial<RazorpayPaymentLink>;
    const payment = paymentResponse.value as { id?: unknown; amount?: unknown; currency?: unknown; status?: unknown; captured?: unknown; created_at?: unknown };
    const linkPayment = Array.isArray(link.payments) ? link.payments.find((p) => p.payment_id === input.paymentId) : undefined;
    if (link.id !== input.paymentLinkId || link.reference_id !== input.intentId || link.amount !== input.amountPaise || link.amount_paid !== input.amountPaise || link.currency !== "INR" || link.status !== "paid" || !linkPayment || linkPayment.status !== "captured" || linkPayment.amount !== input.amountPaise || payment.id !== input.paymentId || payment.amount !== input.amountPaise || payment.currency !== "INR" || (payment.status !== "captured" && payment.captured !== true) || typeof payment.created_at !== "number" || !Number.isSafeInteger(payment.created_at)) return null;
    return { paymentId: input.paymentId, paymentLinkId: input.paymentLinkId, amount: input.amountPaise, currency: "INR", status: "captured", paidAt: new Date(payment.created_at * 1000) };
  }

  async verifyManualPaymentLink(input: { intentId: string; paymentLinkId: string; amountPaise: number }): Promise<{ paymentId: string; paymentLinkId: string; amount: number; currency: "INR"; status: "captured"; paidAt: Date } | null> {
    if (!this.config || !SAFE_ID.test(input.intentId) || !SAFE_ID.test(input.paymentLinkId)) return null;
    const response = await this.request(`/payment_links/${encodeURIComponent(input.paymentLinkId)}`);
    if (!response.ok) return null;
    const link = response.value as Partial<RazorpayPaymentLink>;
    if (link.id !== input.paymentLinkId || link.reference_id !== input.intentId || link.amount !== input.amountPaise || link.amount_paid !== input.amountPaise || link.currency !== "INR" || link.status !== "paid" || !Array.isArray(link.payments)) return null;
    const captured = link.payments.find((p) => p.status === "captured" && p.amount === input.amountPaise && typeof p.payment_id === "string");
    if (!captured?.payment_id) return null;
    return this.verifyManualPayment({ ...input, paymentId: captured.payment_id });
  }

  async createSubscription(input: { ownerId: string; planId: string; interval: string }): Promise<RazorpayResult<RazorpaySubscription>> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    if (!SAFE_ID.test(input.ownerId) || !isPlanId(input.planId) || input.planId === "free" || !isBillingInterval(input.interval) || !this.config.subscriptionTotalCount) return { ok: false, reason: "invalid_request" };
    const planId = this.config.subscriptionPlanIds[input.planId]?.[input.interval];
    if (!planId || !SAFE_ID.test(planId)) return { ok: false, reason: "not_configured" };
    const planResponse = await this.request(`/plans/${encodeURIComponent(planId)}`);
    if (!planResponse.ok) return planResponse;
    const plan = planResponse.value as { id?: unknown; period?: unknown; interval?: unknown; item?: { amount?: unknown; currency?: unknown } };
    const expectedPeriod = input.interval === "weekly" ? "weekly" : "monthly";
    if (plan.id !== planId || plan.period !== expectedPeriod || plan.interval !== 1 || plan.item?.amount !== getPricePaise(input.planId, input.interval) || plan.item?.currency !== "INR") return { ok: false, reason: "invalid_provider_response" };
    // The plan ID is a server configuration value, never accepted from a browser request.
    const response = await this.request("/subscriptions", {
      plan_id: planId,
      total_count: this.config.subscriptionTotalCount,
      quantity: 1,
      customer_notify: true,
      notes: { clipforge_owner: input.ownerId, clipforge_plan: input.planId, clipforge_interval: input.interval },
    });
    if (!response.ok) return response;
    const subscription = response.value as Partial<RazorpaySubscription>;
    if (typeof subscription.id !== "string" || subscription.plan_id !== planId || typeof subscription.status !== "string") return { ok: false, reason: "invalid_provider_response" };
    return { ok: true, value: subscription as RazorpaySubscription };
  }

  /** Client callback data is only accepted after the signature and provider's captured payment are verified. */
  async verifyOrderPayment(input: { ownerId: string; orderId: string; paymentId: string; signature: string; planId: string; interval: string }): Promise<RazorpayResult<{ paymentId: string; orderId: string; amount: number; currency: "INR" }>> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    if (!SAFE_ID.test(input.ownerId) || !SAFE_ID.test(input.orderId) || !SAFE_ID.test(input.paymentId) || !isPlanId(input.planId) || !isBillingInterval(input.interval) || input.planId === "free") return { ok: false, reason: "invalid_request" };
    if (!verifyOrderPaymentSignature({ orderId: input.orderId, paymentId: input.paymentId, signature: input.signature }, this.config.keySecret)) return { ok: false, reason: "invalid_request" };
    const [orderResponse, paymentResponse] = await Promise.all([
      this.request(`/orders/${encodeURIComponent(input.orderId)}`),
      this.request(`/payments/${encodeURIComponent(input.paymentId)}`),
    ]);
    if (!orderResponse.ok || !paymentResponse.ok) return { ok: false, reason: "provider_error" };
    const order = orderResponse.value as Partial<RazorpayOrder>;
    const payment = paymentResponse.value as { id?: unknown; order_id?: unknown; amount?: unknown; currency?: unknown; status?: unknown; captured?: unknown };
    const expectedAmount = getPricePaise(input.planId, input.interval);
    const notes = order.notes;
    if (order.id !== input.orderId || order.amount !== expectedAmount || order.currency !== "INR" || notes?.owner_id !== input.ownerId || notes?.plan_id !== input.planId || notes?.interval !== input.interval ||
        payment.id !== input.paymentId || payment.order_id !== input.orderId || payment.amount !== expectedAmount || payment.currency !== "INR" || (payment.status !== "captured" && payment.captured !== true)) return { ok: false, reason: "invalid_provider_response" };
    return { ok: true, value: { paymentId: input.paymentId, orderId: input.orderId, amount: expectedAmount, currency: "INR" } };
  }

  async verifySubscriptionPayment(input: { paymentId: string; subscriptionId: string; signature: string; amountPaise: number }): Promise<boolean> {
    if (!this.config || !SAFE_ID.test(input.paymentId) || !SAFE_ID.test(input.subscriptionId) || !Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) return false;
    if (!verifySubscriptionPaymentSignature(input, this.config.keySecret)) return false;
    const payment = await this.request(`/payments/${encodeURIComponent(input.paymentId)}`);
    if (!payment.ok) return false;
    const row = payment.value as { id?: unknown; subscription_id?: unknown; status?: unknown; captured?: unknown; amount?: unknown; currency?: unknown };
    return row.id === input.paymentId && row.subscription_id === input.subscriptionId && row.amount === input.amountPaise && row.currency === "INR" && (row.status === "captured" || row.captured === true);
  }

  async cancelSubscription(subscriptionId: string, cancelAtCycleEnd: boolean): Promise<RazorpayResult<RazorpaySubscription>> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    if (!SAFE_ID.test(subscriptionId)) return { ok: false, reason: "invalid_request" };
    const response = await this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, { cancel_at_cycle_end: cancelAtCycleEnd });
    if (!response.ok) return response;
    const row = response.value as Partial<RazorpaySubscription>;
    return typeof row.id === "string" && row.id === subscriptionId && typeof row.status === "string" && typeof row.plan_id === "string" && (row.current_end === undefined || row.current_end === null || (typeof row.current_end === "number" && Number.isSafeInteger(row.current_end)))
      ? { ok: true, value: row as RazorpaySubscription }
      : { ok: false, reason: "invalid_provider_response" };
  }

  async fetchSubscription(subscriptionId: string): Promise<RazorpayResult<RazorpaySubscription>> {
    if (!this.config || !SAFE_ID.test(subscriptionId)) return { ok: false, reason: this.config ? "invalid_request" : "not_configured" };
    const response = await this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    if (!response.ok) return response;
    const row = response.value as Partial<RazorpaySubscription>;
    return row.id === subscriptionId && typeof row.plan_id === "string" && typeof row.status === "string" && Number.isSafeInteger(row.total_count) && Number.isSafeInteger(row.paid_count) && Number.isSafeInteger(row.remaining_count) && typeof row.current_end === "number" && Number.isSafeInteger(row.current_end)
      ? { ok: true, value: row as RazorpaySubscription } : { ok: false, reason: "invalid_provider_response" };
  }

  /** Extends the existing subscription's cycle count; this never creates a second subscription. */
  async setSubscriptionRemainingCount(subscriptionId: string, remainingCount: number): Promise<RazorpayResult<RazorpaySubscription>> {
    if (!this.config || !SAFE_ID.test(subscriptionId) || !Number.isSafeInteger(remainingCount) || remainingCount < 1) return { ok: false, reason: this.config ? "invalid_request" : "not_configured" };
    const response = await this.request(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { remaining_count: remainingCount, schedule_change_at: "now", customer_notify: false }, "PATCH");
    if (!response.ok) return response;
    const row = response.value as Partial<RazorpaySubscription>;
    return row.id === subscriptionId && typeof row.plan_id === "string" && typeof row.status === "string" && row.remaining_count === remainingCount && (row.cancel_at_cycle_end === undefined || typeof row.cancel_at_cycle_end === "boolean")
      ? { ok: true, value: row as RazorpaySubscription } : { ok: false, reason: "invalid_provider_response" };
  }

  private async request(path: string, body?: Record<string, unknown>, method?: "POST" | "PATCH"): Promise<RazorpayResult<unknown>> {
    if (!this.config) return { ok: false, reason: "not_configured" };
    const authorization = Buffer.from(`${this.config.keyId}:${this.config.keySecret}`).toString("base64");
    let response: Response;
    try {
      response = await this.fetchImpl(`${API_ORIGIN}${path}`, {
        method: method ?? (body ? "POST" : "GET"),
        headers: { authorization: `Basic ${authorization}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
      });
    } catch { return { ok: false, reason: "provider_error" }; }
    if (!response.ok) return { ok: false, reason: "provider_error" };
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid_provider_response" };
      return { ok: true, value };
    } catch { return { ok: false, reason: "invalid_provider_response" }; }
  }
}
