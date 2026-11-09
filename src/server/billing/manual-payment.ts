import { isBillingInterval, isPlanId, getPlan } from "../../lib/billing/catalog.ts";
import { checkSameOrigin } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { readRazorpayTestConfig, RazorpayTestClient } from "./razorpay-client.ts";
import { readSmallJson } from "./request-json.ts";

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const safeUrl = (s: string | undefined): string | null => { try { const u = new URL(s ?? ""); return u.protocol === "https:" && (u.hostname === "rzp.io" || u.hostname.endsWith(".razorpay.com")) ? u.toString() : null; } catch { return null; } };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });

export async function createManualPayment(request: Request, runtime: Runtime, clientOverride?: RazorpayTestClient, config = readRazorpayTestConfig()): Promise<Response> {
  if (checkSameOrigin(request)) return json({ error: "cross_site_request" }, 403);
  if (runtime.mode !== "database") return json({ error: "durable_billing_store_required" }, 503);
  const userId = await runtime.currentUserId(request); if (!userId) return json({ error: "unauthenticated" }, 401);
  const key = request.headers.get("idempotency-key")?.trim() ?? ""; if (!KEY.test(key)) return json({ error: "invalid_idempotency_key" }, 400);
  const parsed = await readSmallJson(request); if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : {};
  if (typeof body.planId !== "string" || !isPlanId(body.planId) || body.planId === "free" || typeof body.interval !== "string" || !isBillingInterval(body.interval)) return json({ error: "invalid_plan" }, 400);
  const amountPaise = getPlan(body.planId).pricePaise[body.interval]; if (!config || !config.webhookSecret) return json({ error: "checkout_not_configured" }, 503);
  const hasCoupon = Object.prototype.hasOwnProperty.call(body, "couponCode");
  if (hasCoupon && (typeof body.couponCode !== "string" || body.couponCode.trim().length === 0)) return json({ error: "invalid_coupon" }, 400);
  let intent: import("../repository.ts").ManualPaymentIntentRecord;
  let reservationStatus: "created" | "existing";
  let discountedReservation: import("../repository.ts").PromotionRedemptionRecord | null = null;
  if (hasCoupon) {
    const reserved = await runtime.repo.reserveDiscountedManualPaymentIntent({ id: runtime.newId(), userId, idempotencyKey: key, planId: body.planId, interval: body.interval, couponCode: body.couponCode as string, now: runtime.now() });
    if (reserved.status !== "created" && reserved.status !== "existing") return json({ error: reserved.status === "unavailable" ? "coupon_unavailable" : "billing_conflict_or_review_required" }, 409);
    intent = reserved.intent; reservationStatus = reserved.status;
    discountedReservation = reserved.redemption;
  } else {
    const reserved = await runtime.repo.reserveManualPaymentIntent({ id: runtime.newId(), userId, idempotencyKey: key, planId: body.planId, interval: body.interval, amountPaise, now: runtime.now() });
    if (!reserved.intent || reserved.status === "conflict") return json({ error: "billing_conflict_or_review_required" }, 409);
    intent = reserved.intent; reservationStatus = reserved.status;
  }
  const couponSummary = discountedReservation ? {
    redemptionId: discountedReservation.id, status: discountedReservation.status,
    listPricePaise: discountedReservation.listPricePaise, discountPaise: discountedReservation.discountPaise,
    payablePaise: discountedReservation.payablePaise, currency: discountedReservation.currency,
  } : null;
  if (reservationStatus === "existing") {
    if (intent.status === "created" && intent.checkoutUrl) return json({ intentId: intent.id, checkoutUrl: intent.checkoutUrl, status: "created", ...(couponSummary ? { coupon: couponSummary, paymentStatus: "pending" } : {}) });
    if (couponSummary) return json({ error: intent.status === "manual_review" ? "checkout_requires_review" : "checkout_in_progress", intentId: intent.id, paymentStatus: intent.status === "manual_review" ? "manual_review" : "pending", coupon: couponSummary }, 409);
    return json({ error: intent.status === "manual_review" ? "checkout_requires_review" : "checkout_in_progress" }, 409);
  }
  // The discounted amount comes only from the durable server-calculated intent snapshot.
  const providerAmountPaise = intent.amountPaise;
  const result = await (clientOverride ?? new RazorpayTestClient(config)).createManualPaymentLink({ ownerId: userId, intentId: intent.id, planId: intent.planId, interval: intent.interval, amountPaise: providerAmountPaise });
  const checkoutUrl = result.ok ? safeUrl(result.value.short_url) : null;
  if (!result.ok || !checkoutUrl) {
    await runtime.repo.finishManualPaymentIntent({ id: intent.id, userId, status: "manual_review", errorCategory: "provider_outcome_uncertain", now: runtime.now() });
    return json({ error: "checkout_requires_review", ...(couponSummary ? { intentId: intent.id, paymentStatus: "manual_review", coupon: couponSummary } : {}) }, 503);
  }
  const saved = await runtime.repo.finishManualPaymentIntent({ id: intent.id, userId, status: "created", providerPaymentLinkId: result.value.id, checkoutUrl, now: runtime.now() });
  return saved ? json({ intentId: intent.id, checkoutUrl, status: "created", autoRenew: false, ...(couponSummary ? { coupon: couponSummary, paymentStatus: "pending" } : {}) }, 201) : json({ error: "checkout_requires_review", ...(couponSummary ? { intentId: intent.id, paymentStatus: "manual_review", coupon: couponSummary } : {}) }, 503);
}

export async function verifyManualPayment(request: Request, runtime: Runtime, clientOverride?: RazorpayTestClient, config = readRazorpayTestConfig()): Promise<Response> {
  if (checkSameOrigin(request)) return json({ error: "cross_site_request" }, 403);
  if (runtime.mode !== "database") return json({ error: "durable_billing_store_required" }, 503);
  const userId = await runtime.currentUserId(request); if (!userId) return json({ error: "unauthenticated" }, 401);
  const parsed = await readSmallJson(request); if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value && typeof parsed.value === "object" ? parsed.value as Record<string, unknown> : {};
  if (typeof body.intentId !== "string" || typeof body.paymentId !== "string") return json({ error: "invalid_request" }, 400);
  const intent = await runtime.repo.getManualPaymentIntent(userId, body.intentId);
  // Even an already-paid intent goes through provider verification and the shared
  // settlement operation so retries validate the complete persisted settlement.
  if (!intent?.providerPaymentLinkId || (intent.status !== "created" && intent.status !== "paid")) return json({ error: "payment_intent_not_found" }, 404);
  const verified = await (clientOverride ?? new RazorpayTestClient(config)).verifyManualPayment({ intentId: intent.id, paymentLinkId: intent.providerPaymentLinkId, paymentId: body.paymentId, amountPaise: intent.amountPaise });
  if (!verified) return json({ error: "payment_not_verified" }, 400);
  const result = await runtime.repo.settleManualPayment({ userId, intentId: intent.id, providerPaymentLinkId: verified.paymentLinkId, providerPaymentId: verified.paymentId, amountPaise: verified.amount, currency: verified.currency, status: verified.status, paidAt: verified.paidAt, now: runtime.now() });
  if (result === "conflict") return json({ error: "billing_conflict" }, 409);
  if (result === "invalid") return json({ error: "payment_not_verified" }, 400);
  return json({ verified: result === "applied" || result === "duplicate", duplicate: result === "duplicate", autoRenew: false, status: result === "duplicate" ? "already_applied" : "paid" });
}
